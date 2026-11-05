//! Version-bound administrator posts, isolated from guestbook moderation.
use crate::{
    entity::{talk, user},
    routes::AppState,
    utils::ApiResponse,
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseTransaction, DbErr, EntityTrait,
    IsolationLevel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Delete,
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
    pub id: Option<i32>,
    #[serde(default)]
    pub fields: Fields,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: Option<i32>,
    pub title: String,
    pub content: String,
    pub author_id: i32,
}
impl From<&talk::Model> for Post {
    fn from(row: &talk::Model) -> Self {
        Self {
            id: Some(row.id),
            title: row.title.clone().unwrap_or_default(),
            content: row.content.clone(),
            author_id: row.user_id,
        }
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: String,
    pub before: Option<Post>,
    pub after: Option<Post>,
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
fn error(message: &str) -> DbErr {
    DbErr::Custom(message.into())
}
fn validate(intent: &Intent) -> Result<(), DbErr> {
    if (intent.action == Action::Create && (intent.id.is_some() || intent.fields.content.is_none()))
        || (intent.action != Action::Create && intent.id.is_none_or(|id| id <= 0))
        || (intent.action == Action::Delete && intent.fields != Fields::default())
        || (intent.action == Action::Update && intent.fields == Fields::default())
        || intent
            .fields
            .title
            .as_ref()
            .is_some_and(|v| v.chars().count() > 100 || v.chars().any(char::is_control))
        || intent
            .fields
            .content
            .as_ref()
            .is_some_and(|v| v.trim().is_empty() || v.chars().count() > 500 || v.contains('\0'))
    {
        return Err(error("说说操作、目标、标题或正文无效"));
    }
    Ok(())
}
async fn actor<C: ConnectionTrait>(db: &C, uid: i32) -> Result<user::Model, DbErr> {
    let row = user::Entity::find_by_id(uid)
        .one(db)
        .await?
        .ok_or_else(|| error("账号不存在"))?;
    if crate::authz::is_frozen(row.status) || !crate::authz::can_access_console(&row.role) {
        return Err(error("需要有效管理员身份"));
    }
    Ok(row)
}
async fn plan(db: &DatabaseTransaction, uid: i32, intent: &Intent) -> Result<Prepared, DbErr> {
    validate(intent)?;
    actor(db, uid).await?;
    let row = if let Some(id) = intent.id {
        Some(
            talk::Entity::find_by_id(id)
                .filter(talk::Column::Src.eq("talk"))
                .lock_exclusive()
                .one(db)
                .await?
                .ok_or_else(|| error("说说不存在；河灯留言必须通过审核接口处理"))?,
        )
    } else {
        None
    };
    let before = row.as_ref().map(Post::from);
    let mut after = before.clone().or_else(|| {
        Some(Post {
            author_id: uid,
            ..Default::default()
        })
    });
    if intent.action == Action::Delete {
        after = None;
    } else if let Some(post) = after.as_mut() {
        if let Some(title) = &intent.fields.title {
            post.title = title.clone();
        }
        if let Some(content) = &intent.fields.content {
            post.content = content.clone();
        }
    }
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(uid, intent, &row)).map_err(|e| error(&e.to_string()))?,
    ));
    Ok(Prepared {
        version,
        before,
        after,
    })
}
pub(super) async fn apply(
    db: &DatabaseTransaction,
    uid: i32,
    change: &Change,
) -> Result<Outcome, DbErr> {
    let mut state = plan(db, uid, &change.intent).await?;
    if change.version.len() != 64 || change.version != state.version {
        return Err(error("说说已变化，请重新核对并确认"));
    }
    let changed = state.before != state.after;
    if changed {
        match (&state.before, &mut state.after) {
            (None, Some(after)) => {
                let owner = actor(db, uid).await?;
                let saved = talk::ActiveModel {
                    title: Set(Some(after.title.clone())),
                    content: Set(after.content.clone()),
                    user_id: Set(uid),
                    author: Set(owner.nickname),
                    src: Set("talk".into()),
                    cat: Set("愿".into()),
                    v: Set(0),
                    approved: Set(1),
                    created_at: Set(chrono::Local::now().naive_local()),
                    updated_at: Set(chrono::Local::now().naive_local()),
                    ..Default::default()
                }
                .insert(db)
                .await?;
                after.id = Some(saved.id);
                if Post::from(&saved) != *after {
                    return Err(error("说说创建回执不一致"));
                }
            }
            (Some(before), Some(after)) => {
                let saved = talk::ActiveModel {
                    id: Set(before.id.unwrap()),
                    title: Set(Some(after.title.clone())),
                    content: Set(after.content.clone()),
                    updated_at: Set(chrono::Local::now().naive_local()),
                    ..Default::default()
                }
                .update(db)
                .await?;
                if Post::from(&saved) != *after {
                    return Err(error("说说修改回执不一致"));
                }
            }
            (Some(before), None) => {
                if talk::Entity::delete_by_id(before.id.unwrap())
                    .exec(db)
                    .await?
                    .rows_affected
                    != 1
                {
                    return Err(error("说说删除结果不一致"));
                }
            }
            _ => return Err(error("说说计划无效")),
        }
    }
    Ok(Outcome {
        changed,
        before_version: change.version.clone(),
        state,
    })
}
pub(super) async fn direct(
    state: &AppState,
    headers: &HeaderMap,
    intent: Intent,
) -> Result<Outcome, DbErr> {
    let uid = crate::auth_jwt::auth_uid(&state.db, headers)
        .await
        .map_err(|_| error("未登录"))?;
    let txn = state
        .db
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await?;
    let prepared = plan(&txn, uid, &intent).await?;
    let outcome = apply(
        &txn,
        uid,
        &Change {
            version: prepared.version,
            intent,
        },
    )
    .await?;
    txn.commit().await?;
    Ok(outcome)
}

