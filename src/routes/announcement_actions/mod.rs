//! Versioned announcement changes and their notification delivery share one transaction.

mod targets;
#[cfg(test)]
mod tests;

use crate::{
    entity::{announcement, user_notification},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{extract::State, Json};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IsolationLevel, QueryFilter, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: Option<i32>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Fields {
    pub title: Option<String>,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub action: Action,
    pub target: Option<Target>,
    #[serde(default)]
    pub fields: Fields,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Announcement {
    pub id: Option<i32>,
    pub title: String,
    pub content: String,
}
impl From<announcement::Model> for Announcement {
    fn from(row: announcement::Model) -> Self {
        Self {
            id: Some(row.id),
            title: row.title,
            content: row.content,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub before: Option<Announcement>,
    pub after: Option<Announcement>,
    pub notification_count: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub version: String,
    pub intent: Intent,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub before_version: String,
    pub state: Prepared,
}

/// Direct administrator forms use the same transaction logic without a separate proposal.
pub(super) async fn apply_current<C: ConnectionTrait>(
    db: &C,
    intent: Intent,
) -> Result<Outcome, sea_orm::DbErr> {
    let prepared = targets::prepare(db, &intent, true).await?;
    apply(
        db,
        &Change {
            version: prepared.version,
            intent,
        },
    )
    .await
}

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    change: &Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let mut plan = targets::prepare(db, &change.intent, true).await?;
    if change.version.len() != 64 || plan.version != change.version {
        return Err(targets::failure("公告或通知范围已变化，请重新核对并确认"));
    }
    let changed = plan.before != plan.after;
    if changed {
        match (&plan.before, &plan.after) {
            (None, Some(after)) => {
                let row = announcement::ActiveModel {
                    title: Set(after.title.clone()),
                    content: Set(after.content.clone()),
                    ..Default::default()
                }
                .insert(db)
                .await?;
                let recipients = targets::recipients(db).await?;
                for uid in recipients {
                    user_notification::ActiveModel {
                        user_id: Set(uid),
                        announcement_id: Set(Some(row.id)),
                        kind: Set("announcement".to_owned()),
                        title: Set(row.title.clone()),
                        content: Set(Some(row.content.clone())),
                        link: Set(None),
                        created_at: Set(row
                            .created_at
                            .ok_or_else(|| targets::failure("公告缺少发布时间"))?),
                        ..Default::default()
                    }
                    .insert(db)
                    .await?;
                }
                let saved = Announcement::from(row);
                let mut expected = after.clone();
                expected.id = saved.id;
                if saved != expected {
                    return Err(targets::failure("公告创建结果不一致"));
                }
                plan.after = Some(saved);
            }
            (Some(before), Some(after)) => {
                let saved = announcement::ActiveModel {
                    id: Set(before.id.unwrap()),
                    title: Set(after.title.clone()),
                    content: Set(after.content.clone()),
                    updated_at: Set(Some(chrono::Local::now().naive_local())),
                    ..Default::default()
                }
                .update(db)
                .await?;
                if Announcement::from(saved) != *after {
                    return Err(targets::failure("公告更新结果不一致"));
                }
                user_notification::Entity::update_many()
                    .col_expr(
                        user_notification::Column::Title,
                        sea_orm::sea_query::Expr::value(after.title.clone()),
                    )
                    .col_expr(
                        user_notification::Column::Content,
                        sea_orm::sea_query::Expr::value(Some(after.content.clone())),
                    )
                    .filter(user_notification::Column::AnnouncementId.eq(before.id.unwrap()))
                    .exec(db)
                    .await?;
            }
            (Some(before), None) => {
                if announcement::Entity::delete_by_id(before.id.unwrap())
                    .exec(db)
                    .await?
                    .rows_affected
                    != 1
                {
                    return Err(targets::failure("公告未能删除"));
                }
            }
            _ => return Err(targets::failure("公告计划无效")),
        }
        let id = plan
            .after
            .as_ref()
            .or(plan.before.as_ref())
            .and_then(|row| row.id)
            .unwrap();
        let actual = announcement::Entity::find_by_id(id)
            .one(db)
            .await?
            .map(Announcement::from);
        if actual != plan.after {
            return Err(targets::failure("公告实际状态与计划不一致"));
        }
        let notifications = targets::notifications(db, id).await?;
        if plan.after.is_none() && !notifications.is_empty()
            || plan.after.is_some() && notifications.len() as u64 != plan.notification_count
        {
            return Err(targets::failure("公告通知范围未完整执行"));
        }
        if let Some(after) = &plan.after {
            for notification in user_notification::Entity::find()
                .filter(user_notification::Column::AnnouncementId.eq(id))
                .all(db)
                .await?
            {
                if notification.kind != "announcement"
                    || notification.title != after.title
                    || notification.content.as_deref() != Some(after.content.as_str())
                {
                    return Err(targets::failure("公告通知内容未完整同步"));
                }
            }
        }
    }
    Ok(Outcome {
        changed,
        before_version: change.version.clone(),
        state: plan,
    })
}

pub(super) fn response<T: Default>(result: Result<T, sea_orm::DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("announcement action failed: {error}");
            let message = match error {
                sea_orm::DbErr::Custom(value) => value,
                _ => "公告请求失败或发生并发修改，请重新查询".to_owned(),
            };
            Json(ApiResponse::error(&message))
        }
    }
}

pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let plan = targets::prepare(&txn, &intent, false).await?;
        txn.commit().await?;
        Ok(plan)
    }
    .await;
    response(result)
}

pub async fn change(
    State(state): State<Arc<AppState>>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::Serializable), None)
            .await?;
        let outcome = apply(&txn, &change).await?;
        txn.commit().await?;
        Ok(outcome)
    }
    .await;
    response(result)
}
