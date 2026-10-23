//! Versioned category changes; preparation never writes business data.

mod targets;
#[cfg(test)]
mod tests;

use crate::{entity::category, routes::AppState, utils::ApiResponse};
use axum::{extract::State, Json};
use sea_orm::{ActiveModelTrait, EntityTrait, IsolationLevel, Set, TransactionTrait};
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
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fields {
    pub name: Option<String>,
    pub path_name: Option<String>,
    pub introduce: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Category {
    pub id: Option<i32>,
    pub name: String,
    pub path_name: Option<String>,
    pub introduce: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
}
impl From<category::Model> for Category {
    fn from(row: category::Model) -> Self {
        Self {
            id: Some(row.id),
            name: row.name,
            path_name: row.path_name,
            introduce: row.introduce,
            icon: row.icon,
            color: row.color,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub before: Option<Category>,
    pub after: Option<Category>,
    pub article_count: u64,
    pub revision_count: u64,
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

async fn apply<C: sea_orm::ConnectionTrait>(
    db: &C,
    change: &Change,
) -> Result<Outcome, sea_orm::DbErr> {
    let mut plan = targets::prepare(db, &change.intent, true).await?;
    if change.version.len() != 64 || plan.version != change.version {
        return Err(targets::failure("分类或关联范围已变化，请重新核对并确认"));
    }
    let changed = plan.before != plan.after;
    if changed {
        match (&plan.before, &plan.after) {
            (None, Some(after)) => {
                let saved = category::ActiveModel {
                    name: Set(after.name.clone()),
                    path_name: Set(after.path_name.clone()),
                    introduce: Set(after.introduce.clone()),
                    icon: Set(after.icon.clone()),
                    color: Set(after.color.clone()),
                    ..Default::default()
                }
                .insert(db)
                .await?;
                let saved = Category::from(saved);
                let mut expected = after.clone();
                expected.id = saved.id;
                if saved != expected {
                    return Err(targets::failure("新分类写入结果不一致"));
                }
                plan.after = Some(saved);
            }
            (Some(before), Some(after)) => {
                let saved = category::ActiveModel {
                    id: Set(before.id.unwrap()),
                    name: Set(after.name.clone()),
                    path_name: Set(after.path_name.clone()),
                    introduce: Set(after.introduce.clone()),
                    icon: Set(after.icon.clone()),
                    color: Set(after.color.clone()),
                }
                .update(db)
                .await?;
                if Category::from(saved) != *after {
                    return Err(targets::failure("分类写入结果不一致"));
                }
            }
            (Some(before), None) => {
                let id = before.id.unwrap();
                if category::Entity::delete_by_id(id)
                    .exec(db)
                    .await?
                    .rows_affected
                    != 1
                    || !targets::references(db, id).await?.is_empty()
                {
                    return Err(targets::failure("分类删除或文章引用未能完整执行"));
                }
            }
            _ => return Err(targets::failure("分类变更计划无效")),
        }
    }
    Ok(Outcome {
        changed,
        before_version: change.version.clone(),
        state: plan,
    })
}

fn response<T: Default>(result: Result<T, sea_orm::DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("category action failed: {error}");
            let message = match error {
                sea_orm::DbErr::Custom(value) => value,
                _ => "分类请求失败，可能存在重名、路径冲突或并发修改；请重新查询".to_owned(),
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
