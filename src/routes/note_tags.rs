//! 文章 ↔ 标签：**读写都只从这里走**（20261018，`note.tags` 归一那一刀）。
//!
//! ── 这个模块存在的理由 ─────────────────────────────────────────────────────
//! 在此之前「这一篇挂了哪些标签」住在一列**逗号分隔的 id 字符串**里（`note.tags`），
//! 而"那个 id 是哪一级"要靠去 `tag_one` / `tag_two` 挨个查、两边都查到就只能猜。
//! 结构化之后这件事由 `note_tag` 表回答（一行自己知道指向哪张表，见
//! `entity/note_tag.rs`），本模块是**唯一**碰那张表的地方 ——
//! 写只有 `replace_note_tags` 一个出口，读只有 `load_note_tags` / `attach_tags`。
//!
//! ── 线格式逐字不变 ─────────────────────────────────────────────────────────
//! `noteTags` 对外的形状**仍然是逗号分隔的 id 串**（`NoteDto.tags`），只是内容改由
//! join 表重建。所以 agent 仓与前端**一个字节都不用改**，
//! `saudade-blog-agent/tests/test_note_tags_codec.py` 继续绿。
//!
//! ── soak 期两处同源（**这是刻意的，不是忘了删**）────────────────────────────
//! `replace_note_tags` 同时写 `note_tag` 与 `note.tags` 那列。
//! 理由：列还没删（`0007` 才删），而**回滚必须是一次 `git revert` 就能做完的事**——
//! 如果 soak 期只写新表，回滚时那列对 soak 期间写过的文章就是**陈旧的**，
//! 得先跑一遍回填才能回滚（"回滚要先修数据"是最不该有的形状）。
//! 两处由**同一个函数**写、且写的是**同一份解析结果**（`parse_tag_ids` 一遍），
//! 所以不是"两个实现"，是"一个实现写两个落脚点"。`0007` 落地时删掉这一半即可。
//!
//! ── 解析口径只有一份 ───────────────────────────────────────────────────────
//! `parse_tag_ids` 是那一份：**只认 ASCII 数字**（`[0-9]`，不是 `\d` —— Python 的 `\d`
//! 认全角数字而前端 `Number()` 不认，那一族"说得出画不出"的账记在
//! `test_note_tags_codec.py` ④）、`> 0`、**保序去重**。
//! 前端 `utils/noteTags.ts::toTagId`、agent `adminops_tags.py::parse_tag_ids`、
//! 迁移 `0006_note_tag.sql` 的回填 SQL 三处同口径。

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::collections::{HashMap, HashSet};

use crate::entity::{note, note_tag, tag_one, tag_two};
use crate::routes::notes::NoteDto;

/// 一个标签引用：id + 名字（**保序**由调用方按 `seq` 排好）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TagRef {
    pub id: i32,
    pub name: String,
}

/// `noteTags` 串 → 去重后的正整数 id 列表（**保序**：首次出现的顺序）。
///
/// 脏值一律丢：`""` / `"1,1,,"` / `"12abc"` / `"0"` / `"-3"` / `"  "` / 全角数字。
/// `parseInt('12abc') = 12` 那种"悄悄当成合法 id"的行为刻意不学 —— 悬空 id 会被当成
/// 真标签去解析名字，然后把 `12abc` 渲染成一个不存在的标签名。
pub(crate) fn parse_tag_ids(raw: Option<&str>) -> Vec<i32> {
    let mut out: Vec<i32> = Vec::new();
    for piece in raw.unwrap_or("").split(',') {
        let s = piece.trim();
        // `[0-9]` 而不是 `char::is_ascii_digit` 之外的花样：这一句就是口径本身。
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // 先按 u32 解析再夹到 i32：`99999999999` 这类超界值 parse::<i32>() 会 Err，
        // 但用 u32 解析出来再比上限，语义更直白（"超出 id 值域 ⇒ 丢掉"）。
        let Ok(n) = s.parse::<u32>() else { continue };
        if n == 0 || n > i32::MAX as u32 {
            continue;
        }
        let n = n as i32;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// id 列表 → `note.tags` 那列的字面值（空列表 = `None`，与"从没挂过标签"同形）。
///
/// ⚠️ 返回 `None` 而不是 `Some("")`：`note.tags` 是 `text NULL`，而
/// `frontend/src/utils/noteTags.ts::parseNoteTags` 对 `null` 与 `""` 都是空数组 ——
/// 两种写法在**读**侧等价，但存量数据里"没标签"一直是 NULL，写 `""` 会让同一件事
/// 在库里有两个字面值（`IS NULL` 的查询会漏掉一半）。
pub(crate) fn canonical_tags(ids: &[i32]) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    Some(ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","))
}

