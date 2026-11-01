//! One transaction creates missing tags and applies an approved article change.

pub mod batch;
#[cfg(test)]
mod batch_tests;
mod targets;
#[cfg(test)]
mod tests;

use crate::{
    entity::{note, tag_one, tag_two},
    routes::{note_tags, AppState},
    utils::ApiResponse,
};
use axum::{
    extract::{Path, State},
    Json,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, IsolationLevel,
    QueryFilter, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tag {
    pub id: Option<i32>,
    pub level: i16,
    pub name: String,
    pub parent_id: Option<i32>,
    pub color: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    pub replace: Option<Vec<String>>,
    pub level: Option<i16>,
    pub parent_tag: Option<String>,
    pub color: Option<String>,
}
impl Intent {
    fn validate(&self) -> Result<(), DbErr> {
        let lists = [
            self.add.as_slice(),
            self.remove.as_slice(),
            self.replace.as_deref().unwrap_or(&[]),
        ];
        if (self.replace.is_some() && (!self.add.is_empty() || !self.remove.is_empty()))
            || (self.replace.is_none() && self.add.is_empty() && self.remove.is_empty())
            || self.level.is_some_and(|v| !matches!(v, 1 | 2))
            || (self.level == Some(1) && self.parent_tag.is_some())
            || self
                .parent_tag
                .as_ref()
                .is_some_and(|v| v.trim().is_empty() || v.chars().count() > 40)
            || self.color.as_ref().is_some_and(|v| {
                v.len() != 7
                    || !v.starts_with('#')
                    || !v[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(targets::failure("标签参数无效，请核对操作、层级与颜色"));
        }
        if lists.iter().map(|list| list.len()).sum::<usize>() > 10 {
            return Err(targets::failure("每次操作合计最多10个标签名"));
        }
        for list in lists {
            let unique: HashSet<_> = list.iter().collect();
            if list.len() > 10
                || unique.len() != list.len()
                || list
                    .iter()
                    .any(|v| v.trim().is_empty() || v.chars().count() > 40)
            {
                return Err(targets::failure(
                    "标签名应非空、最多40字，且同一列表不可重复",
                ));
            }
        }
        if self.add.iter().any(|v| self.remove.contains(v)) {
            return Err(targets::failure("不能同时新增和移除同一标签"));
        }
        Ok(())
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub id: i32,
    pub title: String,
    pub version: String,
    pub before: Vec<Tag>,
    pub after: Vec<Tag>,
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

async fn apply<C: ConnectionTrait>(db: &C, id: i32, change: &Change) -> Result<Outcome, DbErr> {
    if change.version.len() != 64 || !change.version.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(targets::failure("确认版本无效，请重新准备操作"));
    }
    let plan = targets::prepare(db, id, &change.intent, true).await?;
    if plan.version != change.version {
        return Err(targets::failure("文章或标签已变化，请重新核对并确认"));
    }
    apply_prepared(db, plan, &change.version).await
}

async fn apply_prepared<C: ConnectionTrait>(
    db: &C,
    mut plan: Prepared,
    version: &str,
) -> Result<Outcome, DbErr> {
    let id = plan.id;
    let changed = plan.before != plan.after;
    if changed {
        let mut refs = Vec::with_capacity(plan.after.len());
        for tag in &mut plan.after {
            let id = if let Some(id) = tag.id {
                id
            } else if let Some(existing) =
                targets::named(db, &tag.name, Some(tag.level), tag.parent_id, true).await?
            {
                if existing.color != tag.color {
                    return Err(targets::failure("新标签属性已变化，请重新准备操作"));
                }
                existing.id.unwrap()
            } else if tag.level == 1 {
                tag_one::ActiveModel {
                    name: Set(tag.name.clone()),
                    color: Set(tag.color.clone()),
                    ..Default::default()
                }
                .insert(db)
                .await?
                .id
            } else {
                tag_two::ActiveModel {
                    name: Set(tag.name.clone()),
                    color: Set(tag.color.clone()),
                    tag_one_id: Set(tag.parent_id),
                    ..Default::default()
                }
                .insert(db)
                .await?
                .id
            };
            tag.id = Some(id);
            refs.push((tag.level, id));
        }
        note_tags::replace_typed_note_tags(db, id, &refs).await?;
        let updated = note::Entity::update_many()
            .col_expr(
                note::Column::UpdatedAt,
                sea_orm::sea_query::Expr::value(chrono::Local::now().naive_local()),
            )
            .filter(note::Column::Id.eq(id))
            .filter(note::Column::DraftOf.is_null())
            .exec(db)
            .await?;
        if updated.rows_affected != 1 {
            return Err(targets::failure("文章标签变更未生效"));
        }
        let actual = targets::current(db, id).await?;
        if actual != plan.after {
            return Err(targets::failure("实际标签与确认目标不一致，事务已回滚"));
        }
    }
    Ok(Outcome {
        changed,
        before_version: version.to_owned(),
        state: plan,
    })
}

fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(error) => {
            tracing::warn!("article tag request failed: {error}");
            // Domain errors contain no article content or credentials.
            let message = match error {
                DbErr::Custom(ref text) => format!("标签变更未完成：{text}"),
                _ => "文章或标签读取失败，请重新核对后确认".to_owned(),
            };
            Json(ApiResponse::error(&message))
        }
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let plan = targets::prepare(&txn, id, &intent, false).await?;
        txn.commit().await?;
        Ok(plan)
    }
    .await;
    response(result)
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    let result = async {
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::Serializable), None)
            .await?;
        let outcome = apply(&txn, id, &change).await?;
        txn.commit().await?;
        Ok(outcome)
    }
    .await;
    response(result)
}
