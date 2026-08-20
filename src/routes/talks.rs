use axum::{Json, extract::{State, Path}};
use sea_orm::{EntityTrait, Set, QueryOrder};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::talk;
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Serialize)]
pub struct TalkDto {
    #[serde(rename = "talkKey")]
    pub id: i32,
    #[serde(rename = "talkTitle")]
    pub title: String,
    pub content: String,
    pub cat: String,
    pub v: i32,
    pub author: String,
    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "updateTime")]
    pub updated_at: String,
}

pub async fn list_talks(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<TalkDto>>> {
    let talks = talk::Entity::find().order_by_desc(talk::Column::CreatedAt).all(&state.db).await.unwrap_or(vec![]);
    let dtos = talks.into_iter().map(|t| TalkDto {
        id: t.id,
        title: t.title.unwrap_or_default(),
        content: t.content,
        cat: t.cat,
        v: t.v as i32,
        author: t.author,
        created_at: t.created_at.and_utc().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: t.updated_at.and_utc().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).format("%Y-%m-%d %H:%M:%S").to_string(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertTalk {
    #[serde(rename = "talkTitle")]
    title: String,
    content: String,
    // 河灯留言：印章类型（愿/寄/忆/诉）与灯型（0 莲花 / 1 八角 / 2 圆笼）
    #[serde(default)]
    cat: String,
    #[serde(default)]
    v: i8,
    // 留名（灯影集"按账户"分组用，可空）
    #[serde(default)]
    author: String,
}

pub async fn create_talk(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    // 河灯留言：匿名公开提交，做基础校验防滥用（长度封顶 + 印章/灯型白名单）
    let content = payload.content.trim();
    let cat = match payload.cat.as_str() {
        "愿" | "寄" | "忆" | "诉" => payload.cat,
        _ => "愿".to_string(),
    };
    let v = match payload.v {
        0..=2 => payload.v,
        _ => 0,
    };
    if content.is_empty() {
        return Json(ApiResponse::error("留言不能为空"));
    }
    if content.chars().count() > 500 {
        return Json(ApiResponse::error("留言过长（最多 500 字）"));
    }
    let author = payload.author.trim();
    let author = if author.chars().count() > 20 {
        author.chars().take(20).collect::<String>()
    } else {
        author.to_string()
    };
    let t = talk::ActiveModel {
        title: Set(Some(cat.clone())),
        content: Set(content.to_string()),
        cat: Set(cat),
        v: Set(v),
        author: Set(author),
        created_at: Set(chrono::Utc::now().naive_utc()),
        updated_at: Set(chrono::Utc::now().naive_utc()),
        ..Default::default()
    };
    talk::Entity::insert(t).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Created".to_string()))
}

pub async fn delete_talk(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<String>> {
    talk::Entity::delete_by_id(id).exec(&state.db).await.unwrap();
    Json(ApiResponse::success("Deleted".to_string()))
}

pub async fn update_talk(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertTalk>,
) -> Json<ApiResponse<String>> {
    let talk_model = talk::Entity::find_by_id(id)
        .one(&state.db)
        .await
        .unwrap();

    if let Some(t) = talk_model {
        let mut active_model: talk::ActiveModel = t.into();
        active_model.title = Set(Some(payload.title));
        active_model.content = Set(payload.content);
        active_model.updated_at = Set(chrono::Utc::now().naive_utc());
        
        talk::Entity::update(active_model).exec(&state.db).await.unwrap();
        Json(ApiResponse::success("Updated".to_string()))
    } else {
        Json(ApiResponse { code: 404, message: "Talk not found".to_string(), data: String::default() })
    }
}