/// 这一批 id 里，哪些在 `tag_one`、哪些在 `tag_two`（各一次查询，不做逐 id 往返）。
async fn classify<C: ConnectionTrait>(
    db: &C,
    ids: &[i32],
) -> Result<(HashSet<i32>, HashSet<i32>), sea_orm::DbErr> {
    if ids.is_empty() {
        return Ok((HashSet::new(), HashSet::new()));
    }
    let one: Vec<i32> = tag_one::Entity::find()
        .select_only()
        .column(tag_one::Column::Id)
        .filter(tag_one::Column::Id.is_in(ids.to_vec()))
        .into_tuple::<i32>()
        .all(db)
        .await?;
    let two: Vec<i32> = tag_two::Entity::find()
        .select_only()
        .column(tag_two::Column::Id)
        .filter(tag_two::Column::Id.is_in(ids.to_vec()))
        .into_tuple::<i32>()
        .all(db)
        .await?;
    Ok((one.into_iter().collect(), two.into_iter().collect()))
}

/// **唯一**的写点：把 `note_id` 这一篇的标签整体换成 `tags` 解析出来的那些。
///
/// 三件事一起做（顺序不能换）：
///   ① 删掉这一篇现有的 `note_tag` 行；
///   ② 按解析结果重新插（`seq` = 解析顺序）；
///   ③ 把 `note.tags` 那列同步成**同一份**解析结果（soak 期两处同源，见模块头注）。
///
/// 归属判定：id 只在 `tag_one` ⇒ 挂 `tag_one_id`；只在 `tag_two` ⇒ 挂 `tag_two_id`；
/// **两边都有**（撞号）⇒ 取 `tag_one`（与 `notes.rs` 搜索侧的名字解析同一取向 ——
/// 前端 `flattenTagOptions` 也是一级优先；三处对齐的是同一件事）；**都没有**（悬空）⇒
/// 丢掉并 WARN（不报错：调用方是"保存文章"，不能因为一个历史脏 id 就把整次保存拒掉）。
///
/// ⚠️ 调用方**必须在事务里**调它（`update_note` / `create_note` / `autosave_note` 都是）：
/// 它自己会写两张表，失败时不能留下"列改了、关联表没改"的半截状态。
pub(crate) async fn replace_note_tags<C: ConnectionTrait>(
    db: &C,
    note_id: i32,
    tags: Option<&str>,
) -> Result<(), sea_orm::DbErr> {
    let ids = parse_tag_ids(tags);
    let (one, two) = classify(db, &ids).await?;

    let mut rows: Vec<note_tag::ActiveModel> = Vec::with_capacity(ids.len());
    let mut kept: Vec<i32> = Vec::with_capacity(ids.len());
    for (seq, id) in ids.iter().enumerate() {
        let in_one = one.contains(id);
        let in_two = two.contains(id);
        if !in_one && !in_two {
            tracing::warn!("[note_tags] 文章 {note_id} 的标签 id {id} 在两张表里都查不到（悬空），已丢弃");
            continue;
        }
        if in_one && in_two {
            tracing::warn!(
                "[note_tags] 文章 {note_id} 的标签 id {id} 在 tag_one 与 tag_two 里都存在（撞号），按一级处理"
            );
        }
        let (a, b) = if in_one { (Some(*id), None) } else { (None, Some(*id)) };
        rows.push(note_tag::ActiveModel {
            note_id: sea_orm::Set(note_id),
            seq: sea_orm::Set(seq as i16),
            tag_one_id: sea_orm::Set(a),
            tag_two_id: sea_orm::Set(b),
        });
        kept.push(*id);
    }

    note_tag::Entity::delete_many()
        .filter(note_tag::Column::NoteId.eq(note_id))
        .exec(db)
        .await?;
    if !rows.is_empty() {
        note_tag::Entity::insert_many(rows).exec(db).await?;
    }

    // ③ 同步那一列。`update` 只写 `Set` 过的列 ⇒ `updated_at` 一个字节不动
    // （与旧行为一致：改标签不该让文章在列表里跳到最前）。
    let mut am = note::ActiveModel { id: sea_orm::Set(note_id), ..Default::default() };
    am.tags = sea_orm::Set(canonical_tags(&kept));
    am.update(db).await?;
    Ok(())
}

