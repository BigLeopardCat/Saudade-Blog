use axum::{Json, extract::State};
use sea_orm::{
    EntityTrait, ColumnTrait, QueryFilter, QuerySelect, Set, ActiveModelTrait,
    ConnectionTrait, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{tag_one, tag_two};
use crate::routes::{note_tags, AppState};
use crate::utils::ApiResponse;

// 「每个标签的公开可见文章数」的实现 20261018 搬到了 `routes/note_tags.rs`
// （`public_tag_counts`）：口径从 `note.tags` 那列逗号串改成了 `note_tag` 关联表，
// 而那张表**只许那一个模块碰**（见它的模块头注）。口径本身一个字没变：
// `is_public = true` 且 status 在白名单里，同一篇里重复出现的标签只算一次。

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
    let counts = super::note_tags::public_tag_counts(&state.db).await;
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
     let counts = super::note_tags::public_tag_counts(&state.db).await;
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

    let in_two = match payload.level.as_str() {
        "one" => false,
        "two" => true,
        other => {
            tracing::warn!("删除标签收到非法 level: {other}");
            return Json(ApiResponse::error("标签层级不合法"));
        }
    };

    // ⚠️ **受影响文章必须在删之前记下来**：关联行由外键跟着标签一起走（CASCADE），
    // 删完就再也问不出"谁挂过它" —— 而 `note.tags` 那一列还得按关联表重算
    // （soak 期两处同源，见 `note_tags::resync_tags_column` 头注）。
    let affected = match note_tags::note_ids_with_tags(&state.db, &ids, in_two).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("删除标签：统计引用失败: {e}");
            return Json(ApiResponse::error("删除失败（统计文章引用出错）"));
        }
    };

    // 删标签与"重算那一列"放进同一个事务：重算失败就整个回滚，管理员看到的是"删除失败、
    // 什么都没发生"。分开做的话会出现"标签真删了、镜像列悄悄陈旧"——那正是 `0007` 的预检
    // 之后要拦的东西，而到那时已经没人知道它是怎么变陈旧的。
    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("删除标签：开启事务失败: {e}");
            return Json(ApiResponse::error("删除失败（数据库不可用）"));
        }
    };

    // 子标签由 FK `tag_two.tag_one_id → tag_one.id` 的 ON DELETE CASCADE 一起删。
    let del = if in_two {
        tag_two::Entity::delete_many()
            .filter(tag_two::Column::Id.is_in(ids))
            .exec(&txn)
            .await
    } else {
        tag_one::Entity::delete_many()
            .filter(tag_one::Column::Id.is_in(ids))
            .exec(&txn)
            .await
    };
    if let Err(e) = del {
        let _ = txn.rollback().await;
        tracing::error!("删除标签失败: {e}");
        return Json(ApiResponse::error("删除失败"));
    }

    if let Err(e) = note_tags::resync_tags_column(&txn, &affected).await {
        let _ = txn.rollback().await;
        tracing::error!("删除标签：重算 note.tags 镜像列失败: {e}");
        return Json(ApiResponse::error("删除失败（改写文章标签引用出错，改动已回滚）"));
    }
    if let Err(e) = txn.commit().await {
        tracing::error!("删除标签：提交失败: {e}");
        return Json(ApiResponse::error("删除失败（提交事务出错，改动已回滚）"));
    }

    // 悬空引用**不再需要手工擦**（20261018）：`note_tag` 的三个外键都是 `ON DELETE CASCADE`，
    // 上面那两条 DELETE 一提交，指向被删标签的关联行就跟着走了。
    // 这里退休的 `prune_note_tags` 是本站最后一处"每删一个标签就扫全表 + 逐行重写"的读放大
    // （它还要把 `note.tags` 那一列整篇重写一遍）。"删了标签文章上还挂着空白标签块"这件事
    // 从"每次记得擦"变成了**结构性不可能**。
    Json(ApiResponse::success("Deleted".to_string()))
}

// `prune_note_tags`（20261018 删除）：它原来负责"删完标签把 `note.tags` 里悬空的 id 摘掉"。
// 关联表的外键 `ON DELETE CASCADE` 接管了这件事，而且是**按列**的、不用扫全表：
// 删一个一级标签，只有指向它的关联行走，同一篇指向二级标签的行原样留着。
//
// ⚠️ 这条差异值得单独记一笔：旧实现是**全表扫 + 按数字判**（"这个 id 在两张表里都不在了就摘"），
// 所以它顺手也会把别的原因造成的悬空一起擦掉；外键只管"我删的这一行"。今天没有别的悬空来路
// （`replace_note_tags` 在写入侧就把查不到的 id 丢掉了，并 WARN）。

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
    /// 实际被改写的关联行数（= 受影响的文章篇数）。**20261018 起语义变了**：它现在是
    /// `note_tag` 上那条 `UPDATE` 的 `rows_affected`，同层移动恒为 0，而跨表移动**恒等于
    /// `affectedNotes`** —— 沿用旧 id 也算改写（id 没变，但**列**从 `tag_one_id` 换成了
    /// `tag_two_id`）。旧实现在这条路上是 0（字符串没变），读这个数的人要改口径。
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

