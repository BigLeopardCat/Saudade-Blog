use super::{Account, Action, Intent, Prepared};
use crate::{authz, entity::user, routes::temp_user};
use chrono::{FixedOffset, NaiveDateTime, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement,
};
use sha2::{Digest, Sha256};

pub(super) fn failure(message: &str) -> DbErr {
    DbErr::Custom(message.to_owned())
}
/// Account timestamps use Shanghai wall-clock values, regardless of server TZ.
pub(super) fn now() -> NaiveDateTime {
    Utc::now()
        .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .naive_local()
}
pub(super) fn validate(
    intent: &Intent,
    now: NaiveDateTime,
) -> Result<Option<NaiveDateTime>, DbErr> {
    let target = &intent.target;
    if (target.id.is_none() && target.username.is_none())
        || target.id.is_some_and(|id| id <= 0)
        || target.username.as_ref().is_some_and(|v| {
            v.is_empty()
                || v.trim() != v
                || v.chars().count() > 255
                || v.chars().any(char::is_control)
        })
    {
        return Err(failure("请指定唯一编号或完整账号名，不接受昵称或模糊匹配"));
    }
    if (intent.action == Action::SetRole) != intent.role.is_some()
        || (intent.action == Action::Mute) != intent.muted_until.is_some()
    {
        return Err(failure(
            "变更身份须且仅须填写role；禁言须且仅须填写mutedUntil；其他字段不得隐式修改",
        ));
    }
    if intent
        .role
        .as_ref()
        .is_some_and(|v| v.trim() != v || !authz::is_known_role(v))
    {
        return Err(failure("站内没有这个身份"));
    }
    intent
        .muted_until
        .as_ref()
        .map(|value| {
            if value.len() != 19 {
                return Err(failure(
                    "禁言到期必须为四位年份的北京时间YYYY-MM-DDTHH:MM:SS",
                ));
            }
            let until =
                NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").map_err(|_| {
                    failure("禁言到期需为北京时间YYYY-MM-DDTHH:MM:SS，永久为9999-12-31T23:59:59")
                })?;
            if until.format("%Y-%m-%dT%H:%M:%S").to_string() != *value || until <= now {
                return Err(failure("禁言到期时间无效或已到期，请重新核对并确认"));
            }
            Ok(until)
        })
        .transpose()
}
pub(super) enum PolicyDenial {
    ActorNotPermitted,
    TargetRoleUnknown,
    State(authz::FreezeDenial),
    Role(authz::RoleChangeDenial),
}

impl PolicyDenial {
    pub(super) fn code(&self) -> &'static str {
        use authz::{FreezeDenial as F, RoleChangeDenial as R};
        match self {
            Self::ActorNotPermitted
            | Self::State(F::NotPermitted)
            | Self::Role(R::NotPermitted) => "actor_not_permitted",
            Self::TargetRoleUnknown => "target_role_unknown",
            Self::State(F::SelfTarget) | Self::Role(R::SelfTarget) => "self_target",
            Self::State(F::TargetSuperadmin) | Self::Role(R::TargetSuperadmin) => {
                "target_superadmin"
            }
            Self::State(F::PeerAdmin) => "peer_admin",
            Self::Role(R::UnknownRole) => "unknown_role",
            Self::Role(R::NotAssignable) => "role_not_assignable",
            Self::Role(R::AdminTargetTier) => "admin_target_tier",
            Self::Role(R::AdminAssignTier) => "admin_assign_tier",
        }
    }

    pub(super) fn message(self, action: &Action) -> String {
        match self {
            Self::ActorNotPermitted => "只有有效的管理员账号可以管理账号".into(),
            Self::TargetRoleUnknown => "该账号角色未登记，不能改状态".into(),
            Self::Role(denial) => temp_user::role_change_denial_message(denial),
            Self::State(denial) => {
                if matches!(action, Action::Mute | Action::Unmute) {
                    temp_user::mute_denial_message(denial, *action == Action::Mute)
                } else {
                    temp_user::freeze_denial_message(denial, *action == Action::Freeze)
                }
            }
        }
    }
}

