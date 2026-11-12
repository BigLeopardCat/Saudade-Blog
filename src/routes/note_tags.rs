//! Ordered article/tag references. Typed writes preserve level/id identity.
//! Id-only editor input retains existing references; new ambiguous ids prefer level one.
//! Writes update both ordered references and the note.tags projection in the caller transaction.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::collections::{HashMap, HashSet};

use crate::entity::{note, note_tag, tag_one, tag_two};
use crate::routes::notes::NoteDto;

/// 一个标签引用：id + 名字（**保序**由调用方按 `seq` 排好）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TagRef {
    pub id: i32,
    pub level: i16,
    pub color: Option<String>,
    pub name: String,
}

/// 解析 ASCII 正整数标签 id，保序去重并丢弃无效值。
pub(crate) fn parse_tag_ids(raw: Option<&str>) -> Vec<i32> {
    let mut out: Vec<i32> = Vec::new();
    for piece in raw.unwrap_or("").split(',') {
        let s = piece.trim();
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // 限制到数据库支持的正 i32 范围。
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

/// 将 id 列表编码为 note.tags 投影；无标签统一写 NULL。
pub(crate) fn canonical_tags(ids: &[i32]) -> Option<String> {
    if ids.is_empty() {
        return None;
    }
    Some(
        ids.iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(","),
    )
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

/// 在调用方事务内替换标签，保留已有 level/id 身份；新 id 撞号时一级优先。
/// 不存在的 id 记录告警并忽略，由 replace_typed_note_tags 更新关联和投影。
pub(crate) async fn replace_note_tags<C: ConnectionTrait>(
    db: &C,
    note_id: i32,
    tags: Option<&str>,
) -> Result<(), sea_orm::DbErr> {
    let ids = parse_tag_ids(tags);
    let (one, two) = classify(db, &ids).await?;

    let existing_rows = note_tag_rows(db, &[note_id]).await?;
    let existing: Vec<(i16, i32)> = existing_rows
        .into_iter()
        .filter_map(|(_, a, b)| a.map(|id| (1, id)).or_else(|| b.map(|id| (2, id))))
        .collect();
    let current_ids: Vec<i32> = existing.iter().map(|(_, id)| *id).collect();
    if parse_tag_ids(canonical_tags(&current_ids).as_deref()) == ids {
        return replace_typed_note_tags(db, note_id, &existing).await;
    }
    let mut refs = Vec::with_capacity(ids.len());
    for id in ids {
        let retained: Vec<_> = existing
            .iter()
            .copied()
            .filter(|(_, value)| *value == id)
            .collect();
        if !retained.is_empty() {
            refs.extend(retained);
        } else if one.contains(&id) {
            refs.push((1, id));
        } else if two.contains(&id) {
            refs.push((2, id));
        } else {
            tracing::warn!("[note_tags] missing tag id={id}; omitted from article {note_id}");
        }
    }
    replace_typed_note_tags(db, note_id, &refs).await
}

/// Replace exact level/id references and the note.tags projection in the caller transaction.
pub(crate) async fn replace_typed_note_tags<C: ConnectionTrait>(
    db: &C,
    note_id: i32,
    refs: &[(i16, i32)],
) -> Result<(), sea_orm::DbErr> {
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(refs.len());
    let mut kept = Vec::with_capacity(refs.len());
    for (seq, &(level, id)) in refs.iter().enumerate() {
        if id <= 0
            || !matches!(level, 1 | 2)
            || seq > i16::MAX as usize
            || !seen.insert((level, id))
        {
            return Err(sea_orm::DbErr::Custom("invalid typed tag reference".into()));
        }
        rows.push(note_tag::ActiveModel {
            note_id: sea_orm::Set(note_id),
            seq: sea_orm::Set(seq as i16),
            tag_one_id: sea_orm::Set((level == 1).then_some(id)),
            tag_two_id: sea_orm::Set((level == 2).then_some(id)),
        });
        kept.push(id);
    }
    note_tag::Entity::delete_many()
        .filter(note_tag::Column::NoteId.eq(note_id))
        .exec(db)
        .await?;
    if !rows.is_empty() {
        note_tag::Entity::insert_many(rows).exec(db).await?;
    }

    // 仅更新标签投影，保留文章 updated_at。
    let mut am = note::ActiveModel {
        id: sea_orm::Set(note_id),
        ..Default::default()
    };
    am.tags = sea_orm::Set(canonical_tags(&kept));
    am.update(db).await?;
    Ok(())
}

/// 按 (note_id, seq) 读取关联行，供展示和投影重建共用。
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

/// 批量读取文章标签及名称，按 seq 展示；查询次数不随文章数增长。
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
        let level = if a.is_some() { 1 } else { 2 };
        let (name, color) = names.get(&(level, id)).cloned().unwrap_or_default();
        out.entry(nid).or_default().push(TagRef {
            id,
            level,
            name,
            color,
        });
    }
    out
}

/// 在调用方事务内按关联重建标签投影，用于删除或移动标签后的同步。
pub(crate) async fn resync_tags_column<C: ConnectionTrait>(
    db: &C,
    note_ids: &[i32],
) -> Result<u64, sea_orm::DbErr> {
    if note_ids.is_empty() {
        return Ok(0);
    }
    let rows = note_tag_rows(db, note_ids).await?;
    let mut by_note: HashMap<i32, Vec<(i16, i32)>> = HashMap::new();
    for (nid, a, b) in rows {
        if let Some(t) = a.or(b) {
            by_note
                .entry(nid)
                .or_default()
                .push((if a.is_some() { 1 } else { 2 }, t));
        }
    }
    let mut n = 0u64;
    for id in note_ids {
        // 无关联时写入空列表，将标签投影归一为 NULL。
        let ids = by_note.remove(id).unwrap_or_default();
        replace_typed_note_tags(db, *id, &ids).await?;
        n += 1;
    }
    Ok(n)
}

/// 通过两级标签名查找文章 id，供关键词预筛使用。
pub(crate) async fn note_ids_with_tag_name_hits<C: ConnectionTrait>(
    db: &C,
    terms: &[String],
) -> Result<Vec<i32>, sea_orm::DbErr> {
    use sea_orm::sea_query::{Expr, SimpleExpr};

    let mut out: Vec<i32> = Vec::new();
    // 两级各拼一次条件：列不同（`tag_one.name` / `tag_two.name`），查询也只能各发一条。
    let one_cond = crate::search_core::keyword_prefilter(
        &[SimpleExpr::from(Expr::col((
            tag_one::Entity,
            tag_one::Column::Name,
        )))],
        terms,
    );
    let two_cond = crate::search_core::keyword_prefilter(
        &[SimpleExpr::from(Expr::col((
            tag_two::Entity,
            tag_two::Column::Name,
        )))],
        terms,
    );
    if let Some(cond) = one_cond {
        let ids: Vec<i32> = note_tag::Entity::find()
            .inner_join(tag_one::Entity)
            .filter(cond)
            .select_only()
            .column(note_tag::Column::NoteId)
            .into_tuple::<i32>()
            .all(db)
            .await?;
        out.extend(ids);
    }
    if let Some(cond) = two_cond {
        let ids: Vec<i32> = note_tag::Entity::find()
            .inner_join(tag_two::Entity)
            .filter(cond)
            .select_only()
            .column(note_tag::Column::NoteId)
            .into_tuple::<i32>()
            .all(db)
            .await?;
        out.extend(ids);
    }
    let mut seen: HashSet<i32> = HashSet::new();
    out.retain(|i| seen.insert(*i));
    Ok(out)
}

/// 从有序关联重建当前标签串，无标签返回 None。
pub(crate) async fn current_tags<C: ConnectionTrait>(
    db: &C,
    note_id: i32,
) -> Result<Option<String>, sea_orm::DbErr> {
    let rows = note_tag_rows(db, &[note_id]).await?;
    let ids: Vec<i32> = rows.into_iter().filter_map(|(_, a, b)| a.or(b)).collect();
    Ok(canonical_tags(&ids))
}

/// Copy level/id references without a legacy serialization round trip.
pub(crate) async fn copy_note_tags<C: ConnectionTrait>(
    db: &C,
    source: i32,
    target: i32,
) -> Result<(), sea_orm::DbErr> {
    let rows = note_tag_rows(db, &[source]).await?;
    let refs: Vec<_> = rows
        .into_iter()
        .filter_map(|(_, a, b)| a.map(|id| (1, id)).or_else(|| b.map(|id| (2, id))))
        .collect();
    replace_typed_note_tags(db, target, &refs).await
}

/// 批量读取两级标签名称和颜色；读取失败的部分不附加元数据。
async fn tag_names<C: ConnectionTrait>(
    db: &C,
    one_ids: &[i32],
    two_ids: &[i32],
) -> HashMap<(i16, i32), (String, Option<String>)> {
    let mut out = HashMap::new();
    if !one_ids.is_empty() {
        if let Ok(rows) = tag_one::Entity::find()
            .filter(tag_one::Column::Id.is_in(one_ids.to_vec()))
            .all(db)
            .await
        {
            out.extend(rows.into_iter().map(|r| ((1, r.id), (r.name, r.color))));
        }
    }
    if !two_ids.is_empty() {
        if let Ok(rows) = tag_two::Entity::find()
            .filter(tag_two::Column::Id.is_in(two_ids.to_vec()))
            .all(db)
            .await
        {
            out.extend(rows.into_iter().map(|r| ((2, r.id), (r.name, r.color))));
        }
    }
    out
}

pub(crate) async fn attach_tags<C: ConnectionTrait>(db: &C, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().map(|d| d.id).collect();
    if ids.is_empty() {
        return;
    }
    let map = load_note_tags(db, &ids).await;
    for dto in dtos.iter_mut() {
        let refs = map.get(&dto.id);
        let ids: Vec<i32> = refs
            .map(|v| v.iter().map(|t| t.id).collect())
            .unwrap_or_default();
        dto.tags = canonical_tags(&ids).unwrap_or_default();
        dto.tag_refs = refs.cloned().unwrap_or_default();
    }
}

/// 按公开已发布主文章口径统计各标签篇数；查询失败返回错误。
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

/// 查询引用标签的全部文章，包含草稿、修改稿和非公开文章。
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
    let col = if in_two {
        note_tag::Column::TagTwoId
    } else {
        note_tag::Column::TagOneId
    };
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

/// 跨级移动标签引用；必须在删掉旧标签行之前调用，避免 ON DELETE CASCADE 移除关联。
/// 返回更新的关联行数。
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

    /// 核对 ASCII 正整数解析与保序去重契约。
    #[test]
    fn 解析只认正ascii数字并保序去重() {
        assert_eq!(parse_tag_ids(Some("10,11")), vec![10, 11]);
        // 脏值：空片、空白、非数字、零、负数、全角数字
        assert_eq!(parse_tag_ids(Some("1,1,,")), vec![1]);
        assert_eq!(parse_tag_ids(Some(" 1 , 2 ")), vec![1, 2]);
        assert_eq!(
            parse_tag_ids(Some("12abc,13")),
            vec![13],
            "parseInt 式的脏值不许当 id"
        );
        assert_eq!(parse_tag_ids(Some("0,-3,abc,")), Vec::<i32>::new());
        assert_eq!(
            parse_tag_ids(Some("１２")),
            Vec::<i32>::new(),
            "全角数字不认（前端也不认）"
        );
        assert_eq!(
            parse_tag_ids(Some("+5")),
            Vec::<i32>::new(),
            "符号不是数字的一部分"
        );
        assert_eq!(
            parse_tag_ids(Some("99999999999")),
            Vec::<i32>::new(),
            "超出 id 值域"
        );
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
