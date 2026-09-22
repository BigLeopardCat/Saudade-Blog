use axum::{Json, extract::State};
use sea_orm::{
    EntityTrait, ColumnTrait, QueryFilter, QuerySelect, Set, ActiveModelTrait,
    ConnectionTrait, TransactionTrait,
};
use sea_orm::entity::prelude::DateTime;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use crate::entity::{note, tag_one, tag_two};
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 每个标签的**公开可见**文章数 → `{tag_id: count}`（20260921）。
///
/// 口径与 `notes.rs::list_public_notes` **逐字一致**（`is_public = true` 且 `status != 'draft'`）
/// ——改一处必须同步另一处，否则标签上写着「5 篇」、点进去只有 3 篇。
/// `note.tags` 存的是逗号分隔的标签 **id** 串（不是名字）；同一篇里重复出现的 id 只算一次
/// （库里有历史数据一个 id 写两遍）。
///
/// 只 select `tags` 一列：这个接口是公开的、标签页每次都会拉，正文（单篇可达几十 KB）没必要读。
async fn public_note_tag_counts(db: &DatabaseConnection) -> HashMap<i32, i64> {
    let rows: Vec<Option<String>> = note::Entity::find()
        .select_only()
        .column(note::Column::Tags)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .into_tuple::<Option<String>>()
        .all(db)
        .await
        .unwrap_or_default();
    let mut counts: HashMap<i32, i64> = HashMap::new();
    for tags in rows.into_iter().flatten() {
        let mut seen: Vec<i32> = Vec::new();
        for piece in tags.split(',') {
            if let Ok(id) = piece.trim().parse::<i32>() {
                if !seen.contains(&id) {
                    seen.push(id);
                    *counts.entry(id).or_insert(0) += 1;
                }
            }
        }
    }
    counts
}

#[derive(Serialize)]
pub struct TagOneDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    /// 该标签下的**公开可见**文章数（20260921）。只统计**显式带了这个 id** 的文章，
    /// 不含"父标签自动继承子标签"之类的展开——`note.tags` 里写了什么就是什么。
    #[serde(rename = "noteCount")]
    pub note_count: i64,
    // children not needed for getTagOne list as per frontend mapping?
    // Frontend maps manually?
    // "children: []" in frontend mapper implies it builds tree locally.
    // So simple list is fine.
}

#[derive(Serialize)]
pub struct TagTwoDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    /// 父标签**名字**。**只作兼容保留，新代码不要用它建树**——按名字关联的后果是
    /// 「一级标签一改名，其下所有二级标签集体从前端树里消失」（两个同名一级标签还会共享子标签）。
    #[serde(rename = "fatherTag")]
    pub father_tag: String,
    /// 父标签 **id**（= `tag_two.tag_one_id`），前端建树的正确键。
    #[serde(rename = "fatherKey")]
    pub father_key: Option<i32>,
    /// 该标签下的**公开可见**文章数（20260921），语义同 `TagOneDto::note_count`。
    #[serde(rename = "noteCount")]
    pub note_count: i64,
}

