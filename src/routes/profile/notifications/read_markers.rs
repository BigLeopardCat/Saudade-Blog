//! Fixed notification selections are locked and committed with their mutation facts.

use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DbErr, DerivePartialModel, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait, TransactionTrait,
};
use serde::Serialize;
use std::sync::Arc;

use crate::{
    entity::user_notification,
    routes::{
        profile::{visibility, ReadRequest},
        AppState,
    },
    utils::ApiResponse,
};

const SELECTION_CONFLICT: &str = "部分通知不存在、已移除或不属于本人；本次未改动";

#[derive(Debug, PartialEq)]
pub(super) enum Selection {
    Selected(Vec<i32>),
    AllUnread,
}

fn selection(request: ReadRequest) -> Result<Selection, DbErr> {
    if request.all {
        return if request.ids.is_empty() {
            Ok(Selection::AllUnread)
        } else {
            Err(DbErr::Custom("通知范围不能同时包含全部和具体编号".into()))
        };
    }
    let mut ids = request.ids;
    if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| *id <= 0) {
        return Err(DbErr::Custom("请指定1至100个有效通知编号".into()));
    }
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(DbErr::Custom("通知编号不能重复".into()));
    }
    Ok(Selection::Selected(ids))
}

#[derive(DerivePartialModel)]
#[sea_orm(entity = "user_notification::Entity", from_query_result)]
struct Locked {
    id: i32,
    is_read: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum ReadReceipt {
    #[serde(rename_all = "camelCase")]
    Selected {
        owner_user_id: i32,
        matched_ids: Vec<i32>,
        changed_ids: Vec<i32>,
        is_read: bool,
        unread_count: u64,
    },
    #[serde(rename_all = "camelCase")]
    AllUnread {
        owner_user_id: i32,
        matched_count: u64,
        changed_count: u64,
        is_read: bool,
        unread_count: u64,
    },
}

fn update(uid: i32) -> sea_orm::UpdateMany<user_notification::Entity> {
    user_notification::Entity::update_many()
        .col_expr(user_notification::Column::IsRead, Expr::value(true))
        .col_expr(
            user_notification::Column::ReadAt,
            Expr::value(Some(chrono::Local::now().naive_local())),
        )
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::IsRead.eq(false))
}

async fn remaining<C: ConnectionTrait>(db: &C, uid: i32) -> Result<u64, DbErr> {
    user_notification::Entity::find()
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::IsRead.eq(false))
        .count(db)
        .await
}

pub(super) async fn selected<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    ids: &[i32],
) -> Result<ReadReceipt, DbErr> {
    let rows = user_notification::Entity::find()
        .filter(visibility::notifications(uid))
        .filter(user_notification::Column::Id.is_in(ids.iter().copied()))
        .order_by_asc(user_notification::Column::Id)
        .lock_exclusive()
        .into_partial_model::<Locked>()
        .all(db)
        .await?;
    let matched: Vec<_> = rows.iter().map(|row| row.id).collect();
    if matched.as_slice() != ids {
        return Err(DbErr::Custom(SELECTION_CONFLICT.into()));
    }
    // These locks protect both ownership and deletion until commit; only unread rows change.
    let mut query = update(uid).filter(user_notification::Column::Id.is_in(ids.iter().copied()));
    QueryTrait::query(&mut query).returning_col(user_notification::Column::Id);
    let returned = db.query_all(query.build(db.get_database_backend())).await?;
    let mut changed: Vec<i32> = returned
        .iter()
        .map(|row| row.try_get("", "id"))
        .collect::<Result<_, _>>()?;
    changed.sort_unstable();
    let expected: Vec<_> = rows
        .iter()
        .filter(|row| !row.is_read)
        .map(|row| row.id)
        .collect();
    if changed != expected {
        return Err(DbErr::Custom("通知变更结果与锁定目标不一致".into()));
    }
    Ok(ReadReceipt::Selected {
        owner_user_id: uid,
        matched_ids: matched,
        changed_ids: changed,
        is_read: true,
        unread_count: remaining(db, uid).await?,
    })
}

pub(super) async fn all_unread<C: ConnectionTrait>(db: &C, uid: i32) -> Result<ReadReceipt, DbErr> {
    // The UI's explicit all-unread request needs counts, never an unbounded RETURNING list.
    let count = update(uid).exec(db).await?.rows_affected;
    Ok(ReadReceipt::AllUnread {
        owner_user_id: uid,
        matched_count: count,
        changed_count: count,
        is_read: true,
        unread_count: remaining(db, uid).await?,
    })
}

pub(super) async fn apply(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    scope: Selection,
) -> Result<ReadReceipt, DbErr> {
    let tx = db.begin().await?;
    let receipt = match scope {
        Selection::Selected(ids) => selected(&tx, uid, &ids).await?,
        Selection::AllUnread => all_unread(&tx, uid).await?,
    };
    tx.commit().await?;
    Ok(receipt)
}

pub async fn read_notifications(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ReadRequest>,
) -> Json<ApiResponse<Option<ReadReceipt>>> {
    let uid = match crate::auth_jwt::auth_uid(&app.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    let scope = match selection(request) {
        Ok(value) => value,
        Err(error) => return Json(ApiResponse::error(&error.to_string())),
    };
    let outcome = apply(&app.db, uid, scope).await;
    match outcome {
        Ok(receipt) => Json(ApiResponse::success(Some(receipt))),
        Err(DbErr::Custom(message)) if message == SELECTION_CONFLICT => Json(ApiResponse {
            code: 409,
            message,
            data: None,
        }),
        Err(error) => {
            tracing::error!(%error,uid,"notification read transaction failed");
            Json(ApiResponse::error(
                "无法完成所选通知的已读变更，请核对通知状态",
            ))
        }
    }
}

#[cfg(test)]
mod tests;
