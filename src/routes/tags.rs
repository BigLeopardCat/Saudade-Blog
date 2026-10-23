use crate::entity::{tag_one, tag_two};
use crate::routes::{note_tags, AppState};
use crate::utils::ApiResponse;
use axum::{extract::State, Json};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
pub struct TagOneDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    #[serde(rename = "noteCount")]
    pub note_count: i64,
}

#[derive(Serialize)]
pub struct TagTwoDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
    #[serde(rename = "fatherTag")]
    pub father_tag: String,
    #[serde(rename = "fatherKey")]
    pub father_key: Option<i32>,
    #[serde(rename = "noteCount")]
    pub note_count: i64,
}

pub async fn list_tags_one(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagOneDto>>> {
    let counts = super::note_tags::public_tag_counts(&state.db).await;
    let t1s = tag_one::Entity::find()
        .all(&state.db)
        .await
        .unwrap_or(vec![]);
    let dtos = t1s
        .into_iter()
        .map(|t| TagOneDto {
            id: t.id,
            title: t.name,
            color: t.color.unwrap_or_default(),
            level: 1,
            note_count: counts.get(&t.id).copied().unwrap_or(0),
        })
        .collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_tags_two(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagTwoDto>>> {
    let counts = super::note_tags::public_tag_counts(&state.db).await;
    let t2s = tag_two::Entity::find()
        .find_with_related(tag_one::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dtos = t2s
        .into_iter()
        .map(|(t2, t1s)| {
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
        })
        .collect();

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

#[derive(Deserialize)]
pub struct DeleteTagsRequest {
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

    let affected = match note_tags::note_ids_with_tags(&state.db, &ids, in_two).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("删除标签：统计引用失败: {e}");
            return Json(ApiResponse::error("删除失败（统计文章引用出错）"));
        }
    };

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("删除标签：开启事务失败: {e}");
            return Json(ApiResponse::error("删除失败（数据库不可用）"));
        }
    };

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
        return Json(ApiResponse::error(
            "删除失败（改写文章标签引用出错，改动已回滚）",
        ));
    }
    if let Err(e) = txn.commit().await {
        tracing::error!("删除标签：提交失败: {e}");
        return Json(ApiResponse::error("删除失败（提交事务出错，改动已回滚）"));
    }

    Json(ApiResponse::success("Deleted".to_string()))
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

fn parse_level(s: &str) -> Option<bool> {
    match s {
        "one" => Some(false),
        "two" => Some(true),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct MoveTagRequest {
    pub level: String,
    pub id: i32,
    #[serde(default, rename = "toLevel")]
    pub to_level: Option<String>,
    #[serde(default, rename = "fatherTag")]
    pub father_id: Option<i32>,
    #[serde(default)]
    pub title: Option<String>,
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
    #[serde(rename = "idChanged")]
    pub id_changed: bool,
    #[serde(rename = "fatherKey")]
    pub father_key: Option<i32>,
    #[serde(rename = "fatherTitle")]
    pub father_title: Option<String>,
    #[serde(rename = "childCount")]
    pub child_count: i64,
    #[serde(rename = "affectedNotes")]
    pub affected_notes: i64,
    #[serde(rename = "rewrittenNotes")]
    pub rewritten_notes: u64,
    pub warnings: Vec<String>,
}

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
    fn crosses(&self) -> bool {
        self.from_two != self.to_two
    }

    fn from_code(&self) -> &'static str {
        if self.from_two {
            "two"
        } else {
            "one"
        }
    }

    fn to_code(&self) -> &'static str {
        if self.to_two {
            "two"
        } else {
            "one"
        }
    }
}

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
    if !from_two && to_two && father_id == Some(id) {
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

async fn do_move<C: ConnectionTrait>(db: &C, spec: &MoveSpec) -> Result<MoveTagResult, String> {
    // The row lock also prevents new FK references while changing identity.
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

    let father = if spec.to_two {
        match spec.father_id {
            Some(fid) => match tag_one::Entity::find_by_id(fid).one(db).await {
                Ok(Some(f)) => Some(f),
                Ok(None) => return Err("目标父标签不存在（父必须是一级标签）".to_string()),
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
        let more = if children.len() > shown.len() {
            "…"
        } else {
            ""
        };
        return Err(format!(
            "「{old_name}」下还有 {} 个二级标签（{}{}），请先把它们移走或删除",
            children.len(),
            shown.join("、"),
            more
        ));
    }

    let affected = note_tags::note_ids_with_tag(db, spec.id, spec.from_two)
        .await
        .map_err(|e| {
            tracing::error!("移动标签：统计引用失败: {e}");
            "移动失败（统计文章引用出错）".to_string()
        })?
        .len() as i64;

    let new_title = spec.title.clone().unwrap_or_else(|| old_name.clone());
    let new_color = spec.color.clone().or_else(|| old_color.clone());
    let mut to_id = spec.id;
    let mut rewritten = 0u64;

    if !spec.crosses() {
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
            let mut am = tag_one::ActiveModel {
                id: Set(spec.id),
                ..Default::default()
            };
            am.name = Set(new_title.clone());
            am.color = Set(new_color.clone());
            am.update(db).await.map_err(|e| {
                tracing::error!("移动标签：更新一级标签 {} 失败: {e}", spec.id);
                "移动失败（更新标签出错）".to_string()
            })?;
        }
    } else if spec.to_two {
        let am = tag_two::ActiveModel {
            tag_one_id: Set(spec.father_id),
            name: Set(new_title.clone()),
            color: Set(new_color.clone()),
            level: Set(old_level_col),
            ..Default::default()
        };
        let r = tag_two::Entity::insert(am).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：降级插入二级标签失败: {e}");
            "移动失败（写入二级标签出错）".to_string()
        })?;
        to_id = r.last_insert_id;
        // Move typed references before deleting the source with ON DELETE CASCADE.
        rewritten = note_tags::move_tag_refs(db, spec.id, spec.from_two, to_id)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：改指向失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        tag_one::Entity::delete_by_id(spec.id)
            .exec(db)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：降级删除一级标签 {} 失败: {e}", spec.id);
                "移动失败（删除原一级标签出错）".to_string()
            })?;
    } else {
        let am = tag_one::ActiveModel {
            name: Set(new_title.clone()),
            color: Set(new_color.clone()),
            level: Set(old_level_col),
            ..Default::default()
        };
        let r = tag_one::Entity::insert(am).exec(db).await.map_err(|e| {
            tracing::error!("移动标签：升级插入一级标签失败: {e}");
            "移动失败（写入一级标签出错）".to_string()
        })?;
        to_id = r.last_insert_id;
        // Move typed references before deleting the source with ON DELETE CASCADE.
        rewritten = note_tags::move_tag_refs(db, spec.id, spec.from_two, to_id)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：改指向失败: {e}");
                "移动失败（改写文章标签引用出错）".to_string()
            })?;
        tag_two::Entity::delete_by_id(spec.id)
            .exec(db)
            .await
            .map_err(|e| {
                tracing::error!("移动标签：升级删除二级标签 {} 失败: {e}", spec.id);
                "移动失败（删除原二级标签出错）".to_string()
            })?;
    }

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

