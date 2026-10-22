//! Guarded article state changes; content editing stays in the editor API.

use crate::{entity::note, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    Json,
};
use chrono::SubsecRound;
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Default, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: i32,
    pub title: String,
    pub status: Option<String>,
    pub is_public: bool,
    pub is_top: Option<i32>,
    pub version: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Public,
    Private,
    Draft,
}
impl Status {
    fn word(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
            Self::Draft => "draft",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub status: Option<Status>,
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub state: Target,
}

const VERSION:&str="encode(sha256(convert_to(jsonb_build_array(id,title,status,is_public,is_top,draft_of,user_id,category_id,content,updated_at)::text,'UTF8')),'hex')";

pub(super) async fn read<C: ConnectionTrait>(db: &C, id: i32, lock: bool) -> Result<Target, DbErr> {
    let mut query = note::Entity::find_by_id(id)
        .filter(note::Column::DraftOf.is_null())
        .select_only()
        .columns([
            note::Column::Id,
            note::Column::Title,
            note::Column::Status,
            note::Column::IsPublic,
            note::Column::IsTop,
        ])
        .column_as(Expr::cust(VERSION), "version");
    if lock {
        query = query.lock_exclusive();
    }
    query
        .into_model::<Target>()
        .one(db)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("article is missing or is an editor shadow".into()))
}

fn validate(id: i32, change: &Change) -> Result<(), DbErr> {
    if id <= 0
        || change.version.len() != 64
        || !change.version.bytes().all(|b| b.is_ascii_hexdigit())
        || (change.status.is_none() && change.is_top.is_none())
        || change.is_top.is_some_and(|top| top != 0 && top != 1)
    {
        return Err(DbErr::Custom("invalid article state change".into()));
    }
    Ok(())
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    id: i32,
    change: &Change,
) -> Result<Outcome, DbErr> {
    validate(id, change)?;
    let before = read(db, id, true).await?;
    if before.version != change.version {
        return Err(DbErr::Custom(
            "article changed; read and confirm again".into(),
        ));
    }
    let mut status = before.status.clone();
    let mut public = before.is_public;
    if let Some(value) = change.status {
        let same_public =
            value.word() == "public" && matches!(status.as_deref(), Some("public" | "published"));
        if !same_public {
            status = Some(value.word().to_owned());
        }
        public = matches!(value, Status::Public);
    }
    let top = change.is_top.or(before.is_top);
    let changed = status != before.status || public != before.is_public || top != before.is_top;
    if changed {
        let now = chrono::Local::now().naive_local().trunc_subsecs(6);
        let update = note::ActiveModel {
            status: Set(status),
            is_public: Set(public),
            is_top: Set(top),
            updated_at: Set(now),
            ..Default::default()
        };
        let result = note::Entity::update_many()
            .set(update)
            .filter(note::Column::Id.eq(id))
            .filter(note::Column::DraftOf.is_null())
            .exec(db)
            .await?;
        if result.rows_affected != 1 {
            return Err(DbErr::Custom("article update was not applied".into()));
        }
    }
    let state = if changed {
        read(db, id, false).await?
    } else {
        before
    };
    Ok(Outcome {
        changed,
        before_version: change.version.clone(),
        state,
    })
}

fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("article state request failed: {error}");
            Json(ApiResponse::error(
                "文章不存在、已变化或读取失败，请重新核对后确认",
            ))
        }
    }
}

pub async fn target(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<Target>> {
    if id <= 0 {
        return Json(ApiResponse::error("文章编号无效"));
    }
    response(read(&state.db, id, false).await)
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(params): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    if let Err(error) = validate(id, &params) {
        return response(Err(error));
    }
    let result = async {
        let txn = state.db.begin().await?;
        let value = apply(&txn, id, &params).await?;
        txn.commit().await?;
        Ok(value)
    }
    .await;
    response(result)
}

#[cfg(test)]
mod tests;