/// 一批文章的关联行，`(note_id, tag_one_id, tag_two_id)`，**按 `(note_id, seq)` 升序**。
///
/// **本模块唯一的关联行读取点**：`load_note_tags`（要名字）与 `resync_tags_column`（只要 id）
/// 都从它派生。两处各写一遍 select 的话，"按 `seq` 排序"这条纪律就变成两处都要记得守，
/// 而漏掉它的症状是**标签顺序变了**（不报错）。
async fn note_tag_rows<C: ConnectionTrait>(
    db: &C,
    note_ids: &[i32],
) -> Result<Vec<(i32, Option<i32>, Option<i32>)>, sea_orm::DbErr> {
    let rows: Vec<(i32, i16, Option<i32>, Option<i32>)> = note_tag::Entity::find()
        .select_only()
        .column(note_tag::Column::NoteId)
        .column(note_tag::Column::Seq)
        .column(note_tag::Column::TagOneId)
        .column(note_tag::Column::TagTwoId)
        .filter(note_tag::Column::NoteId.is_in(note_ids.to_vec()))
        .order_by_asc(note_tag::Column::NoteId)
        .order_by_asc(note_tag::Column::Seq)
        .into_tuple::<(i32, i16, Option<i32>, Option<i32>)>()
        .all(db)
        .await?;
    Ok(rows.into_iter().map(|(nid, _, a, b)| (nid, a, b)).collect())
}

/// 一批文章 → 各自的标签引用（**按 `seq` 升序**，也就是展示顺序）。
///
/// 三次查询搞定整批（关联行一次 + 两张标签表各一次），不随文章数增长。
/// 查不到的标签 id **不出现**在结果里（外键保证了查不到只可能是"这一批 id 里没有它"）。
pub(crate) async fn load_note_tags<C: ConnectionTrait>(
    db: &C,
    note_ids: &[i32],
) -> HashMap<i32, Vec<TagRef>> {
    let mut out: HashMap<i32, Vec<TagRef>> = HashMap::new();
    if note_ids.is_empty() {
        return out;
    }
    let rows = match note_tag_rows(db, note_ids).await {
        Ok(v) => v,
        Err(e) => {
            // 与 `attach_stats` / `attach_authors` 同一取向：读不到就**什么都不挂**
            // （卡片上标签栏留空），而不是把整页弄成 500。留一行 WARN 让"空"有迹可循。
            tracing::warn!("[note_tags] 读取文章标签失败，本页不挂标签: {e}");
            return out;
        }
    };

    let mut one_ids: Vec<i32> = Vec::new();
    let mut two_ids: Vec<i32> = Vec::new();
    for (_, a, b) in &rows {
        if let Some(v) = a {
            one_ids.push(*v);
        }
        if let Some(v) = b {
            two_ids.push(*v);
        }
    }
    let names = tag_names(db, &one_ids, &two_ids).await;

    for (nid, a, b) in rows {
        let id = a.or(b);
        let Some(id) = id else { continue };
        let name = names.get(&id).cloned().unwrap_or_default();
        out.entry(nid).or_default().push(TagRef { id, name });
    }
    out
}

