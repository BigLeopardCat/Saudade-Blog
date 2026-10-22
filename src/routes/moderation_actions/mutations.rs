use super::{
    targets::{self, Row},
    Action, Change, Resource,
};
use crate::entity::{note_comment, talk, user};
use chrono::SubsecRound;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QuerySelect,
    Set, TransactionTrait,
};
use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub(super) resource: Option<Resource>,
    pub(super) id: i32,
    pub(super) action: Option<Action>,
    pub(super) actor_id: i32,
    pub(super) confirmed_version: String,
    pub(super) changed: bool,
    pub(super) approved: i16,
    pub(super) is_deleted: bool,
    pub(super) notifications: usize,
}

pub(super) fn reject_reason(saved: Option<&str>, ai: Option<&str>) -> Option<String> {
    saved
        .into_iter()
        .chain(ai)
        .map(str::trim)
        .find(|reason| !reason.is_empty())
        .map(str::to_owned)
}

fn error(message: &str) -> DbErr {
    DbErr::Custom(message.into())
}

async fn authorize<C: ConnectionTrait>(db: &C, actor: i32) -> Result<(), DbErr> {
    let account = user::Entity::find_by_id(actor)
        .select_only()
        .column(user::Column::Role)
        .column(user::Column::Status)
        .lock_shared()
        .into_tuple::<(String, i16)>()
        .one(db)
        .await?;
    if !account.is_some_and(|(role, status)| {
        crate::authz::can_access_console(&role) && !crate::authz::is_frozen(status)
    }) {
        return Err(error("operator cannot moderate"));
    }
    Ok(())
}

pub(super) async fn apply_in<C: ConnectionTrait>(
    db: &C,
    actor: i32,
    resource: Resource,
    id: i32,
    change: &Change,
) -> Result<Receipt, DbErr> {
    authorize(db, actor).await?;
    let before = targets::row(db, resource, id, false)
        .await?
        .ok_or_else(|| error("target missing"))?;
    targets::lock_context(db, &before).await?;
    let row = targets::row(db, resource, id, true)
        .await?
        .ok_or_else(|| error("target missing"))?;
    if targets::context(&before) != targets::context(&row) {
        return Err(error("comment ancestry changed"));
    }
    let target = targets::project(db, &row).await?;
    if target.version != change.version || target.content_truncated {
        return Err(error("target changed or incomplete"));
    }
    let mut receipt = Receipt {
        resource: Some(resource),
        id,
        action: Some(change.action),
        actor_id: actor,
        confirmed_version: change.version.clone(),
        approved: target.approved,
        is_deleted: target.is_deleted,
        ..Default::default()
    };
    if target.is_deleted {
        if change.action == Action::Delete {
            return Ok(receipt);
        }
        return Err(error("deleted comments cannot be audited"));
    }
    let approved = if change.action == Action::Pass { 1 } else { 2 };
    if change.action != Action::Delete && target.approved == approved {
        return Ok(receipt);
    }
    match &row {
        Row::Board(row) => board(db, row, change.action, approved).await?,
        Row::Comment(row) => comment(db, row, change.action, approved).await?,
    }
    receipt.changed = true;
    receipt.is_deleted = change.action == Action::Delete;
    if !receipt.is_deleted {
        receipt.approved = approved;
        receipt.notifications = notifications(db, &row, &target, approved).await?;
    }
    Ok(receipt)
}

async fn board<C: ConnectionTrait>(
    db: &C,
    row: &talk::Model,
    action: Action,
    approved: i16,
) -> Result<(), DbErr> {
    let affected = if action == Action::Delete {
        talk::Entity::delete_many()
            .filter(talk::Column::Id.eq(row.id))
            .filter(talk::Column::Src.eq("board"))
            .filter(talk::Column::UpdatedAt.eq(row.updated_at))
            .exec(db)
            .await?
            .rows_affected
    } else {
        let reason = if approved == 2 {
            reject_reason(row.reject_reason.as_deref(), row.ai_reason.as_deref())
        } else {
            None
        };
        talk::Entity::update_many()
            .set(talk::ActiveModel {
                approved: Set(approved),
                reject_reason: Set(reason),
                updated_at: Set(chrono::Local::now().naive_local().trunc_subsecs(6)),
                ..Default::default()
            })
            .filter(talk::Column::Id.eq(row.id))
            .filter(talk::Column::Src.eq("board"))
            .filter(talk::Column::UpdatedAt.eq(row.updated_at))
            .exec(db)
            .await?
            .rows_affected
    };
    if affected != 1 {
        return Err(error("board conditional write missed"));
    }
    Ok(())
}

async fn comment<C: ConnectionTrait>(
    db: &C,
    row: &note_comment::Model,
    action: Action,
    approved: i16,
) -> Result<(), DbErr> {
    let mut changes = note_comment::ActiveModel {
        updated_at: Set(chrono::Local::now().naive_local().trunc_subsecs(6)),
        ..Default::default()
    };
    if action == Action::Delete {
        changes.is_deleted = Set(1);
    } else {
        changes.approved = Set(approved);
        changes.reject_reason = Set(if approved == 2 {
            reject_reason(row.reject_reason.as_deref(), row.ai_reason.as_deref())
        } else {
            None
        });
    }
    let affected = note_comment::Entity::update_many()
        .set(changes)
        .filter(note_comment::Column::Id.eq(row.id))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .filter(note_comment::Column::UpdatedAt.eq(row.updated_at))
        .exec(db)
        .await?
        .rows_affected;
    if affected != 1 {
        return Err(error("comment conditional write missed"));
    }
    Ok(())
}

async fn notifications<C: ConnectionTrait>(
    db: &C,
    row: &Row,
    target: &targets::Target,
    approved: i16,
) -> Result<usize, DbErr> {
    match row {
        Row::Board(row) if target.publisher.is_some() => {
            let reason = if approved == 2 {
                reject_reason(row.reject_reason.as_deref(), row.ai_reason.as_deref())
            } else {
                None
            };
            let (title, body) = crate::routes::talks::review_notice_text(
                approved,
                &crate::routes::talks::talk_brief(&row.content),
                reason.as_deref(),
            )
            .ok_or_else(|| error("invalid moderation notification"))?;
            crate::routes::notice::push_notice_checked(
                db,
                row.user_id,
                &title,
                Some(body),
                Some(format!("/guestbook?lid={}", row.id)),
            )
            .await
            .map_err(|message| error(&message))?;
            Ok(1)
        }
        Row::Comment(row) if approved == 1 && target.root_visible && target.article_visible => {
            let Some(recipient) = row
                .reply_to_uid
                .filter(|uid| *uid > 0 && *uid != row.user_id)
            else {
                return Ok(0);
            };
            if user::Entity::find_by_id(recipient)
                .select_only()
                .column(user::Column::Id)
                .into_tuple::<i32>()
                .one(db)
                .await?
                .is_none()
            {
                return Ok(0);
            }
            crate::routes::comments::notify_comment_reply_checked(
                db,
                recipient,
                row.note_id,
                row.id,
                row.user_id,
                &row.content,
            )
            .await
            .map_err(|message| error(&message))?;
            Ok(1)
        }
        _ => Ok(0),
    }
}

pub(super) async fn apply(
    db: &DatabaseConnection,
    actor: i32,
    resource: Resource,
    id: i32,
    change: &Change,
) -> Result<Receipt, DbErr> {
    let txn = db.begin().await?;
    let receipt = apply_in(&txn, actor, resource, id, change).await?;
    txn.commit().await?;
    Ok(receipt)
}
