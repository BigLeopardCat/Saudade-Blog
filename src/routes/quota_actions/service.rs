//! One transaction owns the target check, request claim and quota mutation.

use super::super::quota;
use super::{Outcome, account, account_version, request, request_version, snapshot};
use crate::entity::{quota_request, user};
use chrono::SubsecRound;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, TransactionTrait,
    sea_query::Expr,
};

fn database_error(action: &str, error: sea_orm::DbErr) -> String {
    tracing::error!("quota {action} failed: {error}");
    "额度操作失败，请查询实际状态后重试".to_string()
}

pub async fn review(
    db: &DatabaseConnection,
    operator: i32,
    id: i32,
    payload: quota::ReviewQuotaReq,
    version: Option<&str>,
) -> Result<Outcome, String> {
    let txn = db
        .begin()
        .await
        .map_err(|e| database_error("transaction", e))?;
    let out = review_in(&txn, operator, id, payload, version).await?;
    txn.commit()
        .await
        .map_err(|e| database_error("commit", e))?;
    let row = out
        .state
        .request
        .as_ref()
        .expect("review produces a request snapshot");
    let (title, content) = if row.status == quota::STATUS_APPROVED {
        let content = if out.state.unlimited {
            "管理员已批准你的额度重置申请；当前账号不限额。".to_string()
        } else {
            format!(
                "管理员已批准你的对话额度重置申请，额度已恢复到 {} 轮。",
                out.state.limit
            )
        };
        (quota::NOTICE_APPROVED_TITLE, content)
    } else {
        (
            quota::NOTICE_REJECTED_TITLE,
            format!(
                "管理员驳回了你的对话额度重置申请。理由：{}",
                row.note.as_deref().unwrap_or(quota::NO_REASON_FALLBACK)
            ),
        )
    };
    tracing::info!(
        request_id = id,
        user_id = out.state.user_id,
        operator,
        approved = row.status == quota::STATUS_APPROVED,
        "quota application reviewed"
    );
    quota::notify(db, out.state.user_id, title, content).await;
    Ok(out)
}

pub(super) async fn review_in<C: ConnectionTrait>(
    txn: &C,
    operator: i32,
    id: i32,
    payload: quota::ReviewQuotaReq,
    version: Option<&str>,
) -> Result<Outcome, String> {
    let mut row = request(txn, id, true).await?;
    if row.status != quota::STATUS_PENDING {
        return Err("这条申请已经处理过了".into());
    }
    let mut target = account(txn, row.user_id, true).await?;
    if version.is_some_and(|value| request_version(&row, &target) != value) {
        return Err("申请或账号已变化，请重新读取并确认".into());
    }
    let note = if payload.approved {
        None
    } else {
        let raw = payload.reason.unwrap_or_default().trim().to_string();
        if raw.chars().count() > quota::NOTE_MAX {
            return Err("驳回理由最多255字".into());
        }
        if raw.is_empty() { None } else { Some(raw) }
    };
    let status = if payload.approved {
        quota::STATUS_APPROVED
    } else {
        quota::STATUS_REJECTED
    };
    let at = chrono::Local::now().naive_local().trunc_subsecs(6);
    let result = quota_request::Entity::update_many()
        .col_expr(quota_request::Column::Status, Expr::value(status))
        .col_expr(quota_request::Column::Note, Expr::value(note.clone()))
        .col_expr(quota_request::Column::HandledAt, Expr::value(at))
        .col_expr(
            quota_request::Column::HandledBy,
            Expr::value(Some(operator)),
        )
        .filter(quota_request::Column::Id.eq(id))
        .filter(quota_request::Column::UserId.eq(target.id))
        .filter(quota_request::Column::Status.eq(quota::STATUS_PENDING))
        .exec(txn)
        .await
        .map_err(|e| database_error("claim", e))?;
    if result.rows_affected != 1 {
        return Err("这条申请已经处理过了".into());
    }
    if payload.approved {
        let changed = user::Entity::update_many()
            .col_expr(user::Column::ChatQuotaUsed, Expr::value(0))
            .filter(user::Column::Id.eq(target.id))
            .exec(txn)
            .await
            .map_err(|e| database_error("reset after approval", e))?;
        if changed.rows_affected != 1 {
            return Err("账号不存在".into());
        }
        target.chat_quota_used = 0;
    }
    row.status = status;
    row.note = note.clone();
    row.handled_at = Some(at);
    row.handled_by = Some(operator);
    Ok(Outcome {
        state: snapshot(&target, Some(&row)),
        changed: true,
    })
}

pub async fn reset(
    db: &DatabaseConnection,
    id: i32,
    version: Option<&str>,
) -> Result<Outcome, String> {
    let txn = db
        .begin()
        .await
        .map_err(|e| database_error("transaction", e))?;
    let out = reset_in(&txn, id, version).await?;
    txn.commit()
        .await
        .map_err(|e| database_error("commit", e))?;
    if out.changed {
        tracing::info!(user_id = out.state.user_id, "account quota reset");
        quota::notify(
            db,
            out.state.user_id,
            quota::NOTICE_RESET_TITLE,
            format!("管理员已把你的对话额度恢复到 {} 轮。", out.state.limit),
        )
        .await;
    }
    Ok(out)
}

pub(super) async fn reset_in<C: ConnectionTrait>(
    txn: &C,
    id: i32,
    version: Option<&str>,
) -> Result<Outcome, String> {
    let mut target = account(txn, id, true).await?;
    if !crate::authz::is_listable_role(&target.role) {
        return Err("该账号不能重置额度".into());
    }
    if crate::quota::is_unlimited(Some(&target.role)) {
        return Err("该账号不限额，无需重置额度".into());
    }
    if version.is_some_and(|value| account_version(&target) != value) {
        return Err("账号或已用轮数已变化，请重新读取并确认".into());
    }
    let changed = target.chat_quota_used != 0;
    if changed {
        let result = user::Entity::update_many()
            .col_expr(user::Column::ChatQuotaUsed, Expr::value(0))
            .filter(user::Column::Id.eq(target.id))
            .filter(user::Column::Username.eq(&target.username))
            .filter(user::Column::Role.eq(&target.role))
            .filter(user::Column::ChatQuotaUsed.eq(target.chat_quota_used))
            .exec(txn)
            .await
            .map_err(|e| database_error("reset", e))?;
        if result.rows_affected != 1 {
            return Err("账号已变化，请重新读取并确认".into());
        }
        target.chat_quota_used = 0;
    }
    Ok(Outcome {
        state: snapshot(&target, None),
        changed,
    })
}
