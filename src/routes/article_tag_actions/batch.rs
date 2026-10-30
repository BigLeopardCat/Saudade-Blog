//! Bounded same-intent batches validate all targets before creating any tag.

use super::{apply_prepared, response, targets, Intent, Outcome, Prepared};
use crate::{routes::AppState, utils::ApiResponse};
use axum::{extract::State, Json};
use sea_orm::{ConnectionTrait, DbErr, IsolationLevel, TransactionTrait};
use serde::Deserialize;
use std::{collections::HashSet, sync::Arc};

const MAX_ITEMS: usize = 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub article_ids: Vec<i32>,
    pub intent: Intent,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: i32,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub items: Vec<Item>,
    pub intent: Intent,
}

pub(super) fn validate_selection(values: &[i32]) -> Result<Vec<i32>, DbErr> {
    if values.is_empty()
        || values.len() > MAX_ITEMS
        || values.iter().any(|id| *id <= 0)
        || values.iter().collect::<HashSet<_>>().len() != values.len()
    {
        return Err(targets::failure("每批须明确选择1至20篇不重复的文章"));
    }
    let mut ordered = values.to_vec();
    ordered.sort_unstable();
    Ok(ordered)
}

async fn plans<C: ConnectionTrait>(
    db: &C,
    values: &[i32],
    intent: &Intent,
    lock: bool,
) -> Result<Vec<Prepared>, DbErr> {
    let ordered = validate_selection(values)?;
    intent.validate()?;
    let mut rows = Vec::with_capacity(ordered.len());
    for id in ordered {
        rows.push(targets::prepare(db, id, intent, lock).await?);
    }
    Ok(rows)
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    change: &Change,
) -> Result<Vec<Outcome>, DbErr> {
    let values = change.items.iter().map(|item| item.id).collect::<Vec<_>>();
    validate_selection(&values)?;
    if change.items.iter().any(|item| {
        item.version.len() != 64 || !item.version.bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        return Err(targets::failure("批量确认版本无效"));
    }
    let prepared = plans(db, &values, &change.intent, true).await?;
    for plan in &prepared {
        let wanted = change.items.iter().find(|item| item.id == plan.id).unwrap();
        if plan.version != wanted.version {
            return Err(targets::failure(
                "文章或标签已变化，整批未执行，请重新核对并确认",
            ));
        }
    }
    let mut outcomes = Vec::with_capacity(prepared.len());
    for plan in prepared {
        let version = plan.version.clone();
        outcomes.push(apply_prepared(db, plan, &version).await?);
    }
    Ok(outcomes)
}

pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Json(selection): Json<Selection>,
) -> Json<ApiResponse<Vec<Prepared>>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let rows = plans(&txn, &selection.article_ids, &selection.intent, false).await?;
        txn.commit().await?;
        Ok(rows)
    }
    .await;
    response(result)
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Vec<Outcome>>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::Serializable), None)
            .await?;
        let rows = apply(&txn, &change).await?;
        txn.commit().await?;
        Ok(rows)
    }
    .await;
    response(result)
}
