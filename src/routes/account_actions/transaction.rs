use super::{targets, Action, Intent, Outcome};
use crate::{
    entity::user,
    routes::{notice, temp_user},
};
use sea_orm::{ActiveModelTrait, ConnectionTrait, DbErr, Set};

pub(super) async fn apply<C: ConnectionTrait>(
    db: &C,
    actor_id: i32,
    claims_ver: Option<i32>,
    intent: &Intent,
    version: Option<&str>,
) -> Result<Outcome, DbErr> {
    let (plan, actor, target) = targets::prepare(db, actor_id, claims_ver, intent, true).await?;
    if version.is_some_and(|v| v.len() != 64 || v != plan.version) {
        return Err(targets::failure(
            "账号、操作者权限或业务版本已变化，请重新核对并确认",
        ));
    }
    if plan.changed {
        let expected_ver = if plan.revoke_sessions {
            target
                .token_version
                .checked_add(1)
                .ok_or_else(|| targets::failure("账号登录代次超限，请联系维护者"))?
        } else {
            target.token_version
        };
        let mut update: user::ActiveModel = target.clone().into();
        match intent.action {
            Action::Freeze | Action::Unfreeze => update.status = Set(plan.after.status),
            Action::SetRole => update.role = Set(plan.after.role.clone()),
            Action::Mute | Action::Unmute => {
                update.muted_until = Set(targets::validate(intent, targets::now())?)
            }
        }
        if plan.revoke_sessions {
            update.token_version = Set(expected_ver);
        }
        let saved = update.update(db).await?;
        if super::Account::from(&saved) != plan.after || saved.token_version != expected_ver {
            return Err(targets::failure("账号写入结果不一致，事务已取消"));
        }
        let when = targets::now().format("%Y年%m月%d日 %H:%M").to_string();
        let by = temp_user::actor_label(&actor);
        let (title, body) = match intent.action {
            Action::Freeze => (
                "账号已被冻结",
                temp_user::account_change_body(&format!("{by}冻结了你的账号"), &when),
            ),
            // Unfreezing does not invalidate sessions; never claim it does.
            Action::Unfreeze => (
                "账号已解冻",
                format!("{when}，{by}解冻了你的账号。冻结前已收回的登录状态不会恢复，请重新登录。"),
            ),
            Action::SetRole => (
                "账号身份已变更",
                temp_user::account_change_body(
                    &format!(
                        "{by}把你的身份从「{}」改为「{}」",
                        crate::authz::role_label(&target.role),
                        crate::authz::role_label(&plan.after.role)
                    ),
                    &when,
                ),
            ),
            Action::Mute => {
                let until = targets::validate(intent, targets::now())?.unwrap();
                (
                    "账号已被禁言",
                    temp_user::mute_change_body(
                        true,
                        &format!(
                            "{by}禁言了你的账号（{}）",
                            crate::authz::mute_until_text(until)
                        ),
                        &when,
                    ),
                )
            }
            Action::Unmute => (
                "账号已解除禁言",
                temp_user::mute_change_body(false, &format!("{by}解除了你的禁言"), &when),
            ),
        };
        notice::push_notice_checked_at(db, target.id, title, Some(body), None, targets::now())
            .await
            .map_err(|_| targets::failure("账号通知写入失败，事务已取消"))?;
    }
    Ok(Outcome {
        changed: plan.changed,
        before_version: plan.version.clone(),
        state: plan,
    })
}
