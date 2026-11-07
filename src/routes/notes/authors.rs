//! Public article attribution shares one profile projection across reader endpoints.
use crate::entity::user;
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use std::collections::HashMap;

pub(crate) struct PublicAuthor {
    pub name: String,
    pub avatar: String,
}

pub(crate) async fn profiles<C: ConnectionTrait>(
    db: &C,
    ids: Vec<i32>,
) -> Result<HashMap<i32, PublicAuthor>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = user::Entity::find()
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Username)
        .column(user::Column::Nickname)
        .column(user::Column::Avatar)
        .filter(user::Column::Id.is_in(ids))
        .into_tuple::<(i32, String, String, Option<String>)>()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, username, nickname, avatar)| {
            let name = if nickname.trim().is_empty() {
                username.trim()
            } else {
                nickname.trim()
            };
            (
                id,
                PublicAuthor {
                    name: name.to_owned(),
                    avatar: avatar.as_deref().unwrap_or("").trim().to_owned(),
                },
            )
        })
        .collect())
}