pub(crate) async fn move_in_transaction<C: ConnectionTrait>(
    db: &C,
    request: &MoveTagRequest,
) -> Result<MoveTagResult, String> {
    let spec = parse_move(
        &request.level,
        request.id,
        request.to_level.as_deref(),
        request.father_id,
        request.title.as_deref(),
        request.color.as_deref(),
    )?;
    do_move(db, &spec).await
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
            if result.id_changed {
                if let Ok(left) =
                    note_tags::note_ids_with_tag(&state.db, spec.id, spec.from_two).await
                {
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
    fn 入参校验() {
        assert!(parse_move("three", 1, None, None, None, None).is_err());
        assert!(parse_move("two", 1, Some("x"), Some(10), None, None).is_err());
        assert_eq!(
            parse_move("one", 1, Some("two"), None, None, None).unwrap_err(),
            "移动到二级必须给出目标父标签"
        );
        assert_eq!(
            parse_move("two", 1, Some("one"), Some(10), None, None).unwrap_err(),
            "一级标签没有父标签"
        );
        assert_eq!(
            parse_move("one", 10, Some("two"), Some(10), None, None).unwrap_err(),
            "不能把标签挂到它自己下面"
        );
        assert_eq!(
            parse_move("one", 1, None, None, Some("  "), None).unwrap_err(),
            "标签名不能为空"
        );
        assert!(parse_move("two", 10, None, Some(10), None, None).is_ok());
        let s = parse_move("two", 5, None, Some(11), Some("X"), None).unwrap();
        assert!(!s.crosses());
        assert!(s.to_two);
        assert_eq!(s.father_id, Some(11));
        let s = parse_move("one", 11, Some("two"), Some(10), None, None).unwrap();
        assert!(s.crosses());
        assert_eq!(s.from_code(), "one");
        assert_eq!(s.to_code(), "two");
    }

    #[test]
    fn 层级词表() {
        assert_eq!(parse_level("one"), Some(false));
        assert_eq!(parse_level("two"), Some(true));
        assert_eq!(parse_level("1"), None);
        assert_eq!(parse_level(""), None);
    }
}