pub(super) fn policy(
    actor: &user::Model,
    target: &user::Model,
    action: &Action,
    role: Option<&str>,
) -> Result<(), PolicyDenial> {
    if authz::is_frozen(actor.status) || !authz::can_access_console(&actor.role) {
        return Err(PolicyDenial::ActorNotPermitted);
    }
    if *action == Action::SetRole {
        authz::check_role_change(
            actor.id,
            &actor.role,
            target.id,
            &target.role,
            role.unwrap_or(""),
        )
        .map_err(PolicyDenial::Role)
    } else {
        if !authz::is_known_role(&target.role) {
            return Err(PolicyDenial::TargetRoleUnknown);
        }
        authz::check_freeze(actor.id, &actor.role, target.id, &target.role)
            .map_err(PolicyDenial::State)
    }
}

pub(super) fn authorize(
    actor: &user::Model,
    target: &user::Model,
    intent: &Intent,
) -> Result<(), DbErr> {
    policy(actor, target, &intent.action, intent.role.as_deref())
        .map_err(|denial| failure(&denial.message(&intent.action)))
}
pub(super) async fn revision<C: ConnectionTrait>(db: &C, id: i32) -> Result<i64, DbErr> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT account_action_version FROM \"user\" WHERE id=$1",
            vec![id.into()],
        ))
        .await?
        .ok_or_else(|| failure("用户不存在"))?;
    row.try_get("", "account_action_version")
}
pub(super) async fn resolve<C: ConnectionTrait>(db: &C, intent: &Intent) -> Result<i32, DbErr> {
    validate(intent, now())?;
    if let Some(id) = intent.target.id {
        return Ok(id);
    }
    let rows = user::Entity::find()
        .filter(user::Column::Username.eq(intent.target.username.as_ref().unwrap()))
        .limit(2)
        .all(db)
        .await?;
    if rows.len() != 1 {
        return Err(failure("完整账号名未命中唯一账号，请明确唯一编号"));
    }
    Ok(rows[0].id)
}
/// Lock both principals in stable order to avoid crossed administrator operations deadlocking.
pub(super) async fn prepare<C: ConnectionTrait>(
    db: &C,
    actor_id: i32,
    claims_ver: Option<i32>,
    intent: &Intent,
    lock: bool,
) -> Result<(Prepared, user::Model, user::Model), DbErr> {
    let until = validate(intent, now())?;
    let target_id = resolve(db, intent).await?;
    let mut query = user::Entity::find()
        .filter(user::Column::Id.is_in([actor_id, target_id]))
        .order_by_asc(user::Column::Id);
    if lock {
        query = query.lock_exclusive();
    }
    let rows = query.all(db).await?;
    let actor = rows
        .iter()
        .find(|v| v.id == actor_id)
        .ok_or_else(|| failure("未登录"))?
        .clone();
    let target = rows
        .iter()
        .find(|v| v.id == target_id)
        .ok_or_else(|| failure("用户不存在"))?
        .clone();
    if authz::check_token(actor.status, actor.token_version, claims_ver).is_err() {
        return Err(failure("登录状态已变化，请重新登录"));
    }
    // A username may have changed between exact resolution and obtaining row locks.
    if intent
        .target
        .username
        .as_ref()
        .is_some_and(|v| *v != target.username)
    {
        return Err(failure("账号身份已变化，请重新查询"));
    }
    authorize(&actor, &target, intent)?;
    let before = Account::from(&target);
    let mut after = before.clone();
    match intent.action {
        Action::Freeze => after.status = authz::STATUS_FROZEN,
        Action::Unfreeze => after.status = authz::STATUS_ACTIVE,
        Action::SetRole => after.role = intent.role.clone().unwrap(),
        Action::Mute => {
            after.muted_until = until.map(|v| v.format("%Y-%m-%dT%H:%M:%S").to_string())
        }
        Action::Unmute => after.muted_until = None,
    }
    let changed = before != after || intent.action == Action::Freeze;
    let revoke_sessions = changed && matches!(intent.action, Action::Freeze | Action::SetRole);
    // Hash explicit business fields; revisions detect ABA across every account write path.
    let digest = serde_json::to_vec(&(
        intent,
        &before,
        &after,
        actor.id,
        &actor.role,
        actor.status,
        actor.token_version,
        target.token_version,
        revision(db, actor.id).await?,
        revision(db, target.id).await?,
    ))
    .map_err(|_| failure("账号计划序列化失败"))?;
    let version = hex::encode(Sha256::digest(digest));
    Ok((
        Prepared {
            version,
            before,
            after,
            changed,
            revoke_sessions,
            notification_count: u8::from(changed),
        },
        actor,
        target,
    ))
}
