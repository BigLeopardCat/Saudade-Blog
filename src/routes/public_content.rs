//! Browser archive and talk feeds; Agent discovery retains its own compact read contract.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::NaiveDateTime;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationTrait, sea_query::Expr,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    entity::{note, talk, user},
    routes::AppState,
    utils::ApiResponse,
};

#[derive(Default, Deserialize)]
pub struct FeedQuery {
    limit: Option<u64>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct Cursor {
    at: NaiveDateTime,
    id: i32,
}

impl Cursor {
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect("typed feed cursor"))
    }
}

fn window(query: &FeedQuery, default: u64) -> Result<(u64, Option<Cursor>), StatusCode> {
    let limit = query.limit.unwrap_or(default);
    if !(1..=50).contains(&limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query
        .cursor
        .as_ref()
        .map(|value| {
            if value.len() > 128 {
                return Err(StatusCode::BAD_REQUEST);
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            let cursor: Cursor =
                serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
            if cursor.id <= 0 {
                return Err(StatusCode::BAD_REQUEST);
            }
            Ok(cursor)
        })
        .transpose()?;
    Ok((limit, cursor))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(FromQueryResult, Serialize)]
pub struct ArchiveItem {
    #[serde(rename = "noteKey")]
    id: i32,
    #[serde(rename = "noteTitle")]
    title: String,
    #[serde(rename = "createTime")]
    created_at: NaiveDateTime,
}

fn archive_query(cursor: Option<&Cursor>) -> sea_orm::Select<note::Entity> {
    let mut query = note::Entity::find().filter(super::notes::public_condition());
    if let Some(cursor) = cursor {
        query = query.filter(
            Condition::any()
                .add(note::Column::CreatedAt.lt(cursor.at))
                .add(
                    Condition::all()
                        .add(note::Column::CreatedAt.eq(cursor.at))
                        .add(note::Column::Id.lt(cursor.id)),
                ),
        );
    }
    query
        .order_by_desc(note::Column::CreatedAt)
        .order_by_desc(note::Column::Id)
}

async fn archive_page<C: ConnectionTrait>(
    db: &C,
    limit: u64,
    cursor: Option<&Cursor>,
) -> Result<FeedPage<ArchiveItem>, DbErr> {
    let total = note::Entity::find()
        .filter(super::notes::public_condition())
        .count(db)
        .await?;
    let mut items = archive_query(cursor)
        .select_only()
        .columns([
            note::Column::Id,
            note::Column::Title,
            note::Column::CreatedAt,
        ])
        .limit(limit + 1)
        .into_model::<ArchiveItem>()
        .all(db)
        .await?;
    let more = items.len() as u64 > limit;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items.last().map(|row| {
            Cursor {
                at: row.created_at,
                id: row.id,
            }
            .encode()
        })
    } else {
        None
    };
    Ok(FeedPage {
        items,
        next_cursor,
        total: Some(total),
    })
}

pub async fn archive(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FeedQuery>,
) -> Result<Json<ApiResponse<FeedPage<ArchiveItem>>>, StatusCode> {
    let (limit, cursor) = window(&query, 50)?;
    archive_page(&state.db, limit, cursor.as_ref())
        .await
        .map(|page| Json(ApiResponse::success(page)))
        .map_err(|error| {
            tracing::error!("archive read failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })
}

/// Homepage cards use the same stable (created_at, id) cursor as the archive.
fn article_query(cursor: Option<&Cursor>) -> sea_orm::Select<note::Entity> {
    let mut query = note::Entity::find().filter(super::notes::public_condition());
    if let Some(cursor) = cursor {
        query = query.filter(
            Expr::tuple([
                Expr::col((note::Entity, note::Column::CreatedAt)),
                Expr::col((note::Entity, note::Column::Id)),
            ])
            .lt(Expr::tuple([Expr::val(cursor.at), Expr::val(cursor.id)])),
        );
    }
    query
        .order_by_desc(note::Column::CreatedAt)
        .order_by_desc(note::Column::Id)
}

async fn article_page<C: ConnectionTrait>(
    db: &C,
    limit: u64,
    cursor: Option<&Cursor>,
) -> Result<FeedPage<super::notes::NoteSummary>, DbErr> {
    let mut rows = article_query(cursor)
        .into_partial_model::<super::notes::NoteSummary>()
        .limit(limit + 1)
        .all(db)
        .await?;
    let more = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    let next_cursor = if more {
        rows.last().map(|row| {
            Cursor {
                at: row.created_at,
                id: row.id,
            }
            .encode()
        })
    } else {
        None
    };
    Ok(FeedPage {
        items: rows,
        next_cursor,
        total: None,
    })
}

pub async fn article_feed(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FeedQuery>,
) -> Result<Json<ApiResponse<FeedPage<super::notes::NoteDto>>>, StatusCode> {
    let (limit, cursor) = window(&query, 6)?;
    let page = article_page(&state.db, limit, cursor.as_ref())
        .await
        .map_err(|error| {
            tracing::error!("article feed read failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    let items = super::notes::summarize(&state.db, page.items)
        .await
        .map_err(|error| {
            tracing::error!("article feed metadata failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    Ok(Json(ApiResponse::success(FeedPage {
        items,
        next_cursor: page.next_cursor,
        total: None,
    })))
}

#[derive(FromQueryResult)]
struct TalkRow {
    id: i32,
    title: Option<String>,
    content: String,
    user_id: i32,
    nickname: Option<String>,
    username: Option<String>,
    avatar: Option<String>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Serialize)]
pub struct TalkItem {
    #[serde(rename = "talkKey")]
    id: i32,
    #[serde(rename = "talkTitle")]
    title: String,
    content: String,
    nickname: String,
    avatar: Option<String>,
    #[serde(rename = "createTime")]
    created_at: NaiveDateTime,
    #[serde(rename = "updateTime")]
    updated_at: NaiveDateTime,
}

impl From<TalkRow> for TalkItem {
    fn from(row: TalkRow) -> Self {
        let nickname = row
            .nickname
            .filter(|value| !value.trim().is_empty())
            .or(row.username)
            .unwrap_or_else(|| format!("用户#{}", row.user_id));
        Self {
            id: row.id,
            title: row.title.unwrap_or_default(),
            content: row.content,
            nickname,
            avatar: row.avatar,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

fn talk_query(cursor: Option<&Cursor>, id: Option<i32>) -> sea_orm::Select<talk::Entity> {
    let mut query = talk::Entity::find()
        .filter(talk::Column::Src.eq("talk"))
        .filter(talk::Column::Approved.eq(1));
    if let Some(id) = id {
        query = query.filter(talk::Column::Id.eq(id));
    }
    if let Some(cursor) = cursor {
        query = query.filter(
            Condition::any()
                .add(talk::Column::CreatedAt.lt(cursor.at))
                .add(
                    Condition::all()
                        .add(talk::Column::CreatedAt.eq(cursor.at))
                        .add(talk::Column::Id.lt(cursor.id)),
                ),
        );
    }
    query
        .order_by_desc(talk::Column::CreatedAt)
        .order_by_desc(talk::Column::Id)
}

async fn read_talks<C: ConnectionTrait>(
    db: &C,
    limit: u64,
    cursor: Option<&Cursor>,
    id: Option<i32>,
) -> Result<Vec<TalkItem>, DbErr> {
    Ok(talk_query(cursor, id)
        .select_only()
        .columns([
            talk::Column::Id,
            talk::Column::Title,
            talk::Column::Content,
            talk::Column::UserId,
            talk::Column::CreatedAt,
            talk::Column::UpdatedAt,
        ])
        .join(JoinType::LeftJoin, talk::Relation::User.def())
        .column_as(
            Expr::col((user::Entity, user::Column::Nickname)),
            "nickname",
        )
        .column_as(
            Expr::col((user::Entity, user::Column::Username)),
            "username",
        )
        .column_as(Expr::col((user::Entity, user::Column::Avatar)), "avatar")
        .limit(limit)
        .into_model::<TalkRow>()
        .all(db)
        .await?
        .into_iter()
        .map(TalkItem::from)
        .collect())
}

pub async fn talks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FeedQuery>,
) -> Result<Json<ApiResponse<FeedPage<TalkItem>>>, StatusCode> {
    let (limit, cursor) = window(&query, 20)?;
    let mut items = read_talks(&state.db, limit + 1, cursor.as_ref(), None)
        .await
        .map_err(|error| {
            tracing::error!("talk feed read failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    let more = items.len() as u64 > limit;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items.last().map(|row| {
            Cursor {
                at: row.created_at,
                id: row.id,
            }
            .encode()
        })
    } else {
        None
    };
    Ok(Json(ApiResponse::success(FeedPage {
        items,
        next_cursor,
        total: None,
    })))
}

pub async fn talk_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Result<Json<ApiResponse<TalkItem>>, StatusCode> {
    if id <= 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let item = read_talks(&state.db, 1, None, Some(id))
        .await
        .map_err(|error| {
            tracing::error!("talk detail read failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })?
        .into_iter()
        .next()
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(ApiResponse::success(item)))
}

#[cfg(test)]
mod tests;