pub async fn list_tags_one(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagOneDto>>> {
    let counts = public_note_tag_counts(&state.db).await;
    let t1s = tag_one::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    let dtos = t1s.into_iter().map(|t| TagOneDto {
        id: t.id,
        title: t.name,
        color: t.color.unwrap_or_default(),
        level: 1,
        note_count: counts.get(&t.id).copied().unwrap_or(0),
    }).collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_tags_two(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagTwoDto>>> {
     let counts = public_note_tag_counts(&state.db).await;
     let t2s = tag_two::Entity::find().find_with_related(tag_one::Entity).all(&state.db).await.unwrap_or(vec![]);

     let dtos = t2s.into_iter().map(|(t2, t1s)| {
         let t1 = t1s.into_iter().next();
         let father_name = t1.as_ref().map(|x| x.name.clone()).unwrap_or_default();

         TagTwoDto {
             id: t2.id,
             title: t2.name,
             color: t2.color.unwrap_or_default(),
             level: 2,
             father_tag: father_name,
             father_key: t2.tag_one_id,
             note_count: counts.get(&t2.id).copied().unwrap_or(0),
         }
     }).collect();
     
     Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertTagOne {
    pub title: String,
    pub color: String,
}

pub async fn create_tag_one(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTagOne>,
) -> Json<ApiResponse<String>> {
    let t = tag_one::ActiveModel {
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    // 返回新 id（字符串）：编辑器里「就地新建标签」需要它来把新标签当场选中。
    // 以前返回死字符串 "Created"，前端拿不到 id。原实现用 unwrap()，重名等失败会 panic 成 500，
    // 前端 catch 里的「已存在」提示永远走不到。
    match tag_one::Entity::insert(t).exec(&state.db).await {
        Ok(r) => Json(ApiResponse::success(r.last_insert_id.to_string())),
        Err(e) => {
            tracing::error!("创建一级标签失败: {e}");
            Json(ApiResponse::error("创建失败（标签名可能已存在）"))
        }
    }
}

#[derive(Deserialize)]
pub struct UpsertTagTwo {
    pub title: String,
    pub color: String,
    #[serde(rename = "fatherTag")]
    pub father_id: i32,
}

pub async fn create_tag_two(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTagTwo>,
) -> Json<ApiResponse<String>> {
    let t = tag_two::ActiveModel {
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        tag_one_id: Set(Some(payload.father_id)),
        ..Default::default()
    };
    match tag_two::Entity::insert(t).exec(&state.db).await {
        Ok(r) => Json(ApiResponse::success(r.last_insert_id.to_string())),
        Err(e) => {
            tracing::error!("创建二级标签失败: {e}");
            Json(ApiResponse::error("创建失败（父标签不存在或标签名重复）"))
        }
    }
}

/// 删除标签的请求体。
///
/// **为什么必须带 level**：旧接口只收一个 `Vec<i32>` 然后**同时去两张表删**。
/// `tag_one.id` 与 `tag_two.id` 是两条独立的自增序列（当前一级 10/11/13/14、二级 5/6/7/8），
/// 于是删一级标签 #13 会连带把二级标签 #13 一起删掉（反之亦然）——删一个标签丢掉另一个
/// 毫不相干的标签。带上层级后只删指定表。
#[derive(Deserialize)]
pub struct DeleteTagsRequest {
    /// "one" | "two"
    pub level: String,
    pub ids: Vec<i32>,
}

pub async fn delete_tags(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DeleteTagsRequest>,
) -> Json<ApiResponse<String>> {
    let ids = payload.ids;
    if ids.is_empty() {
        return Json(ApiResponse::success("Deleted".to_string()));
    }

    match payload.level.as_str() {
        "one" => {
            // 子标签由 FK `tag_two.tag_one_id → tag_one.id` 的 ON DELETE CASCADE 一起删。
            // 这里不需要预先取子 id 去清 note.tags：下面的 prune 以字典删除后的实际状态为准。
            if let Err(e) = tag_one::Entity::delete_many()
                .filter(tag_one::Column::Id.is_in(ids))
                .exec(&state.db)
                .await
            {
                tracing::error!("删除一级标签失败: {e}");
                return Json(ApiResponse::error("删除失败"));
            }
        }
        "two" => {
            if let Err(e) = tag_two::Entity::delete_many()
                .filter(tag_two::Column::Id.is_in(ids))
                .exec(&state.db)
                .await
            {
                tracing::error!("删除二级标签失败: {e}");
                return Json(ApiResponse::error("删除失败"));
            }
        }
        other => {
            tracing::warn!("删除标签收到非法 level: {other}");
            return Json(ApiResponse::error("标签层级不合法"));
        }
    }

    // 删完顺手把 note.tags 里指向已删标签的 id 摘掉 —— 不做的话线上就留下悬空 id，
    // 列表/卡片上渲染成空白标签小块（现存数据里 18 篇有标签的文章有 12 篇是这种）。
    let pruned = prune_note_tags(&state).await;
    if pruned > 0 {
        tracing::info!("删除标签后清理了 {pruned} 行 note.tags");
    }
    Json(ApiResponse::success("Deleted".to_string()))
}

/// 把所有 `note.tags` 里**已经不存在于标签字典**的 id 摘掉（顺带去重、去空片），只写回有变化的行。
///
/// **判据是「两张表里都没有」而不是「调用方说删了哪些」**：两级标签 id 是两条独立自增序列、
/// 历史上可能重号，所以「某 id 在一级标签里没了」不等于「note.tags 里这个 id 不是二级标签」。
/// 这里以字典的实际状态为准，天然幂等、也不会误删另一级的同名 id。
pub async fn prune_note_tags(state: &Arc<AppState>) -> usize {
    let mut live: HashSet<i32> = HashSet::new();
    if let Ok(rows) = tag_one::Entity::find().all(&state.db).await {
        live.extend(rows.into_iter().map(|r| r.id));
    }
    if let Ok(rows) = tag_two::Entity::find().all(&state.db).await {
        live.extend(rows.into_iter().map(|r| r.id));
    }

    let notes = match note::Entity::find()
        .filter(note::Column::Tags.is_not_null())
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("清理悬空标签：读取 note 失败: {e}");
            return 0;
        }
    };

    let mut changed = 0usize;
    for n in notes {
        let raw = n.tags.clone().unwrap_or_default();
        if raw.is_empty() {
            continue;
        }
        let mut kept: Vec<i32> = Vec::new();
        for piece in raw.split(',') {
            if let Ok(id) = piece.trim().parse::<i32>() {
                if live.contains(&id) && !kept.contains(&id) {
                    kept.push(id);
                }
            }
        }
        let new = kept.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
        if new == raw {
            continue;
        }
        let mut am = note::ActiveModel { id: Set(n.id), ..Default::default() };
        am.tags = Set(if new.is_empty() { None } else { Some(new) });
        match am.update(&state.db).await {
            Ok(_) => changed += 1,
            Err(e) => tracing::error!("清理悬空标签：更新 note {} 失败: {e}", n.id),
        }
    }
    changed
}

#[derive(Deserialize)]
pub struct UpdateTagOne {
    pub title: String,
    pub color: String,
}

pub async fn update_tag_one(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpdateTagOne>,
) -> Json<ApiResponse<String>> {
    use sea_orm::EntityTrait;
    
    let t = tag_one::ActiveModel {
        id: Set(id),
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    match tag_one::Entity::update(t).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Updated".to_string())),
        Err(e) => {
            tracing::error!("更新一级标签 {id} 失败: {e}");
            Json(ApiResponse::error("更新失败（标签不存在或名称重复）"))
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateTagTwo {
    pub title: String,
    pub color: String,
}

pub async fn update_tag_two(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpdateTagTwo>,
) -> Json<ApiResponse<String>> {
    use sea_orm::EntityTrait;
    
    let t = tag_two::ActiveModel {
        id: Set(id),
        name: Set(payload.title),
        color: Set(Some(payload.color)),
        ..Default::default()
    };
    match tag_two::Entity::update(t).exec(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Updated".to_string())),
        Err(e) => {
            tracing::error!("更新二级标签 {id} 失败: {e}");
            Json(ApiResponse::error("更新失败（标签不存在或名称重复）"))
        }
    }
}

// ── 标签移动 / 换层级（20260921）────────────────────────────────────────────
//
// 为什么需要这条端点：既有写端点里 `POST /tagone|tagtwo` 是"新建"、`PUT /tagone|tagtwo/:id`
// 只改 title/color（两个字段都必填）、`DELETE /tag` 是真删且会触发全表 `prune_note_tags`。
// 于是"把标签挪到另一个父标签下 / 一级↔二级互转"只能靠"删了重建"——而删除会把所有文章的
// 引用一起摘掉（不可回滚）。换层级必须是一条**原子**的移动端点。
//
// ⚠️ 本端点唯一的**静默删除路径**是 FK `tag_two.tag_one_id → tag_one.id` 的 ON DELETE CASCADE：
// 降级（一→二）时先 INSERT 二级行、再 DELETE 一级行；若 `fatherTag == id`（自环），那条 DELETE
// 会连**刚插入的新行**一起 CASCADE 掉——事务成功提交、标签却彻底消失，一声不响。故：
//   ① 自环硬禁；② 降级前该一级标签必须没有子标签（否则拒绝），让 CASCADE 无事可做。

/// `tag_two` 的自增起点（`scripts/migration/tag_autoincrement_20260919.sql`）。
/// 语义：**新分配的**二级标签 id 永远 ≥ 它——存量二级（5/6/7/8）不受影响，仍小于它。
const TAG_TWO_ID_BASE: i32 = 10_000;

/// `"one"` → false（一级）、`"two"` → true（二级）；其它 → None。
/// 词表与 `DeleteTagsRequest` 同源（前端后台两个动作写法一致）。
fn parse_level(s: &str) -> Option<bool> {
    match s {
        "one" => Some(false),
        "two" => Some(true),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct MoveTagRequest {
    /// 被移动标签**当前**的层级："one" | "two"
    pub level: String,
    pub id: i32,
    /// 目标层级；缺省 = 与 `level` 相同（此时就是"换父级"）
    #[serde(default, rename = "toLevel")]
    pub to_level: Option<String>,
    /// `toLevel="two"` 时必填：目标父（一级标签）id；`toLevel="one"` 时必须缺省
    #[serde(default, rename = "fatherTag")]
    pub father_id: Option<i32>,
    /// 可选：顺带改名（缺省保留原名）
    #[serde(default)]
    pub title: Option<String>,
    /// 可选：顺带改色（缺省保留原色）
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Serialize, Default)]
pub struct MoveTagResult {
    #[serde(rename = "fromLevel")]
    pub from_level: String,
    #[serde(rename = "fromId")]
    pub from_id: i32,
    #[serde(rename = "toLevel")]
    pub to_level: String,
    #[serde(rename = "toId")]
    pub to_id: i32,
    /// **调用方最该读的字段**：true ⇒ 标签换了 id、`note.tags` 已被重写
    #[serde(rename = "idChanged")]
    pub id_changed: bool,
    #[serde(rename = "fatherKey")]
    pub father_key: Option<i32>,
    #[serde(rename = "fatherTitle")]
    pub father_title: Option<String>,
    /// 该标签名下的二级标签数（降级时 >0 会**被拒**，恒为 0）
    #[serde(rename = "childCount")]
    pub child_count: i64,
    /// 引用了该标签的 note 行数（含草稿/修改稿影子行、含非公开）
    #[serde(rename = "affectedNotes")]
    pub affected_notes: i64,
    /// 实际改写 `note.tags` 的行数（同层移动与 keepId 路径恒为 0）
    #[serde(rename = "rewrittenNotes")]
    pub rewritten_notes: u64,
    /// 非致命提示（重名、并发残留意等），逐条可读中文
    pub warnings: Vec<String>,
}

/// 校验后的移动意图。**纯数据 + 纯函数**，可脱离数据库单测。
#[derive(Debug, PartialEq)]
struct MoveSpec {
    from_two: bool,
    to_two: bool,
    id: i32,
    father_id: Option<i32>,
    title: Option<String>,
    color: Option<String>,
}

impl MoveSpec {
    /// 是否真的跨表换层级（false = 同层，只换父级/改名改色）
    fn crosses(&self) -> bool {
        self.from_two != self.to_two
    }

    fn from_code(&self) -> &'static str {
        if self.from_two { "two" } else { "one" }
    }

    fn to_code(&self) -> &'static str {
        if self.to_two { "two" } else { "one" }
    }
}

/// 入参校验（全部在碰数据库之前）。返回的中文原因直接进 `ApiResponse::error`。
fn parse_move(
    level: &str,
    id: i32,
    to_level: Option<&str>,
    father_id: Option<i32>,
    title: Option<&str>,
    color: Option<&str>,
) -> Result<MoveSpec, String> {
    let from_two = parse_level(level).ok_or_else(|| "标签层级不合法".to_string())?;
    let to_two = match to_level {
        Some(t) => parse_level(t).ok_or_else(|| "标签层级不合法".to_string())?,
        None => from_two,
    };
    if to_two && father_id.is_none() {
        return Err("移动到二级必须给出目标父标签".to_string());
    }
    if !to_two && father_id.is_some() {
        return Err("一级标签没有父标签".to_string());
    }
    // 自环不只是洁癖：它是上面那条 CASCADE 静默删行的触发条件（见本块头注）。
    if father_id == Some(id) {
        return Err("不能把标签挂到它自己下面".to_string());
    }
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err("标签名不能为空".to_string());
        }
    }
    Ok(MoveSpec {
        from_two,
        to_two,
        id,
        father_id,
        title: title.map(|s| s.to_string()),
        color: color.map(|s| s.to_string()),
    })
}

/// 跨表移动时能否**沿用旧 id**（沿用则 `note.tags` 一个字节都不动 ⇒ 整个移动可逆）。
///
/// 两个前提（还须运行时再确认目标表没有同 id 行）：
///  · 一→二恒真——一级标签存量 id 全 < `TAG_TWO_ID_BASE` < tag_two 的自增计数器，
///    目标表永远不会再分配这个值；
///  · 二→一仅当 id < `TAG_TWO_ID_BASE`——20260919 起新分配的二级 id 全 ≥ 它，沿用它们
///    会破坏"新分配 id 永不相交"这条事实，给 tag_one 未来埋一颗重复键地雷。
fn keep_id_allowed(from_two: bool, to_two: bool, id: i32) -> bool {
    if from_two == to_two {
        return true;
    }
    if !from_two && to_two {
        return true;
    }
    id < TAG_TWO_ID_BASE
}

/// `note.tags` 原文 → 重映射后的串；**None = 一个字节都不用动**。
///
/// **绝不能 `String::replace`**：`replace("1","12")` 会把 12/21/13 一起改坏；补分隔符
/// （`,1,` → `,12,`）又漏掉首尾。唯一正确的做法是按 `,` 切开 → 逐片 parse → 数值比较 →
/// 重拼（与 `prune_note_tags` 同一套解析口径，改一处必须同步另一处）。
///
/// 与 `prune_note_tags` 三处**有意不同**：① 它是"尽力而为的净化"、本函数是移动事务的一步，
/// 调用方必须让写失败上抛回滚；② 只读 `(id, tags)` 两列，不把正文读进内存；③ 不动与本次移动
/// 无关的行（返回 None）、也不顺手判悬空——那是全表净化，不是一次搬运该做的事。
/// 保持原有顺序（顺序稳定才能"无变化 ⇒ 不写"）、去重、丢掉解析不出的片。
fn remap_tag_ids(raw: &str, old_id: i32, new_id: i32) -> Option<String> {
    let mut seen_old = false;
    let mut out: Vec<i32> = Vec::new();
    for piece in raw.split(',') {
        if let Ok(id) = piece.trim().parse::<i32>() {
            if id == old_id {
                seen_old = true;
            }
            let id = if id == old_id { new_id } else { id };
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    if !seen_old {
        return None;
    }
    let next = out.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    if next == raw {
        None
    } else {
        Some(next)
    }
}

/// "这一行引用了 `tag_id` 吗"的**唯一判据**——预览计数与实际被重写的行集合同源，
/// 不允许出现两套解析（预览说 3 篇、实际改 5 篇是最坏的一类不一致）。
fn note_refs_tag(raw: &str, tag_id: i32) -> bool {
    raw.split(',').any(|p| p.trim().parse::<i32>() == Ok(tag_id))
}

/// 引用了该标签的 note id 列表（含草稿与"修改稿影子行"、含非公开——`note.tags` 共用一套字典，
/// 只改公开行会让草稿的引用悬空）。
async fn notes_referencing<C: ConnectionTrait>(
    db: &C,
    tag_id: i32,
) -> Result<Vec<i32>, sea_orm::DbErr> {
    let rows: Vec<(i32, Option<String>)> = note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Tags)
        .filter(note::Column::Tags.is_not_null())
        .into_tuple::<(i32, Option<String>)>()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, t)| match t {
            Some(raw) => note_refs_tag(raw, tag_id),
            None => false,
        })
        .map(|(id, _)| id)
        .collect())
}

/// 把 `note.tags` 里所有 `old_id` 改成 `new_id`（跨表移动且没能沿用旧 id 时）。
///
/// 写失败**上抛**——它是移动事务的一步，部分成功比整体失败更糟（会留下悬空引用）。
/// 写回时**显式保留 `updated_at`**：该列若带 `ON UPDATE CURRENT_TIMESTAMP`，被重写的文章会
/// 集体跳到列表最前、sitemap 顺序变化——显式赋值让这件事与列定义无关。
async fn swap_tag_refs<C: ConnectionTrait>(
    db: &C,
    old_id: i32,
    new_id: i32,
) -> Result<u64, sea_orm::DbErr> {
    let rows: Vec<(i32, Option<String>, DateTime)> = note::Entity::find()
        .select_only()
        .column(note::Column::Id)
        .column(note::Column::Tags)
        .column(note::Column::UpdatedAt)
        .filter(note::Column::Tags.is_not_null())
        .into_tuple::<(i32, Option<String>, DateTime)>()
        .all(db)
        .await?;

    let mut changed = 0u64;
    for (nid, tags, updated) in rows {
        let raw = tags.unwrap_or_default();
        if raw.is_empty() {
            continue;
        }
        let next = match remap_tag_ids(&raw, old_id, new_id) {
            Some(n) => n,
            None => continue,
        };
        let mut am = note::ActiveModel { id: Set(nid), ..Default::default() };
        am.tags = Set(if next.is_empty() { None } else { Some(next) });
        am.updated_at = Set(updated);
        am.update(db).await?;
        changed += 1;
    }
    Ok(changed)
}

/// 事务内的实际搬运（调用方负责 begin/commit/rollback）。Err 里是给用户看的中文原因。
async fn do_move<C: ConnectionTrait>(db: &C, spec: &MoveSpec) -> Result<MoveTagResult, String> {
    // ① 锁住被移动的行。堵住的是一条真实的 TOCTOU：下面数子标签是一致性读、不持锁，
    //    若此刻别人正给这个一级标签新建子标签，它提交后会被我们的 DELETE 一起 CASCADE 掉，
    //    而对方拿到的是"创建成功"。持 X 锁后对方的 FK 检查会阻塞到我们提交、再如实报错。
    let (old_name, old_color, old_level_col) = if spec.from_two {
        let row = tag_two::Entity::find_by_id(spec.id)
            .lock_exclusive()
            .one(db)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：读取二级标签 {} 失败: {e}", spec.id);
                "移动失败（读取标签出错）".to_string()
            })?;
        match row {
            Some(r) => (r.name, r.color, r.level),
            None => return Err("标签不存在（可能已被移动或删除）".to_string()),
        }
    } else {
        let row = tag_one::Entity::find_by_id(spec.id)
            .lock_exclusive()
            .one(db)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：读取一级标签 {} 失败: {e}", spec.id);
                "移动失败（读取标签出错）".to_string()
            })?;
        match row {
            Some(r) => (r.name, r.color, r.level),
            None => return Err("标签不存在（可能已被移动或删除）".to_string()),
        }
    };

    // ② 目标父必须存在，且只能是一级标签（结构上天然满足：只有 tag_two 有父列，没有三级表）
    let father = if spec.to_two {
        match spec.father_id {
            Some(fid) => match tag_one::Entity::find_by_id(fid).one(db).await {
                Ok(Some(f)) => Some(f),
                Ok(None) => {
                    return Err("目标父标签不存在（父必须是一级标签）".to_string())
                }
                Err(e) => {
                    tracing::error!("移动标签：读取目标父 {fid} 失败: {e}");
                    return Err("移动失败（读取目标父出错）".to_string());
                }
            },
            None => return Err("移动到二级必须给出目标父标签".to_string()),
        }
    } else {
        None
    };

    // ③ 降级前该一级标签必须没有子标签：拒绝要**如实报数报名字**，语义上也保证下面的 DELETE
    //    不会连坐（CASCADE 无事可做就是这个端点的安全前提，见本块头注）
    let children = if spec.crosses() && !spec.from_two {
        tag_two::Entity::find()
            .filter(tag_two::Column::TagOneId.eq(spec.id))
            .all(db)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：读取子标签失败: {e}");
                "移动失败（读取子标签出错）".to_string()
            })?
    } else {
        Vec::new()
    };
    if !children.is_empty() {
        let shown: Vec<String> = children.iter().take(3).map(|c| c.name.clone()).collect();
        let more = if children.len() > shown.len() { "…" } else { "" };
        return Err(format!(
            "「{old_name}」下还有 {} 个二级标签（{}{}），请先把它们移走或删除",
            children.len(),
            shown.join("、"),
            more
        ));
    }

    // ④ 影响面（预览与改写同源，见 notes_referencing）
    let affected = notes_referencing(db, spec.id)
        .await
        .map_err(|e| {
            tracing::error!("移动标签：统计引用失败: {e}");
            "移动失败（统计文章引用出错）".to_string()
        })?
        .len() as i64;

    // ⑤ id 策略：优先沿用旧 id（note.tags 一个字节不动 ⇒ 可逆）
    let keep_id = if !spec.crosses() {
        true
    } else if keep_id_allowed(spec.from_two, spec.to_two, spec.id) {
        // 目标表已有同 id 行就不能沿用（PK 会撞）——回落新分配 id，不把管理员卡死
        let taken = if spec.to_two {
            tag_two::Entity::find_by_id(spec.id).one(db).await.map(|r| r.is_some())
        } else {
            tag_one::Entity::find_by_id(spec.id).one(db).await.map(|r| r.is_some())
        };
        match taken {
            Ok(taken) => !taken,
            Err(e) => {
                tracing::error!("移动标签：检查目标表同 id 失败: {e}");
                return Err("移动失败（检查目标 id 出错）".to_string());
            }
        }
    } else {
        false
    };

    let new_title = spec.title.clone().unwrap_or_else(|| old_name.clone());
    let new_color = spec.color.clone().or_else(|| old_color.clone());
    let mut to_id = spec.id;
    let mut rewritten = 0u64;

    if !spec.crosses() {
        // 同层：只换父级 / 改名改色，id 与 note.tags 都不动
        if spec.to_two {
            let mut am = tag_two::ActiveModel {
                id: Set(spec.id),
                tag_one_id: Set(spec.father_id),
                ..Default::default()
            };
            am.name = Set(new_title.clone());
            am.color = Set(new_color.clone());
            am.update(db).await.map_err(|e| {
                tracing::error!("移动标签：更新二级标签 {} 失败: {e}", spec.id);
                "移动失败（更新标签出错）".to_string()
            })?;
        } else {
            let mut am =
                tag_one::ActiveModel { id: Set(spec.id), ..Default::default() };
            am.name = Set(new_title.clone());
            am.color = Set(new_color.clone());
            am.update(db).await.map_err(|e| {
                tracing::error!("移动标签：更新一级标签 {} 失败: {e}", spec.id);
                "移动失败（更新标签出错）".to_string()
            })?;
        }
    } else if spec.to_two {
        // 降级 一→二：先插新行再删旧行（插失败则什么都没发生）
        let mut am = tag_two::ActiveModel {
            tag_one_id: Set(spec.father_id),
            name: Set(new_title.clone()),
            color: Set(new_color.clone()),
            // level 列全仓无读取方（层级一律由接口来源携带），原值照搬，不编也不维护
            level: Set(old_level_col),
            ..Default::default()
        };
        if keep_id {
            am.id = Set(spec.id);
        }
        let r = tag_two::Entity::insert(am).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：降级插入二级标签失败: {e}");
            "移动失败（写入二级标签出错）".to_string()
        })?;
        to_id = if keep_id { spec.id } else { r.last_insert_id };
        tag_one::Entity::delete_by_id(spec.id).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：降级删除一级标签 {} 失败: {e}", spec.id);
            "移动失败（删除原一级标签出错）".to_string()
        })?;
        if to_id != spec.id {
            rewritten = swap_tag_refs(db, spec.id, to_id).await.map_err(|e| {
                tracing::error!("移动标签：改写 note.tags 失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        }
    } else {
        // 升级 二→一
        let mut am = tag_one::ActiveModel {
            name: Set(new_title.clone()),
            color: Set(new_color.clone()),
            level: Set(old_level_col),
            ..Default::default()
        };
        if keep_id {
            am.id = Set(spec.id);
        }
        let r = tag_one::Entity::insert(am).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：升级插入一级标签失败: {e}");
            "移动失败（写入一级标签出错）".to_string()
        })?;
        to_id = if keep_id { spec.id } else { r.last_insert_id };
        tag_two::Entity::delete_by_id(spec.id).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：升级删除二级标签 {} 失败: {e}", spec.id);
            "移动失败（删除原二级标签出错）".to_string()
        })?;
        if to_id != spec.id {
            rewritten = swap_tag_refs(db, spec.id, to_id).await.map_err(|e| {
                tracing::error!("移动标签：改写 note.tags 失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        }
    }

    // ⑥ 只提示、不拒绝：三张表都没有 UNIQUE(name)，建的时候允许重名，移动忽然变严会把管理员
    //    卡在一个没有出路的状态（"同名父子"在标签体系里是常见意图）。
    let mut warnings = Vec::new();
    if spec.to_two {
        if let Some(f) = father.as_ref() {
            if f.name == new_title {
                warnings.push(format!(
                    "目标父标签与它同名，标签会显示成「{} / {}」",
                    f.name, new_title
                ));
            }
            match tag_two::Entity::find()
                .filter(tag_two::Column::TagOneId.eq(f.id))
                .filter(tag_two::Column::Name.eq(new_title.clone()))
                .all(db)
                .await
            {
                Ok(sibs) => {
                    if sibs.iter().any(|s| s.id != to_id) {
                        warnings.push(format!(
                            "「{}」下已经有一个叫「{}」的二级标签，两者在选择器里会无法区分",
                            f.name, new_title
                        ));
                    }
                }
                Err(e) => tracing::warn!("移动标签：检查同名兄弟失败: {e}"),
            }
        }
    }

    Ok(MoveTagResult {
        from_level: spec.from_code().to_string(),
        from_id: spec.id,
        to_level: spec.to_code().to_string(),
        to_id,
        id_changed: to_id != spec.id,
        father_key: father.as_ref().map(|f| f.id),
        father_title: father.as_ref().map(|f| f.name.clone()),
        child_count: children.len() as i64,
        affected_notes: affected,
        rewritten_notes: rewritten,
        warnings,
    })
}

pub async fn move_tag(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<MoveTagRequest>,
) -> Json<ApiResponse<MoveTagResult>> {
    let spec = match parse_move(
        &payload.level,
        payload.id,
        payload.to_level.as_deref(),
        payload.father_id,
        payload.title.as_deref(),
        payload.color.as_deref(),
    ) {
        Ok(s) => s,
        Err(msg) => return Json(ApiResponse::error(&msg)),
    };

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("移动标签：开启事务失败: {e}");
            return Json(ApiResponse::error("移动失败（数据库不可用）"));
        }
    };

    match do_move(&txn, &spec).await {
        Ok(mut result) => {
            if let Err(e) = txn.commit().await {
                tracing::error!("移动标签：提交失败: {e}");
                return Json(ApiResponse::error("移动失败（提交事务出错，改动已回滚）"));
            }
            // 提交后回读：newId 路径上"扫全表 → 逐行写"与并发写入之间有窗口，残留的旧 id
            // 会渲染成空白标签块。**如实记进 warnings**，不假装没发生。
            if result.id_changed {
                if let Ok(left) = notes_referencing(&state.db, spec.id).await {
                    if !left.is_empty() {
                        tracing::error!(
                            "移动标签：提交后仍有 {} 行引用旧 id={}",
                            left.len(),
                            spec.id
                        );
                        result.warnings.push(format!(
                            "有 {} 篇文章的标签引用没能改写（移动期间的并发写入），需要人工核对",
                            left.len()
                        ));
                    }
                }
            }
            tracing::info!(
                "移动标签：{}#{} → {}#{}｜父={:?}｜引用 {} 行、改写 {} 行｜警告 {}",
                result.from_level,
                result.from_id,
                result.to_level,
                result.to_id,
                result.father_key,
                result.affected_notes,
                result.rewritten_notes,
                result.warnings.len()
            );
            Json(ApiResponse::success(result))
        }
        Err(msg) => {
            let _ = txn.rollback().await;
            Json(ApiResponse::error(&msg))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 重映射不吃前缀陷阱() {
        // 1→12：改完与既有的 12 合并（去重）
        assert_eq!(remap_tag_ids("1,12", 1, 12).as_deref(), Some("12"));
        // 改 12 不许碰 1
        assert_eq!(remap_tag_ids("1,12", 12, 13).as_deref(), Some("1,13"));
        assert_eq!(remap_tag_ids("21,1", 1, 12).as_deref(), Some("21,12"));
        assert_eq!(remap_tag_ids("13,1", 13, 1).as_deref(), Some("1"));
    }

    #[test]
    fn 无关的行一个字节都不动() {
        assert_eq!(remap_tag_ids("2,3", 1, 12), None);
        assert_eq!(remap_tag_ids("", 1, 12), None);
        assert_eq!(remap_tag_ids("12,21", 1, 12), None);
    }

    #[test]
    fn 脏值与原地不动() {
        assert_eq!(remap_tag_ids("1,,", 1, 12).as_deref(), Some("12"));
        assert_eq!(remap_tag_ids("abc,1", 1, 12).as_deref(), Some("12"));
        assert_eq!(remap_tag_ids(" 1 ,2", 1, 12).as_deref(), Some("12,2"));
        // 原地不动 ⇒ 不写
        assert_eq!(remap_tag_ids("1,2", 1, 1), None);
        // 但"原地不动"遇上重复 id 仍是变化（去重是该函数的既定职责，库里真有 id 写两遍的行）
        assert_eq!(remap_tag_ids("1,1", 1, 1).as_deref(), Some("1"));
    }

    #[test]
    fn 引用判据与重映射同源() {
        assert!(note_refs_tag("12,1", 1));
        assert!(note_refs_tag("1", 1));
        assert!(!note_refs_tag("12,21", 1));
        assert!(!note_refs_tag("", 1));
        assert!(!note_refs_tag("abc", 1));
    }

    #[test]
    fn 入参校验() {
        // 层级词表
        assert!(parse_move("three", 1, None, None, None, None).is_err());
        assert!(parse_move("two", 1, Some("x"), Some(10), None, None).is_err());
        // 二级必须有父、一级不许有父
        assert_eq!(
            parse_move("one", 1, Some("two"), None, None, None).unwrap_err(),
            "移动到二级必须给出目标父标签"
        );
        assert_eq!(
            parse_move("two", 1, Some("one"), Some(10), None, None).unwrap_err(),
            "一级标签没有父标签"
        );
        // 自环（CASCADE 静默删行的触发条件）
        assert_eq!(
            parse_move("one", 10, Some("two"), Some(10), None, None).unwrap_err(),
            "不能把标签挂到它自己下面"
        );
        // 空标题
        assert_eq!(
            parse_move("one", 1, None, None, Some("  "), None).unwrap_err(),
            "标签名不能为空"
        );
        // 缺 toLevel = 同层（换父级）
        let s = parse_move("two", 5, None, Some(11), Some("X"), None).unwrap();
        assert!(!s.crosses());
        assert!(s.to_two);
        assert_eq!(s.father_id, Some(11));
        // 跨层
        let s = parse_move("one", 11, Some("two"), Some(10), None, None).unwrap();
        assert!(s.crosses());
        assert_eq!(s.from_code(), "one");
        assert_eq!(s.to_code(), "two");
    }

    #[test]
    // 名字里那个大写 B 会撞 non_snake_case ⇒ CI 里是 -D warnings 硬门（cargo test 编译
    // 测试目标时才暴露——此前 CI 只 cargo build，测试代码从没被编译过）
    fn id_策略的条件_b() {
        // 同层恒可沿用
        assert!(keep_id_allowed(true, true, 10_005));
        assert!(keep_id_allowed(false, false, 11));
        // 一→二恒真（一级 id 全 < 10000 < tag_two 计数器）
        assert!(keep_id_allowed(false, true, 11));
        // 二→一：历史二级（<10000）安全，20260919 后新建的（≥10000）走新分配
        assert!(keep_id_allowed(true, false, 5));
        assert!(!keep_id_allowed(true, false, 10_000));
        assert!(!keep_id_allowed(true, false, 10_005));
    }

    #[test]
    fn 层级词表() {
        assert_eq!(parse_level("one"), Some(false));
        assert_eq!(parse_level("two"), Some(true));
        assert_eq!(parse_level("1"), None);
        assert_eq!(parse_level(""), None);
    }
}
