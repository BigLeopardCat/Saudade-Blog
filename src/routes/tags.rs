use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, Set, ActiveModelTrait};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use crate::entity::{note, tag_one, tag_two};
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Serialize)]
pub struct TagOneDto {
    #[serde(rename = "tagKey")]
    pub id: i32,
    pub title: String,
    pub color: String,
    pub level: i32,
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
}

pub async fn list_tags_one(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagOneDto>>> {
    let t1s = tag_one::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    let dtos = t1s.into_iter().map(|t| TagOneDto {
        id: t.id,
        title: t.name,
        color: t.color.unwrap_or_default(),
        level: 1,
    }).collect();
    Json(ApiResponse::success(dtos))
}

pub async fn list_tags_two(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TagTwoDto>>> {
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
