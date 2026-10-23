use super::{Intent, Prepared, Recipient};
use crate::{authz, entity::user, routes::notice};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect,
};
use sha2::{Digest, Sha256};

#[derive(FromQueryResult)]
struct Account {
    id: i32,
    username: String,
    role: String,
    status: i16,
    token_version: i32,
}
pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}
fn clean(value: &str, limit: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && ['\n', '\r', '\t'].contains(&c)))
}
pub(super) fn validate(i: &Intent) -> Result<(), DbErr> {
    let t = &i.target;
    let exact = (t.id.is_some_and(|n| n > 0) && t.username.is_none())
        || (t.id.is_none()
            && t.username
                .as_ref()
                .is_some_and(|s| clean(s, 255, false) && s.trim() == s));
    if !exact
        || !clean(&i.content, notice::CONTENT_MAX, true)
        || i.title.as_ref().is_some_and(|s| {
            s.chars().count() > notice::TITLE_MAX || s.chars().any(char::is_control)
        })
    {
        return Err(failure(
            "需唯一账号编号或完整账号名；标题最多128字，正文需非空且最多1000字",
        ));
    }
    Ok(())
}
fn query() -> sea_orm::Select<user::Entity> {
    user::Entity::find().select_only().columns([
        user::Column::Id,
        user::Column::Username,
        user::Column::Role,
        user::Column::Status,
        user::Column::TokenVersion,
    ])
}
pub(super) async fn prepare<C: ConnectionTrait>(
    db: &C,
    actor_id: i32,
    intent: &Intent,
    lock: bool,
) -> Result<Prepared, DbErr> {
    validate(intent)?;
    let mut actor = query().filter(user::Column::Id.eq(actor_id));
    if lock {
        actor = actor.lock_shared();
    }
    let actor = actor
        .into_model::<Account>()
        .one(db)
        .await?
        .ok_or_else(|| failure("操作账号不存在"))?;
    if !authz::can_access_console(&actor.role) || authz::is_frozen(actor.status) {
        return Err(failure("当前账号无权发送个人通知"));
    }
    let mut target = query();
    target = if let Some(id) = intent.target.id {
        target.filter(user::Column::Id.eq(id))
    } else {
        target.filter(user::Column::Username.eq(intent.target.username.clone().unwrap()))
    };
    if lock {
        target = target.lock_shared();
    }
    let mut rows = target.limit(2).into_model::<Account>().all(db).await?;
    if rows.len() != 1 {
        return Err(failure("收件人不存在或账号名不唯一，请指定唯一账号编号"));
    }
    let target = rows.pop().unwrap();
    if !authz::is_listable_role(&target.role) {
        return Err(failure("该账号不能接收通知"));
    }
    let title = intent
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(notice::DEFAULT_TITLE)
        .to_owned();
    let recipient = Recipient {
        id: target.id,
        username: target.username,
        role: target.role,
    };
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            actor.id,
            actor.role,
            actor.status,
            actor.token_version,
            &recipient,
            &title,
            &intent.content,
        ))
        .map_err(|_| failure("无法计算个人通知确认版本"))?,
    ));
    Ok(Prepared {
        version,
        recipient,
        title,
        content: intent.content.clone(),
    })
}
