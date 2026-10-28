//! Scoped mailbox queries. Read state is never changed by listing messages.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Deserialize;
use std::sync::Arc;

use super::{peer_map, to_message_dto, MailboxDto};
use crate::{entity::user_message, routes::AppState, utils::ApiResponse};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MailboxQuery {
    /// Comma-separated received-message IDs, at most 100. Never searches the outbox.
    pub ids: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
}

impl MailboxQuery {
    fn selected_ids(&self) -> Result<Option<Vec<i32>>, &'static str> {
        let Some(raw) = &self.ids else {
            return Ok(None);
        };
        if self.unread_only {
            return Err("不能同时指定编号和全部未读筛选");
        }
        let values: Result<Vec<i32>, _> = raw.split(',').map(str::parse).collect();
        let mut ids = values.map_err(|_| "信件编号必须是正整数")?;
        if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| *id <= 0) {
            return Err("请提供 1 到 100 个有效信件编号");
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(Some(ids))
    }
}

async fn received<C: ConnectionTrait>(
    db: &C,
    uid: i32,
    query: &MailboxQuery,
) -> Result<(Vec<user_message::Model>, i64, bool), sea_orm::DbErr> {
    let mut inbox = user_message::Entity::find().filter(super::visibility::inbox(uid));
    if let Some(ids) = query
        .selected_ids()
        .map_err(|e| sea_orm::DbErr::Custom(e.into()))?
    {
        inbox = inbox.filter(user_message::Column::Id.is_in(ids));
    }
    if query.unread_only {
        inbox = inbox.filter(user_message::Column::IsRead.eq(false));
    }
    let mut rows = inbox
        .order_by_desc(user_message::Column::CreatedAt)
        .order_by_desc(user_message::Column::Id)
        .limit(101)
        .all(db)
        .await?;
    let complete = rows.len() <= 100;
    rows.truncate(100);
    // Count the entire inbox, independently of the visible window or ID selection.
    let unread = user_message::Entity::find()
        .filter(super::visibility::inbox(uid))
        .filter(user_message::Column::IsRead.eq(false))
        .count(db)
        .await? as i64;
    Ok((rows, unread, complete))
}

/// GET /api/protected/messages: recent inbox/outbox and the full inbox unread count.
/// ids/unreadOnly optionally select received messages, including older messages.
pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<MailboxQuery>,
) -> Json<ApiResponse<MailboxDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if let Err(message) = query.selected_ids() {
        return Json(ApiResponse::error(message));
    }
    let (inbox, unread, inbox_complete) = match received(&state.db, uid, &query).await {
        Ok(value) => value,
        Err(e) => {
            tracing::error!("[profile] 收件箱查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let outbox = match user_message::Entity::find()
        .filter(super::visibility::outbox(uid))
        .order_by_desc(user_message::Column::CreatedAt)
        .order_by_desc(user_message::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[profile] 发件箱查询失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("查询失败，请稍后再试"));
        }
    };
    let mut ids: Vec<i32> = inbox.iter().map(|m| m.from_user_id).collect();
    ids.extend(outbox.iter().map(|m| m.to_user_id));
    ids.sort_unstable();
    ids.dedup();
    let peers = peer_map(&state.db, &ids).await;
    Json(ApiResponse::success(MailboxDto {
        inbox_complete,
        inbox: inbox
            .into_iter()
            .map(|m| to_message_dto(m, uid, &peers))
            .collect(),
        outbox: outbox
            .into_iter()
            .map(|m| to_message_dto(m, uid, &peers))
            .collect(),
        unread,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, DatabaseBackend, Statement, TransactionTrait};

    #[test]
    fn mailbox_filters_reject_ambiguous_and_unbounded_selections() {
        for ids in ["", "0", "-1", "true", "1,broken"] {
            assert!(MailboxQuery {
                ids: Some(ids.into()),
                unread_only: false
            }
            .selected_ids()
            .is_err());
        }
        let query = MailboxQuery {
            ids: Some("2,1,2".into()),
            unread_only: false,
        };
        assert_eq!(query.selected_ids().unwrap(), Some(vec![1, 2]));
        assert!(MailboxQuery {
            unread_only: true,
            ..query
        }
        .selected_ids()
        .is_err());
    }

    #[tokio::test]
    async fn mailbox_old_unread_and_selected_ids_use_the_full_received_scope() {
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            return;
        };
        let db = Database::connect(url)
            .await
            .expect("TEST_PG_URL connection");
        let txn = db.begin().await.unwrap();
        let name = format!("mailbox_it_{}", uuid::Uuid::new_v4().simple());
        let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,$2,'user') RETURNING id",
            vec![name.into(), uuid::Uuid::new_v4().to_string().into()])).await.unwrap().unwrap();
        let uid: i32 = row.try_get("", "id").unwrap();
        // The only unread message is older than the 100-message default window.
        let mut old_id = 0;
        for index in 0..102 {
            let row = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "INSERT INTO user_message (from_user_id,to_user_id,content,is_read,created_at) \
                 VALUES ($1,$1,'mailbox contract',$2,localtimestamp) RETURNING id",
                vec![uid.into(), (index != 0).into()])).await.unwrap().unwrap();
            if index == 0 {
                old_id = row.try_get("", "id").unwrap();
            }
        }
        let (recent, unread, complete) =
            received(&txn, uid, &MailboxQuery::default()).await.unwrap();
        assert_eq!(recent.len(), 100);
        assert!(!complete);
        assert_eq!(unread, 1);
        assert!(!recent.iter().any(|m| m.id == old_id));
        let query = MailboxQuery {
            unread_only: true,
            ..Default::default()
        };
        let (rows, _, complete) = received(&txn, uid, &query).await.unwrap();
        assert!(complete);
        assert_eq!(rows.iter().map(|m| m.id).collect::<Vec<_>>(), vec![old_id]);
        let query = MailboxQuery {
            ids: Some(old_id.to_string()),
            unread_only: false,
        };
        assert_eq!(received(&txn, uid, &query).await.unwrap().0[0].id, old_id);
        assert!(received(&txn, uid + 1, &query).await.unwrap().0.is_empty());
        txn.rollback().await.unwrap();
    }
}
