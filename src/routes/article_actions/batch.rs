//! One reviewed article-state batch is committed atomically.
use super::{apply_locked, response, target_query, Change, Outcome, Status, Target};
use crate::{
    entity::{category, note},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{extract::State, Json};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    QueryTrait, TransactionTrait,
};
use serde::Deserialize;
use std::sync::Arc;

const MAX_ITEMS: usize = 50;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub article_ids: Option<Vec<i32>>,
    pub category: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: i32,
    pub version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchChange {
    pub items: Vec<Item>,
    pub status: Option<Status>,
    pub is_top: Option<i32>,
}

fn ids(values: &[i32]) -> Result<Vec<i32>, DbErr> {
    let mut ordered = values.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    if ordered.is_empty()
        || ordered.len() > MAX_ITEMS
        || ordered.len() != values.len()
        || ordered[0] <= 0
    {
        return Err(DbErr::Custom(
            "select 1–50 distinct positive article IDs".into(),
        ));
    }
    Ok(ordered)
}

pub(super) async fn select<C: ConnectionTrait>(
    db: &C,
    params: &Selection,
) -> Result<Vec<Target>, DbErr> {
    let mut query = target_query();
    let expected = match (&params.article_ids, &params.category) {
        (Some(values), None) => {
            let values = ids(values)?;
            query = query.filter(note::Column::Id.is_in(values.clone()));
            Some(values.len())
        }
        (None, Some(name)) if !name.trim().is_empty() && name.chars().count() <= 100 => {
            query = query.filter(
                note::Column::CategoryId.in_subquery(
                    category::Entity::find()
                        .select_only()
                        .column(category::Column::Id)
                        .filter(category::Column::Name.eq(name))
                        .into_query(),
                ),
            );
            None
        }
        _ => {
            return Err(DbErr::Custom(
                "provide article IDs or one exact category name".into(),
            ))
        }
    };
    let rows = query
        .order_by_asc(note::Column::Id)
        .limit((MAX_ITEMS + 1) as u64)
        .into_model::<Target>()
        .all(db)
        .await?;
    if rows.len() > MAX_ITEMS || expected.is_some_and(|count| count != rows.len()) {
        return Err(DbErr::Custom(
            "selection is missing articles or exceeds 50; no truncated batch is prepared".into(),
        ));
    }
    Ok(rows)
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    params: &BatchChange,
) -> Result<Vec<Outcome>, DbErr> {
    let ordered = ids(&params.items.iter().map(|item| item.id).collect::<Vec<_>>())?;
    for item in &params.items {
        super::validate(
            item.id,
            &Change {
                version: item.version.clone(),
                status: params.status,
                is_top: params.is_top,
            },
        )?;
    }
    // All locks and version checks precede the first write. Lock order is stable.
    let rows = target_query()
        .filter(note::Column::Id.is_in(ordered))
        .order_by_asc(note::Column::Id)
        .lock_exclusive()
        .into_model::<Target>()
        .all(db)
        .await?;
    if rows.len() != params.items.len()
        || rows.iter().any(|row| {
            !params
                .items
                .iter()
                .any(|item| item.id == row.id && item.version == row.version)
        })
    {
        return Err(DbErr::Custom(
            "article batch changed; prepare and confirm again".into(),
        ));
    }
    let mut results = Vec::with_capacity(rows.len());
    for row in rows {
        let change = Change {
            version: row.version.clone(),
            status: params.status,
            is_top: params.is_top,
        };
        results.push(apply_locked(db, row, &change).await?);
    }
    Ok(results)
}

pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Json(params): Json<Selection>,
) -> Json<ApiResponse<Vec<Target>>> {
    response(select(&state.db, &params).await)
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    Json(params): Json<BatchChange>,
) -> Json<ApiResponse<Vec<Outcome>>> {
    let result = async {
        let tx = state.db.begin().await?;
        let results = apply(&tx, &params).await?;
        tx.commit().await?;
        Ok(results)
    }
    .await;
    response(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DatabaseBackend, MockDatabase};
    #[test]
    fn batch_ids_are_exact_bounded_and_unique() {
        for values in [vec![], vec![1, 1], vec![-1], (1..=51).collect()] {
            assert!(ids(&values).is_err());
        }
        assert_eq!(ids(&[3, 1, 2]).unwrap(), vec![1, 2, 3]);
    }
    #[tokio::test]
    async fn invalid_batch_never_queries_or_writes() {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let params = BatchChange {
            items: vec![Item {
                id: 1,
                version: "invalid".into(),
            }],
            status: Some(Status::Private),
            is_top: None,
        };
        assert!(apply(&db, &params).await.is_err());
        assert!(db.into_transaction_log().is_empty());
    }
}
