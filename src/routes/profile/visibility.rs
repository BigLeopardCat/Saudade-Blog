//! Each participant controls only their own inbox or outbox visibility.

use crate::entity::{user_message, user_notification};
use sea_orm::{ColumnTrait, Condition};

pub(super) fn notifications(uid: i32) -> Condition {
    Condition::all()
        .add(user_notification::Column::UserId.eq(uid))
        .add(user_notification::Column::DeletedAt.is_null())
}

pub(super) fn inbox(uid: i32) -> Condition {
    Condition::all()
        .add(user_message::Column::ToUserId.eq(uid))
        .add(user_message::Column::RecipientDeletedAt.is_null())
}

pub(super) fn outbox(uid: i32) -> Condition {
    Condition::all()
        .add(user_message::Column::FromUserId.eq(uid))
        .add(user_message::Column::SenderDeletedAt.is_null())
}

pub(super) fn message(uid: i32) -> Condition {
    Condition::any().add(inbox(uid)).add(outbox(uid))
}
