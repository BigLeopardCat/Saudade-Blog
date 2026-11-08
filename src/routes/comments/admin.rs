//! Bounded administrator comment reads; authorization remains in the protected router.

use crate::{
    entity::{note, note_comment, user},
    routes::{
        moderation::{page_window, ReviewStatus},
        AppState,
    },
    utils::ApiResponsePage,
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait, Select,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

#[derive(Serialize)]
pub struct CommentAdminDto {
    pub id: i32,
    #[serde(rename = "noteId")]
    pub note_id: i32,
    #[serde(rename = "noteTitle")]
    pub note_title: String,
    pub content: String,
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub username: String,
    pub nickname: String,
    #[serde(rename = "replyToNickname")]
    pub reply_to_nickname: Option<String>,
    #[serde(rename = "createTime")]
    pub created_at: String,
    pub approved: i16,
    #[serde(rename = "aiResult")]
    pub ai_result: Option<String>,
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
    #[serde(rename = "aiReason")]
    pub ai_reason: Option<String>,
    #[serde(rename = "isDeleted")]
    pub is_deleted: i16,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentOrder {
    Asc,
    #[default]
    Desc,
}

#[derive(Deserialize)]
pub struct CommentAdminQuery {
    pub id: Option<i32>,
    pub status: Option<ReviewStatus>,
    pub deleted: Option<bool>,
    pub q: Option<String>,
    pub note_id: Option<i32>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    #[serde(default)]
    pub sort: CommentOrder,
}

pub(crate) fn comment_admin_filter(q: &CommentAdminQuery) -> Select<note_comment::Entity> {
    let mut finder = note_comment::Entity::find();
    if let Some(id) = q.id {
        finder = finder.filter(note_comment::Column::Id.eq(id));
    }
    if let Some(status) = q.status {
        finder = finder.filter(note_comment::Column::Approved.eq(status.approved()));
    }
    if let Some(deleted) = q.deleted {
        finder = finder.filter(if deleted {
            note_comment::Column::IsDeleted.ne(0)
        } else {
            note_comment::Column::IsDeleted.eq(0)
        });
    }
    if let Some(id) = q.note_id {
        finder = finder.filter(note_comment::Column::NoteId.eq(id));
    }
    if let Some(kw) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let pat = format!("%{}%", crate::search_core::like_escape(kw));
        let authors = user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .filter(
                Condition::any()
                    .add(user::Column::Username.into_expr().ilike(&pat))
                    .add(user::Column::Nickname.into_expr().ilike(&pat)),
            )
            .into_query();
        let notes = note::Entity::find()
            .select_only()
            .column(note::Column::Id)
            .filter(note::Column::Title.into_expr().ilike(&pat))
            .into_query();
        finder = finder.filter(
            Condition::any()
                .add(note_comment::Column::Content.into_expr().ilike(&pat))
                .add(note_comment::Column::UserId.in_subquery(authors))
                .add(note_comment::Column::NoteId.in_subquery(notes)),
        );
    }
    match q.sort {
        CommentOrder::Asc => finder
            .order_by_asc(note_comment::Column::CreatedAt)
            .order_by_asc(note_comment::Column::Id),
        CommentOrder::Desc => finder
            .order_by_desc(note_comment::Column::CreatedAt)
            .order_by_desc(note_comment::Column::Id),
    }
}

fn window(q: &CommentAdminQuery) -> Result<(u64, u64), &'static str> {
    if q.q.as_deref().is_some_and(|s| s.chars().count() > 120) {
        return Err("搜索词不能超过120个字符");
    }
    page_window(q.page, Some(q.page_size.unwrap_or(20)))?.ok_or("缺少分页参数")
}

async fn read_page<C: ConnectionTrait>(
    db: &C,
    q: &CommentAdminQuery,
    size: u64,
    offset: u64,
) -> Result<(Vec<CommentAdminDto>, i64), DbErr> {
    let total = comment_admin_filter(q).count(db).await? as i64;
    let rows = comment_admin_filter(q)
        .limit(size)
        .offset(offset)
        .all(db)
        .await?;
    let mut uids: Vec<i32> = rows.iter().map(|c| c.user_id).collect();
    uids.extend(rows.iter().filter_map(|c| c.reply_to_uid));
    uids.sort_unstable();
    uids.dedup();
    let peers: HashMap<i32, (String, String)> = if uids.is_empty() {
        HashMap::new()
    } else {
        user::Entity::find()
            .select_only()
            .column(user::Column::Id)
            .column(user::Column::Username)
            .column(user::Column::Nickname)
            .filter(user::Column::Id.is_in(uids))
            .into_tuple::<(i32, String, String)>()
            .all(db)
            .await?
            .into_iter()
            .map(|(id, username, nickname)| {
                let name = if nickname.trim().is_empty() {
                    username.clone()
                } else {
                    nickname
                };
                (id, (name, username))
            })
            .collect()
    };
    let mut note_ids: Vec<i32> = rows.iter().map(|c| c.note_id).collect();
    note_ids.sort_unstable();
    note_ids.dedup();
    let titles: HashMap<i32, String> = if note_ids.is_empty() {
        HashMap::new()
    } else {
        note::Entity::find()
            .select_only()
            .column(note::Column::Id)
            .column(note::Column::Title)
            .filter(note::Column::Id.is_in(note_ids))
            .into_tuple::<(i32, String)>()
            .all(db)
            .await?
            .into_iter()
            .collect()
    };
    let dtos = rows
        .into_iter()
        .map(|c| {
            let (nickname, username) = peers
                .get(&c.user_id)
                .cloned()
                .unwrap_or_else(|| (format!("用户#{}", c.user_id), String::new()));
            CommentAdminDto {
                id: c.id,
                note_id: c.note_id,
                note_title: titles.get(&c.note_id).cloned().unwrap_or_default(),
                content: c.content,
                user_id: c.user_id,
                username,
                nickname,
                reply_to_nickname: c
                    .reply_to_uid
                    .and_then(|u| peers.get(&u).map(|p| p.0.clone())),
                created_at: c.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
                approved: c.approved,
                ai_result: c.ai_result,
                reject_reason: c.reject_reason,
                ai_reason: c.ai_reason,
                is_deleted: c.is_deleted,
            }
        })
        .collect();
    Ok((dtos, total))
}

pub async fn list_comments_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<CommentAdminQuery>,
) -> Json<ApiResponsePage<Vec<CommentAdminDto>>> {
    let Some(_uid) = crate::routes::talks::current_uid(&state.db, &headers).await else {
        return Json(ApiResponsePage::error("请先登录"));
    };
    let (size, offset) = match window(&q) {
        Ok(value) => value,
        Err(message) => return Json(ApiResponsePage::error(message)),
    };
    match read_page(&state.db, &q, size, offset).await {
        Ok((rows, total)) => Json(ApiResponsePage::success(rows, Some(total))),
        Err(error) => {
            tracing::error!(%error, "administrator comment page read failed");
            Json(ApiResponsePage::error("查询失败，请稍后再试"))
        }
    }
}

#[cfg(test)]
mod tests;