fn response<T: Default>(result: Result<T, DbErr>) -> Json<ApiResponse<T>> {
    match result {
        Ok(value) => Json(ApiResponse::success(value)),
        Err(e) => {
            tracing::warn!(error=%e,"administrator post action failed");
            Json(ApiResponse::error(match &e {
                DbErr::Custom(message) => message,
                _ => "说说请求失败，请重新查询实际状态",
            }))
        }
    }
}
pub async fn prepare(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(intent): Json<Intent>,
) -> Json<ApiResponse<Prepared>> {
    let result = async {
        let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
            .await
            .map_err(|_| error("未登录"))?;
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let prepared = plan(&txn, uid, &intent).await?;
        txn.commit().await?;
        Ok(prepared)
    }
    .await;
    response(result)
}
pub async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Json<ApiResponse<Outcome>> {
    let result = async {
        let uid = crate::auth_jwt::auth_uid(&state.db, &headers)
            .await
            .map_err(|_| error("未登录"))?;
        let txn = state
            .db
            .begin_with_config(Some(IsolationLevel::Serializable), None)
            .await?;
        let outcome = apply(&txn, uid, &change).await?;
        txn.commit().await?;
        Ok(outcome)
    }
    .await;
    response(result)
}
#[derive(Deserialize)]
pub struct Page {
    pub page: Option<u64>,
    pub limit: Option<u64>,
}
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<Page>,
) -> Json<ApiResponse<serde_json::Value>> {
    let result=async{let uid=crate::auth_jwt::auth_uid(&state.db,&headers).await.map_err(|_|error("未登录"))?;actor(&state.db,uid).await?;
        let page=q.page.unwrap_or(1);let limit=q.limit.unwrap_or(5);
        if page==0||page>1000||!(1..=10).contains(&limit){return Err(error("分页参数无效"));}
        let pages=talk::Entity::find().filter(talk::Column::Src.eq("talk")).order_by_desc(talk::Column::Id).paginate(&state.db,limit);
        let total=pages.num_items().await?;let rows=pages.fetch_page(page-1).await?;
        Ok(serde_json::json!({"items":rows.iter().map(Post::from).collect::<Vec<_>>(),"total":total,"page":page}))}.await;
    response(result)
}
#[cfg(test)]
mod tests;
