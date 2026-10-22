//! Review filters, bounded list windows and aggregate board counts.

use axum::{extract::State, Json};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{entity::talk, routes::AppState, utils::ApiResponse};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewStatus {
    Pending,
    Passed,
    Rejected,
}

impl ReviewStatus {
    pub fn approved(self) -> i16 {
        match self {
            Self::Pending => 0,
            Self::Passed => 1,
            Self::Rejected => 2,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiDecision {
    Pass,
    Flag,
    Reject,
    None,
}

impl AiDecision {
    pub fn value(self) -> Option<&'static str> {
        match self {
            Self::Pass => Some("pass"),
            Self::Flag => Some("flag"),
            Self::Reject => Some("reject"),
            Self::None => None,
        }
    }
}

pub fn page_window(
    page: Option<u64>,
    size: Option<u64>,
) -> Result<Option<(u64, u64)>, &'static str> {
    let Some(size) = size else { return Ok(None) };
    let size = size.clamp(1, 200);
    let offset = page
        .unwrap_or(1)
        .max(1)
        .checked_sub(1)
        .and_then(|p| p.checked_mul(size))
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or("页码超出范围")?;
    Ok(Some((size, offset)))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    total: u64,
    pending: u64,
    passed: u64,
    rejected: u64,
    ai_passed: u64,
    ai_flagged: u64,
    ai_rejected: u64,
    ai_unreviewed: u64,
}

pub(super) async fn summary(db: &impl ConnectionTrait) -> Result<Summary, DbErr> {
    let rows: Vec<(i16, Option<String>, i64)> = talk::Entity::find()
        .select_only()
        .column(talk::Column::Approved)
        .column(talk::Column::AiResult)
        .column_as(talk::Column::Id.count(), "count")
        .filter(talk::Column::Src.eq("board"))
        .group_by(talk::Column::Approved)
        .group_by(talk::Column::AiResult)
        .into_tuple()
        .all(db)
        .await?;
    let mut out = Summary::default();
    for (approved, ai, count) in rows {
        let count = u64::try_from(count).map_err(|_| DbErr::Custom("invalid count".into()))?;
        match approved {
            0 => out.pending += count,
            1 => out.passed += count,
            2 => out.rejected += count,
            _ => return Err(DbErr::Custom("unknown review status".into())),
        }
        match ai.as_deref() {
            Some("pass") => out.ai_passed += count,
            Some("flag") => out.ai_flagged += count,
            Some("reject") => out.ai_rejected += count,
            None => out.ai_unreviewed += count,
            _ => return Err(DbErr::Custom("unknown AI decision".into())),
        }
        out.total += count;
    }
    Ok(out)
}

pub async fn board_summary(State(state): State<Arc<AppState>>) -> Json<ApiResponse<Summary>> {
    match summary(&state.db).await {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::error!("[moderation] aggregate query failed: {error}");
            Json(ApiResponse::error("审核统计查询失败，请稍后再试"))
        }
    }
}

#[cfg(test)]
mod tests;