// ── `note.tags` 串的四个字符串助手（20261018 整体删除）─────────────────────
//
// `remap_tag_ids`（按逗号切串、逐片 parse、数值比较、重拼）/ `note_refs_tag` /
// `notes_referencing`（**读全表**再逐行判字符串）/ `swap_tag_refs`（**读全表**再逐行重写
// `note.tags`）—— 这一族的存在理由只是"引用关系住在一个字符串里"。
//
// 关联表落地之后：
//   · 改指向 = 一条 `UPDATE note_tag SET …`（`note_tags::move_tag_refs`）；
//   · 影响面 = 一次 `SELECT note_id … WHERE tag_one_id = …`（`note_tags::note_ids_with_tag`）。
// 两者都走索引、都只碰相关的那几行。`swap_tag_refs` 那条"写回时显式保留 `updated_at`，
// 免得被改写的文章集体跳到列表最前"的纪律**连同它的注释一起退休**：新实现不写 `note` 表
// 一个字，`updated_at` 压根不会被碰（这正是把引用关系搬出 `note` 的一个附带好处）。



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

    // ④ 影响面（预览与改写同源：两边都是"关联表里 tag_?_id = 这个 id 的行数"）
    let affected = note_tags::note_ids_with_tag(db, spec.id, spec.from_two)
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
        // ⚠️ **顺序不能换**：先把关联行改指向、**再**删旧标签行。
        // 反过来的话 `note_tag_one_fk` 的 `ON DELETE CASCADE` 会把它们**静默带走**
        // ——事务照常提交、标签从 API 上消失、没有任何东西报错（这正是本块头注里
        // 那条"唯一的静默删除路径"在关联表上的第二副面孔）。
        // 沿用旧 id 时同样要搬：id 没变，**列变了**（`tag_one_id` → `tag_two_id`）。
        rewritten = note_tags::move_tag_refs(db, spec.id, spec.from_two, to_id)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：改指向失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        tag_one::Entity::delete_by_id(spec.id).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：降级删除一级标签 {} 失败: {e}", spec.id);
            "移动失败（删除原一级标签出错）".to_string()
        })?;
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
        // 顺序同降级那一支：**先改指向、再删旧行**（理由见那边）。
        rewritten = note_tags::move_tag_refs(db, spec.id, spec.from_two, to_id)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：改指向失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        tag_two::Entity::delete_by_id(spec.id).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：升级删除二级标签 {} 失败: {e}", spec.id);
            "移动失败（删除原二级标签出错）".to_string()
        })?;
    }

    // ⑤b 改了 id 的移动必须把 `note.tags` 那一列跟着重算（soak 期两处同源的不变量，
    //     见 `note_tags::resync_tags_column` 头注）。沿用旧 id 时这一列本来就还是对的
    //     （id 一个字节没变），只有 `id_changed` 这一支需要算 —— 而它恰恰是最容易漏的：
    //     旧实现 `swap_tag_refs` 顺手就把串改了，新实现改的是关联表。
    if to_id != spec.id {
        let ids = note_tags::note_ids_with_tag(db, to_id, spec.to_two)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：统计新 id 的引用失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        note_tags::resync_tags_column(db, &ids).await.map_err(|e| {
            tracing::error!("移动标签：重算 note.tags 镜像列失败: {e}");
            "移动失败（改写文章标签引用出错）".to_string()
        })?;
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
            // 提交后回读。20261018 之前这里堵的是一条真实的竞态：旧实现是"扫全表 → 逐行写"，
            // 中间新产生的引用会残留成空白标签块。改走关联表之后这条窗口**结构性关掉了**
            // （改指向与删旧行在同一个事务里，而删完之后 FK 不许任何新行再指向那个 id），
            // 所以这个分支今天是**防御性**的 —— 留着是因为"不会有残留"这件事本身没有别的判据。
            if result.id_changed {
                if let Ok(left) = note_tags::note_ids_with_tag(&state.db, spec.id, spec.from_two).await {
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

    // `重映射不吃前缀陷阱` / `无关的行一个字节都不动` / `脏值与原地不动` /
    // `引用判据与重映射同源` 四条单测随 `remap_tag_ids` / `note_refs_tag` 一起删掉
    // （20261018）：被测的东西不存在了。**解析口径本身没有丢** —— 它搬到了
    // `note_tags::parse_tag_ids`，那边有一组同形的单测（含 `1,1,,` / `12abc` / ` 1 , 2 ` 这些
    // 同一批脏值）。删测试的时候容易顺手把覆盖也删掉，所以这里点一句它搬去哪儿了。

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