/// 把这一批文章的 `note.tags` 那一列**按关联表重算一遍**（soak 期两处同源的不变量）。
///
/// ── 什么时候需要它 ─────────────────────────────────────────────────────────
/// 关联行有**三条不经过 `replace_note_tags`** 的改动路径，它们都会让那一列**静默变陈旧**：
///   · 删标签（`tags.rs::delete_tags`）：外键 `ON DELETE CASCADE` 把关联行带走；
///   · 跨表移动改了 id（`move_tag_refs` + `do_move` 的 `id_changed` 支）：换的是列与值；
///   · 回填（`0006` 自己的 SQL）：插的是关联行、不碰这一列（那一半由"预检保证两边本来就
///     一致"承接，见迁移头注）。
/// 陈旧本身**看不见**（所有读路径都在关联表上），但它会让 `0007` 的预检把"删列"这件事
/// 拦下来，而那时你拿到的是一句"两边漂了"、却找不到漂在哪 —— 判据恒红之后就没人看了。
/// 所以这几条路必须自己把它算回来。
///
/// ── 为什么走 `replace_note_tags` 而不是直接 UPDATE 这一列 ──────────────────
/// "写这一列的地方只有一处"是 `frontend/tests/note-tag-single-source.test.mjs` 钉着的
/// 源码锁，也是"两处同源"能成立的前提（同一个函数写、写的是同一份解析结果）。
/// 这里重算出来的 id 列表本来就从关联表读的，`replace_note_tags` 的删+插因此是**幂等**的。
///
/// ⚠️ 调用方**必须在事务里**调它（与 `replace_note_tags` 同一条纪律）。
pub(crate) async fn resync_tags_column<C: ConnectionTrait>(
    db: &C,
    note_ids: &[i32],
) -> Result<u64, sea_orm::DbErr> {
    if note_ids.is_empty() {
        return Ok(0);
    }
    let rows = note_tag_rows(db, note_ids).await?;
    let mut by_note: HashMap<i32, Vec<i32>> = HashMap::new();
    for (nid, a, b) in rows {
        if let Some(t) = a.or(b) {
            by_note.entry(nid).or_default().push(t);
        }
    }
    let mut n = 0u64;
    for id in note_ids {
        // 关联表里一行都没有的篇 → 空列表 → `canonical_tags` 给 `None` → 那一列落成 NULL
        // （不是空串，见 `canonical_tags` 的 ⚠️）。这正是"标签被删光了"该有的样子。
        let ids = by_note.remove(id).unwrap_or_default();
        replace_note_tags(db, *id, canonical_tags(&ids).as_deref()).await?;
        n += 1;
    }
    Ok(n)
}

/// 一篇**当前**的标签串 —— 从关联表重建，**不是**读 `note.tags` 那一列。
///
/// 用途：`notes.rs` 里那两处"沿用行里现有的标签"（克隆修改稿时把原行的标签复制过来、
/// 自动保存没带 `noteTags` 时沿用）。它们**必须**走关联表 —— 读那一列等于把"那一列可能
/// 已经陈旧"请进读路径，而陈旧是看不见的（见 `resync_tags_column` 头注）。
///
/// 返回 `None` = 一个标签都没有（与 `canonical_tags` 的空列表同形）。
pub(crate) async fn current_tags<C: ConnectionTrait>(
    db: &C,
    note_id: i32,
) -> Result<Option<String>, sea_orm::DbErr> {
    let rows = note_tag_rows(db, &[note_id]).await?;
    let ids: Vec<i32> = rows.into_iter().filter_map(|(_, a, b)| a.or(b)).collect();
    Ok(canonical_tags(&ids))
}

/// 两级标签的 `id → 名字`（一次查两张表）。查不到的名字是空串 —— 外键在，理论上查不到
/// 只会发生在"这一批里没有那个 id"，而那种情况调用方也不会来问。
async fn tag_names<C: ConnectionTrait>(db: &C, one_ids: &[i32], two_ids: &[i32]) -> HashMap<i32, String> {
    let mut out: HashMap<i32, String> = HashMap::new();
    if !one_ids.is_empty() {
        if let Ok(rows) = tag_one::Entity::find()
            .select_only()
            .column(tag_one::Column::Id)
            .column(tag_one::Column::Name)
            .filter(tag_one::Column::Id.is_in(one_ids.to_vec()))
            .into_tuple::<(i32, String)>()
            .all(db)
            .await
        {
            out.extend(rows);
        }
    }
    if !two_ids.is_empty() {
        if let Ok(rows) = tag_two::Entity::find()
            .select_only()
            .column(tag_two::Column::Id)
            .column(tag_two::Column::Name)
            .filter(tag_two::Column::Id.is_in(two_ids.to_vec()))
            .all(db)
            .await
        {
            out.extend(rows.into_iter().map(|r| (r.id, r.name)));
        }
    }
    out
}

