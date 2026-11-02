//! Actor-owned detail and version-bound deletion without transferring the whole list.
use super::{begin_list_write, TodoDto};
use crate::{entity::dashboard_todo, routes::AppState, utils::ApiResponse};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

fn dto(row: dashboard_todo::Model) -> TodoDto {
    TodoDto {
        id: Some(row.id),
        version: Some(row.updated_at.to_string()),
        text: row.text,
        done: row.done,
        date: row.due_date.map(|date| date.to_string()),
    }
}

pub async fn get_todo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Json<ApiResponse<TodoDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    match dashboard_todo::Entity::find_by_id(id)
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .one(&state.db)
        .await
    {
        Ok(Some(row)) => Json(ApiResponse::success(dto(row))),
        Ok(None) => Json(ApiResponse::error("待办已变化或不在本人清单中，请重新读取后确认")),
        Err(error) => {
            tracing::error!(%error, uid, id, "todo detail query failed");
            Json(ApiResponse::error("待办读取失败，请稍后重试"))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteRequest {
    pub version: String,
    pub text: String,
}

#[derive(Default, Serialize)]
pub struct DeletedTodo {
    pub id: i32,
    pub version: String,
    pub deleted: bool,
}

pub async fn delete_todo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(request): Json<DeleteRequest>,
) -> Json<ApiResponse<DeletedTodo>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(error) => return Json(ApiResponse::error(error.message())),
    };
    let version =
        match chrono::NaiveDateTime::parse_from_str(&request.version, "%Y-%m-%d %H:%M:%S%.f") {
            Ok(version)
                if id > 0 && !request.text.is_empty() && request.text.chars().count() <= 200 =>
            {
                version
            }
            _ => return Json(ApiResponse::error("待办编号、正文或版本无效")),
        };
    let result = async {
        let txn = begin_list_write(&state.db, uid).await?;
        let removed = deletion(uid, id, &request.text, version).exec(&txn).await?;
        if removed.rows_affected != 1 {
            return Err(sea_orm::DbErr::Custom(
                "待办已变化或不在本人清单中，请重新读取后确认".into(),
            ));
        }
        txn.commit().await?;
        Ok(DeletedTodo {
            id,
            version: request.version,
            deleted: true,
        })
    }
    .await;
    match result {
        Ok(outcome) => {
            tracing::info!(uid, id, "todo deleted");
            Json(ApiResponse::success(outcome))
        }
        Err(error) => {
            let message = match error {
                sea_orm::DbErr::Custom(message) => message,
                other => {
                    tracing::error!(%other, uid, id, "todo deletion failed");
                    "删除失败或结果未知，请先查询待办状态".into()
                }
            };
            Json(ApiResponse::error(&message))
        }
    }
}

fn deletion(
    uid: i32,
    id: i32,
    text: &str,
    version: chrono::NaiveDateTime,
) -> sea_orm::DeleteMany<dashboard_todo::Entity> {
    dashboard_todo::Entity::delete_many()
        .filter(dashboard_todo::Column::Id.eq(id))
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .filter(dashboard_todo::Column::Text.eq(text))
        .filter(dashboard_todo::Column::UpdatedAt.eq(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, DatabaseBackend, MockDatabase};

    #[tokio::test]
    async fn deletion_binds_owner_id_text_and_version_in_one_statement() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_exec_results([sea_orm::MockExecResult {
                last_insert_id: 0,
                rows_affected: 1,
            }])
            .into_connection();
        let clock = chrono::NaiveDate::from_ymd_opt(2026, 11, 3)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        assert_eq!(
            deletion(7, 42, "keep other items", clock)
                .exec(&db)
                .await
                .unwrap()
                .rows_affected,
            1
        );
        let log = format!("{:?}", db.into_transaction_log());
        for fragment in [
            "DELETE FROM",
            "user_id",
            "updated_at",
            "keep other items",
            "42",
            "7",
        ] {
            assert!(log.contains(fragment), "missing {fragment}: {log}");
        }
    }

    #[tokio::test]
    async fn postgres_delete_rejects_other_owners_stale_versions_and_replays() {
        use sea_orm::{Database, Set, Statement};
        let Ok(url) = std::env::var("TEST_PG_URL") else {
            return;
        };
        let db = Database::connect(url).await.unwrap();
        let txn = db.begin().await.unwrap();
        let name = format!("todo_delete_{}", uuid::Uuid::new_v4().simple());
        let user = txn.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO \"user\" (username,nickname,password,role) VALUES ($1,$1,'fixture','admin') RETURNING id",
            vec![name.into()])).await.unwrap().unwrap();
        let uid: i32 = user.try_get("", "id").unwrap();
        let clock = chrono::Utc::now().naive_utc();
        let row = dashboard_todo::Entity::insert(dashboard_todo::ActiveModel {
            user_id: Set(uid),
            sort_order: Set(0),
            text: Set("delete fixture".into()),
            done: Set(false),
            due_date: Set(None),
            created_at: Set(clock),
            updated_at: Set(clock),
            ..Default::default()
        })
        .exec_with_returning(&txn)
        .await
        .unwrap();
        let version = row.updated_at;
        for (actor, stamp, text) in [
            (uid + 1, version, "delete fixture"),
            (
                uid,
                version + chrono::Duration::seconds(1),
                "delete fixture",
            ),
            (uid, version, "different text"),
        ] {
            assert_eq!(
                deletion(actor, row.id, text, stamp)
                    .exec(&txn)
                    .await
                    .unwrap()
                    .rows_affected,
                0
            );
        }
        assert!(dashboard_todo::Entity::find_by_id(row.id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            deletion(uid, row.id, &row.text, version)
                .exec(&txn)
                .await
                .unwrap()
                .rows_affected,
            1
        );
        assert_eq!(
            deletion(uid, row.id, &row.text, version)
                .exec(&txn)
                .await
                .unwrap()
                .rows_affected,
            0
        );
        txn.rollback().await.unwrap();
    }
}
