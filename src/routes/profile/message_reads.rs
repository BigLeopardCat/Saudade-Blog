//! Small mailbox lists omit message bodies; detail reads require ownership.

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DerivePartialModel, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::{peer_map, to_message_dto, MessageDto};
use crate::{entity::user_message, routes::AppState, utils::ApiResponse};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    #[default]
    Inbox,
    Outbox,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentQuery {
    #[serde(default)]
    folder: Folder,
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_limit() -> u64 {
    5
}

#[derive(DerivePartialModel)]
#[sea_orm(entity = "user_message::Entity", from_query_result)]
struct Brief {
    id: i32,
    from_user_id: i32,
    to_user_id: i32,
    title: Option<String>,
    is_read: bool,
    created_at: chrono::NaiveDateTime,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: i32,
    from_user_id: i32,
    to_user_id: i32,
    peer_name: String,
    title: Option<String>,
    is_read: bool,
    created_at: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMessages {
    folder: &'static str,
    items: Vec<Entry>,
    has_more: bool,
}

async fn recent<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    folder: Folder,
    limit: u64,
) -> Result<(Vec<Brief>, bool), sea_orm::DbErr> {
    let column = match folder {
        Folder::Inbox => user_message::Column::ToUserId,
        Folder::Outbox => user_message::Column::FromUserId,
    };
    let mut rows = user_message::Entity::find()
        .filter(column.eq(uid))
        .order_by_desc(user_message::Column::CreatedAt)
        .order_by_desc(user_message::Column::Id)
        .limit(limit + 1)
        .into_partial_model::<Brief>()
        .all(db)
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    Ok((rows, has_more))
}

/// GET /api/protected/messages/recent?folder=inbox&limit=5
pub async fn recent_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RecentQuery>,
) -> Json<ApiResponse<RecentMessages>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if !(1..=10).contains(&query.limit) {
        return Json(ApiResponse::error("每次只能查询最近 1 到 10 封信"));
    }
    let (rows, has_more) = match recent(&state.db, uid, query.folder, query.limit).await {
        Ok(value) => value,
        Err(e) => {
            tracing::error!("[profile] 信箱摘要查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let peers: Vec<i32> = rows
        .iter()
        .map(|m| match query.folder {
            Folder::Inbox => m.from_user_id,
            Folder::Outbox => m.to_user_id,
        })
        .collect();
    let peers = peer_map(&state.db, &peers).await;
    let items = rows
        .into_iter()
        .map(|m| {
            let peer = match query.folder {
                Folder::Inbox => m.from_user_id,
                Folder::Outbox => m.to_user_id,
            };
            Entry {
                id: m.id,
                from_user_id: m.from_user_id,
                to_user_id: m.to_user_id,
                peer_name: peers
                    .get(&peer)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| format!("用户#{}", peer)),
                title: m.title,
                is_read: m.is_read,
                created_at: m.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
            }
        })
        .collect();
    Json(ApiResponse::success(RecentMessages {
        folder: match query.folder {
            Folder::Inbox => "inbox",
            Folder::Outbox => "outbox",
        },
        items,
        has_more,
    }))
}

async fn owned<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    id: i32,
) -> Result<Option<user_message::Model>, sea_orm::DbErr> {
    user_message::Entity::find_by_id(id)
        .filter(
            Condition::any()
                .add(user_message::Column::ToUserId.eq(uid))
                .add(user_message::Column::FromUserId.eq(uid)),
        )
        .one(db)
        .await
}

/// GET /api/protected/messages/{id}; this never marks the message read.
pub async fn message_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<MessageDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let message = match owned(&state.db, uid, id).await {
        Ok(Some(message)) if id > 0 => message,
        Ok(_) => return Json(ApiResponse::error("信件不存在或不可访问")),
        Err(e) => {
            tracing::error!("[profile] 信件查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let peer = if message.from_user_id == uid {
        message.to_user_id
    } else {
        message.from_user_id
    };
    let peers = peer_map(&state.db, &[peer]).await;
    Json(ApiResponse::success(to_message_dto(message, uid, &peers)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, DatabaseBackend, MockDatabase, Statement, TransactionTrait};

    #[tokio::test]
    async fn summary_query_does_not_select_message_content() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<user_message::Model>::new()])
            .into_connection();
        assert!(recent(&db, 7, Folder::Inbox, 5).await.unwrap().0.is_empty());
        let log = format!("{:?}", db.into_transaction_log());
        assert!(!log.contains("content"));
        let sql = user_message::Entity::find()
            .into_partial_model::<Brief>()
            .into_statement(DatabaseBackend::Postgres)
            .to_string();
        assert!(!sql.contains("content"));
    }

    #[tokio::test]
    async fn recent_and_detail_are_bounded_and_owned_without_read_side_effects() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            return;
        };
        let db = Database::connect(url).await.unwrap();
        let txn = db.begin().await.unwrap();
        let name = format!("recent_it_{}", uuid::Uuid::new_v4().simple());
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'user') RETURNING id",
            vec![name.into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
        let uid: i32 = row.try_get("", "id").unwrap();
        let mut last_id = 0;
        for _ in 0..12 {
            let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "INSERT INTO user_message (from_user_id,to_user_id,content,is_read,created_at) \
                 VALUES ($1,$1,'body only in detail',false,localtimestamp) RETURNING id",
                vec![uid.into()])).await.unwrap().unwrap();
            last_id = row.try_get("", "id").unwrap();
        }
        let (rows, more) = recent(&txn, uid, Folder::Inbox, 5).await.unwrap();
        assert_eq!(rows.len(), 5);
        assert!(more);
        assert_eq!(rows[0].id, last_id);
        assert_eq!(
            recent(&txn, uid, Folder::Outbox, 10).await.unwrap().0.len(),
            10
        );
        assert!(recent(&txn, uid + 1, Folder::Inbox, 5)
            .await
            .unwrap()
            .0
            .is_empty());
        assert!(owned(&txn, uid + 1, last_id).await.unwrap().is_none());
        let detail = owned(&txn, uid, last_id).await.unwrap().unwrap();
        assert_eq!(detail.content, "body only in detail");
        assert!(!detail.is_read);
        assert!(!owned(&txn, uid, last_id).await.unwrap().unwrap().is_read);
        txn.rollback().await.unwrap();
    }
}