/// 给一批 DTO 挂上 `noteTags`（**线格式仍然是逗号分隔的 id 串**，见模块头注）。
///
/// 与 `attach_authors` / `attach_stats` 同一分工：`map_note` 是纯函数不查库，
/// 挂载由 handler 显式调一次。
///
/// ⚠️ **查不到时把 `tags` 置成空串**（不是留着旧值）：`NoteDto.tags` 默认是 `String::new()`，
/// 而"这一篇真的没有标签"与"这一路没挂"在连线上本来就同形（都是 `""`）——
/// 前端 `parseNoteTags("")` 得空数组，两者行为一致。
pub(crate) async fn attach_tags(db: &DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().map(|d| d.id).collect();
    if ids.is_empty() {
        return;
    }
    let map = load_note_tags(db, &ids).await;
    for dto in dtos.iter_mut() {
        let refs = map.get(&dto.id);
        let ids: Vec<i32> = refs.map(|v| v.iter().map(|t| t.id).collect()).unwrap_or_default();
        dto.tags = canonical_tags(&ids).unwrap_or_default();
    }
}

/// 公开可见文章的**每标签篇数**（`GET /api/tagone` / `/api/tagtwo` 的 `noteCount`）。
///
/// 口径与 `notes.rs::list_public_notes` **逐字一致**（`is_public = true` 且 status 在白名单里）
/// —— 改一处必须同步另一处，否则标签上写着「5 篇」、点进去只有 3 篇。
/// 同一篇里重复出现的标签只算一次（关联表的主键 `(note_id, seq)` 不禁止同一标签两行，
/// 所以这里仍然去重 —— 与旧实现同一个口径）。
pub(crate) async fn public_tag_counts(db: &DatabaseConnection) -> HashMap<i32, i64> {
    let visible: Vec<i32> = match note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.is_in(super::notes::public_status_words()))
        .into_tuple::<i32>()
        .all(db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[note_tags] 统计标签篇数：读取可见文章失败: {e}");
            return HashMap::new();
        }
    };
    if visible.is_empty() {
        return HashMap::new();
    }
    let rows = match note_tag::Entity::find()
        .select_only()
        .column(note_tag::Column::NoteId)
        .column(note_tag::Column::TagOneId)
        .column(note_tag::Column::TagTwoId)
        .filter(note_tag::Column::NoteId.is_in(visible))
        .into_tuple::<(i32, Option<i32>, Option<i32>)>()
        .all(db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[note_tags] 统计标签篇数：读取关联行失败: {e}");
            return HashMap::new();
        }
    };

    let mut counts: HashMap<i32, i64> = HashMap::new();
    let mut seen: HashSet<(i32, i32)> = HashSet::new();
    for (nid, a, b) in rows {
        if let Some(tid) = a.or(b) {
            if seen.insert((nid, tid)) {
                *counts.entry(tid).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// 引用了该标签的文章 id（**含草稿与"修改稿影子行"、含非公开** —— 标签字典是全站共用一套，
/// 只改公开行会让草稿的引用悬空）。
///
/// `in_two` 决定查哪一列。**不能**用"id 落在哪张表"来推：撞号时同一个数字两列都可能有行，
/// 调用方（`do_move`）明确知道自己搬的是哪一级。
pub(crate) async fn note_ids_with_tag<C: ConnectionTrait>(
    db: &C,
    tag_id: i32,
    in_two: bool,
) -> Result<Vec<i32>, sea_orm::DbErr> {
    note_ids_with_tags(db, &[tag_id], in_two).await
}

/// 同上，一次问一批标签 id（`delete_tags` 要删的是一整批）。
/// 去重后的文章 id —— 一篇文章同时挂了批里两个标签时只算一次。
pub(crate) async fn note_ids_with_tags<C: ConnectionTrait>(
    db: &C,
    tag_ids: &[i32],
    in_two: bool,
) -> Result<Vec<i32>, sea_orm::DbErr> {
    if tag_ids.is_empty() {
        return Ok(Vec::new());
    }
    let col = if in_two { note_tag::Column::TagTwoId } else { note_tag::Column::TagOneId };
    let ids: Vec<i32> = note_tag::Entity::find()
        .select_only()
        .column(note_tag::Column::NoteId)
        .filter(col.is_in(tag_ids.to_vec()))
        .into_tuple::<i32>()
        .all(db)
        .await?;
    let mut seen: HashSet<i32> = HashSet::new();
    Ok(ids.into_iter().filter(|i| seen.insert(*i)).collect())
}

/// 跨表移动时把关联行**改指向**：`from_two` 那一列上的 `tag_id` 全部搬到另一列、值为 `to_id`。
///
/// ⚠️ **必须在删掉旧标签行之前调**（`do_move` 的顺序就是为这件事排的）：
/// `note_tag` 的两个标签列都是 `ON DELETE CASCADE`，先删旧标签行的话这些关联行会
/// **被库静默带走** —— 事务照常提交、标签从 API 上消失、没有任何东西报错。
/// 这也是"沿用旧 id"那条路（`keep_id_allowed`）同样要调它的原因：id 没变，
/// **列变了**（`tag_one_id` → `tag_two_id`），不搬就还是指向那张已经不存在的表。
///
/// 返回被改写的行数（= 受影响的文章篇数，一篇一行）。
pub(crate) async fn move_tag_refs<C: ConnectionTrait>(
    db: &C,
    tag_id: i32,
    from_two: bool,
    to_id: i32,
) -> Result<u64, sea_orm::DbErr> {
    use sea_orm::sea_query::Expr;
    let (src_col, dst_col) = if from_two {
        (note_tag::Column::TagTwoId, note_tag::Column::TagOneId)
    } else {
        (note_tag::Column::TagOneId, note_tag::Column::TagTwoId)
    };
    let res = note_tag::Entity::update_many()
        .col_expr(src_col, Expr::value(Option::<i32>::None))
        .col_expr(dst_col, Expr::value(to_id))
        .filter(src_col.eq(tag_id))
        .exec(db)
        .await?;
    Ok(res.rows_affected)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 解析口径：**只认 ASCII 数字**、`> 0`、保序去重。
    ///
    /// 这一条是**跨语言契约**的本地那一半：`test_note_tags_codec.py` 在 agent 仓那侧
    /// 钉着同一组输入输出（前端 `noteTags.ts` 是第三处）。三处口径一旦漂，
    /// 症状是"agent 说这篇挂着标签 X、屏幕上却没有那个标签块"。
    #[test]
    fn 解析只认正ascii数字并保序去重() {
        assert_eq!(parse_tag_ids(Some("10,11")), vec![10, 11]);
        // 脏值：空片、空白、非数字、零、负数、全角数字
        assert_eq!(parse_tag_ids(Some("1,1,,")), vec![1]);
        assert_eq!(parse_tag_ids(Some(" 1 , 2 ")), vec![1, 2]);
        assert_eq!(parse_tag_ids(Some("12abc,13")), vec![13], "parseInt 式的脏值不许当 id");
        assert_eq!(parse_tag_ids(Some("0,-3,abc,")), Vec::<i32>::new());
        assert_eq!(parse_tag_ids(Some("１２")), Vec::<i32>::new(), "全角数字不认（前端也不认）");
        assert_eq!(parse_tag_ids(Some("+5")), Vec::<i32>::new(), "符号不是数字的一部分");
        assert_eq!(parse_tag_ids(Some("99999999999")), Vec::<i32>::new(), "超出 id 值域");
        assert_eq!(parse_tag_ids(None), Vec::<i32>::new());
        assert_eq!(parse_tag_ids(Some("")), Vec::<i32>::new());
        // 保序（不是排序）：`5,3` 必须原样是 [5,3]
        assert_eq!(parse_tag_ids(Some("5,3")), vec![5, 3]);
    }

    #[test]
    fn 空列表落成_null_而不是空串() {
        assert_eq!(canonical_tags(&[]), None);
        assert_eq!(canonical_tags(&[7]), Some("7".to_string()));
        assert_eq!(canonical_tags(&[5, 3]), Some("5,3".to_string()));
        // 往返：解析出来的东西写回去，逐字相同
        assert_eq!(
            canonical_tags(&parse_tag_ids(Some("14,10006,10008"))).as_deref(),
            Some("14,10006,10008")
        );
    }
}
