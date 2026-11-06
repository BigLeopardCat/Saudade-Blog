//! Review filters, bounded list windows and content-free aggregate counts.

use axum::{extract::State, Json};
use sea_orm::{ConnectionTrait, DbErr, FromQueryResult, Statement};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{routes::AppState, utils::ApiResponse};

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
    scope: &'static str,
    total: u64,
    pending: u64,
    passed: u64,
    rejected: u64,
    ai_passed: u64,
    ai_flagged: u64,
    ai_rejected: u64,
    ai_unreviewed: u64,
}

#[derive(Serialize)]
pub struct Overview {
    board: Summary,
    comments: Summary,
}

#[derive(FromQueryResult)]
struct GroupCount {
    resource: String,
    approved: i16,
    ai_result: Option<String>,
    count: i64,
}

fn aggregate(rows: Vec<GroupCount>) -> Result<Overview, DbErr> {
    let mut out = Overview {
        board: Summary {
            scope: "all",
            ..Summary::default()
        },
        comments: Summary {
            scope: "not_deleted",
            ..Summary::default()
        },
    };
    for row in rows {
        let target = match row.resource.as_str() {
            "board" => &mut out.board,
            "comments" => &mut out.comments,
            _ => return Err(DbErr::Custom("unknown review resource".into())),
        };
        let count = u64::try_from(row.count).map_err(|_| DbErr::Custom("invalid count".into()))?;
        match row.approved {
            0 => target.pending += count,
            1 => target.passed += count,
            2 => target.rejected += count,
            _ => return Err(DbErr::Custom("unknown review status".into())),
        }
        match row.ai_result.as_deref() {
            Some("pass") => target.ai_passed += count,
            Some("flag") => target.ai_flagged += count,
            Some("reject") => target.ai_rejected += count,
            None => target.ai_unreviewed += count,
            _ => return Err(DbErr::Custom("unknown AI decision".into())),
        }
        target.total += count;
    }
    Ok(out)
}

pub(super) async fn summary(db: &impl ConnectionTrait) -> Result<Overview, DbErr> {
    // One statement gives both resources the same database snapshot, without reading bodies.
    let rows = GroupCount::find_by_statement(Statement::from_string(
        db.get_database_backend(),
        "SELECT 'board' AS resource, approved, ai_result, COUNT(*) AS count \
         FROM talk WHERE src = 'board' GROUP BY approved, ai_result \
         UNION ALL \
         SELECT 'comments' AS resource, approved, ai_result, COUNT(*) AS count \
         FROM note_comment WHERE is_deleted = 0 GROUP BY approved, ai_result"
            .to_owned(),
    ))
    .all(db)
    .await?;
    aggregate(rows)
}

pub async fn overview(State(state): State<Arc<AppState>>) -> Json<ApiResponse<Overview>> {
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
