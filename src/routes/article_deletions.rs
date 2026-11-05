//! Permanent article deletion binds document versions and relies on database cascades.
use crate::{
    entity::note,
    routes::{
        notes::drafts::{document_version, locked_document},
        AppState,
    },
    utils::ApiResponse,
};
use axum::{extract::State, Json};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseTransaction, DbErr, EntityTrait,
    IsolationLevel, QueryFilter, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_ITEMS: usize = 50;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub article_ids: Vec<i32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: i32,
    pub version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub items: Vec<Item>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: i32,
    pub title: String,
    pub version: String,
    pub draft_count: i64,
    pub comment_count: i64,
    pub favorite_count: i64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub deleted: bool,
    pub items: Vec<Target>,
}
fn error(message: &str) -> DbErr {
    DbErr::Custom(message.into())
}
fn ids(values: &[i32]) -> Result<Vec<i32>, DbErr> {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.len() != values.len()
        || sorted.is_empty()
        || sorted.len() > MAX_ITEMS
        || sorted[0] <= 0
    {
        return Err(error("请选择1至50篇不同的文章编号"));
    }
    Ok(sorted)
}
async fn targets(db: &DatabaseTransaction, values: &[i32]) -> Result<Vec<Target>, DbErr> {
    let mut targets = Vec::new();
    for id in ids(values)? {
        let (root, draft) = locked_document(db, id).await?;
        if root.id != id {
            return Err(error("修改稿不能作为原文章删除目标"));
        }
        let version = document_version(db, &root, draft.as_ref()).await?;
        let counts = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT (SELECT count(*) FROM note WHERE draft_of=$1) AS drafts, \
             (SELECT count(*) FROM note_comment WHERE note_id=$1) AS comments, \
             (SELECT count(*) FROM user_favorite WHERE note_id=$1) AS favorites",
                [id.into()],
            ))
            .await?
            .ok_or_else(|| error("无法读取删除影响范围"))?;
        targets.push(Target {
            id,
            title: root.title,
            version,
            draft_count: counts.try_get("", "drafts")?,
            comment_count: counts.try_get("", "comments")?,
            favorite_count: counts.try_get("", "favorites")?,
        });
    }
    Ok(targets)
}
pub(super) async fn apply(db: &DatabaseTransaction, change: &Change) -> Result<Outcome, DbErr> {
    let values = change.items.iter().map(|v| v.id).collect::<Vec<_>>();
    ids(&values)?;
    if change
        .items
        .iter()
        .any(|v| v.version.len() != 64 || !v.version.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(error("文章删除版本无效"));
    }
    let targets = targets(db, &values).await?;
    for target in &targets {
        if !change
            .items
            .iter()
            .any(|item| item.id == target.id && item.version == target.version)
        {
            return Err(error("文章或修改稿已变化，请重新核对并确认；本批次未删除"));
        }
    }
    delete(db, &values).await?;
    Ok(Outcome {
        deleted: true,
        items: targets,
    })
}
async fn delete(db: &DatabaseTransaction, values: &[i32]) -> Result<(), DbErr> {
    let removed = note::Entity::delete_many()
        .filter(note::Column::Id.is_in(values.to_vec()))
        .filter(note::Column::DraftOf.is_null())
        .exec(db)
        .await?;
    if removed.rows_affected != values.len() as u64 {
        return Err(error("文章删除结果不完整，事务已取消"));
    }
    Ok(())
}
pub(super) async fn delete_current(
    db: &DatabaseTransaction,
    values: &[i32],
) -> Result<Outcome, DbErr> {
    let rows = targets(db, values).await?;
    delete(db, values).await?;
    Ok(Outcome {
        deleted: true,
        items: rows,
    })
}
fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(e) => {
            tracing::warn!(error=%e,"article deletion did not commit");
            Json(ApiResponse::error(match &e {
                DbErr::Custom(message) => message,
                _ => "文章删除未完成，请重新查询",
            }))
        }
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Json(selection): Json<Selection>,
) -> Json<ApiResponse<Vec<Target>>> {
    response(
        async {
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
                .await?;
            let rows = targets(&txn, &selection.article_ids).await?;
            txn.commit().await?;
            Ok(rows)
        }
        .await,
    )
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    response(
        async {
            let txn = state
                .db
                .begin_with_config(Some(IsolationLevel::Serializable), None)
                .await?;
            let result = apply(&txn, &change).await?;
            txn.commit().await?;
            Ok(result)
        }
        .await,
    )
}
#[cfg(test)]
mod tests;
