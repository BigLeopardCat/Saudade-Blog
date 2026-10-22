use super::Resource;
use crate::entity::{note, note_comment, talk, user};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, Iterable, QueryFilter,
    QueryResult, QuerySelect, Statement,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub resource: Option<Resource>,
    pub id: i32,
    pub exists: bool,
    pub target: Option<Target>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: i32,
    pub user_id: i32,
    pub publisher: Option<Publisher>,
    pub display_name: Option<String>,
    pub article_id: Option<i32>,
    pub article_title: Option<String>,
    pub content: String,
    pub content_truncated: bool,
    pub approved: i16,
    pub reject_reason: Option<String>,
    pub ai_reason: Option<String>,
    pub root_visible: bool,
    pub article_visible: bool,
    pub is_deleted: bool,
    pub affected_replies: i64,
    pub public_replies: i64,
    pub version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    pub id: i32,
    pub username: String,
    pub nickname: String,
    pub role: String,
}

#[derive(Serialize)]
pub(super) struct Content<T> {
    #[serde(flatten)]
    pub row: T,
    pub(super) content_digest: String,
}

impl<T> std::ops::Deref for Content<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.row
    }
}

impl<T: FromQueryResult> FromQueryResult for Content<T> {
    fn from_query_result(result: &QueryResult, prefix: &str) -> Result<Self, DbErr> {
        Ok(Self {
            row: T::from_query_result(result, prefix)?,
            content_digest: result.try_get(prefix, "content_digest")?,
        })
    }
}

pub(super) enum Row {
    Board(Content<talk::Model>),
    Comment(Content<note_comment::Model>),
}

pub(super) async fn row<C: ConnectionTrait>(
    db: &C,
    resource: Resource,
    id: i32,
    lock: bool,
) -> Result<Option<Row>, DbErr> {
    match resource {
        Resource::Boards => {
            let mut query = talk::Entity::find_by_id(id).filter(talk::Column::Src.eq("board"));
            if lock {
                query = query.lock_exclusive();
            }
            let query = query
                .select_only()
                .columns(
                    talk::Column::iter().filter(|column| !matches!(column, talk::Column::Content)),
                )
                .column_as(
                    sea_orm::sea_query::Expr::cust("LEFT(content,501)"),
                    "content",
                )
                .column_as(
                    sea_orm::sea_query::Expr::cust(
                        "encode(sha256(convert_to(content,'UTF8')),'hex')",
                    ),
                    "content_digest",
                );
            Ok(query
                .into_model::<Content<talk::Model>>()
                .one(db)
                .await?
                .map(Row::Board))
        }
        Resource::Comments => {
            let mut query = note_comment::Entity::find_by_id(id);
            if lock {
                query = query.lock_exclusive();
            }
            let query = query
                .select_only()
                .columns(
                    note_comment::Column::iter()
                        .filter(|column| !matches!(column, note_comment::Column::Content)),
                )
                .column_as(
                    sea_orm::sea_query::Expr::cust("LEFT(content,501)"),
                    "content",
                )
                .column_as(
                    sea_orm::sea_query::Expr::cust(
                        "encode(sha256(convert_to(content,'UTF8')),'hex')",
                    ),
                    "content_digest",
                );
            Ok(query
                .into_model::<Content<note_comment::Model>>()
                .one(db)
                .await?
                .map(Row::Comment))
        }
    }
}

async fn publisher<C: ConnectionTrait>(db: &C, uid: i32) -> Result<Option<Publisher>, DbErr> {
    Ok(user::Entity::find_by_id(uid)
        .select_only()
        .column(user::Column::Id)
        .column(user::Column::Username)
        .column(user::Column::Nickname)
        .column(user::Column::Role)
        .into_tuple::<(i32, String, String, String)>()
        .one(db)
        .await?
        .map(|(id, username, nickname, role)| Publisher {
            id,
            username,
            nickname,
            role,
        }))
}

async fn replies<C: ConnectionTrait>(
    db: &C,
    row: &note_comment::Model,
) -> Result<(i64, i64, String), DbErr> {
    if row.root_id.is_some() {
        return Ok((0, 0, String::new()));
    }
    let data = db.query_one(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres,
        "SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE approved=1) AS public, \
         encode(sha256(convert_to(COALESCE(string_agg( \
         id::text || ':' || approved::text || ':' || updated_at::text || ':' || \
         encode(sha256(convert_to(content,'UTF8')),'hex'), ',' ORDER BY id),''),'UTF8')),'hex') AS digest \
         FROM note_comment WHERE root_id=$1 AND note_id=$2 AND is_deleted=0",
        vec![row.id.into(), row.note_id.into()])).await?
        .ok_or_else(|| DbErr::Custom("reply aggregate missing".into()))?;
    Ok((
        data.try_get("", "total")?,
        data.try_get("", "public")?,
        data.try_get("", "digest")?,
    ))
}

pub(super) async fn project<C: ConnectionTrait>(db: &C, row: &Row) -> Result<Target, DbErr> {
    let (mut target, identity) = match row {
        Row::Board(row) => (
            Target {
                id: row.id,
                user_id: row.user_id,
                display_name: Some(row.author.clone()),
                content: row.content.clone(),
                approved: row.approved,
                reject_reason: row.reject_reason.clone(),
                ai_reason: row.ai_reason.clone(),
                root_visible: true,
                article_visible: true,
                ..Default::default()
            },
            serde_json::to_value(row),
        ),
        Row::Comment(row) => (
            Target {
                id: row.id,
                user_id: row.user_id,
                article_id: Some(row.note_id),
                content: row.content.clone(),
                approved: row.approved,
                reject_reason: row.reject_reason.clone(),
                ai_reason: row.ai_reason.clone(),
                root_visible: true,
                article_visible: true,
                is_deleted: row.is_deleted != 0,
                ..Default::default()
            },
            serde_json::to_value(row),
        ),
    };
    if !(0..=2).contains(&target.approved) {
        return Err(DbErr::Custom("unknown review status".into()));
    }
    target.publisher = publisher(db, target.user_id).await?;
    let mut reply_digest = String::new();
    let mut root_identity = None;
    let mut article_identity = None;
    if let Row::Comment(row) = row {
        if let Some(root_id) = row.root_id {
            let root = note_comment::Entity::find_by_id(root_id)
                .select_only()
                .column(note_comment::Column::Id)
                .column(note_comment::Column::NoteId)
                .column(note_comment::Column::Approved)
                .column(note_comment::Column::IsDeleted)
                .column(note_comment::Column::UpdatedAt)
                .into_tuple::<(i32, i32, i16, i16, chrono::NaiveDateTime)>()
                .one(db)
                .await?;
            target.root_visible = root
                .as_ref()
                .is_some_and(|root| root.1 == row.note_id && root.2 == 1 && root.3 == 0);
            root_identity = root.map(|root| serde_json::json!(root));
        }
        article_identity = note::Entity::find_by_id(row.note_id)
            .select_only()
            .column(note::Column::Title)
            .column(note::Column::Status)
            .column(note::Column::IsPublic)
            .column(note::Column::DraftOf)
            .into_tuple::<(String, Option<String>, bool, Option<i32>)>()
            .one(db)
            .await?;
        target.article_title = article_identity.as_ref().map(|article| article.0.clone());
        target.article_visible = article_identity.as_ref().is_some_and(|article| {
            article.2
                && article.3.is_none()
                && matches!(article.1.as_deref(), Some("public" | "published"))
        });
        (target.affected_replies, target.public_replies, reply_digest) = replies(db, row).await?;
        if !target.root_visible
            || !target.article_visible
            || target.approved != 1
            || target.is_deleted
        {
            target.public_replies = 0;
        }
        if !matches!(row.is_deleted, 0 | 1) {
            return Err(DbErr::Custom("unknown deletion state".into()));
        }
    }
    let value = serde_json::json!([
        identity.map_err(|error| DbErr::Custom(error.to_string()))?,
        target.publisher,
        article_identity,
        root_identity,
        target.affected_replies,
        target.public_replies,
        reply_digest
    ]);
    target.version = hex::encode(Sha256::digest(value.to_string().as_bytes()));
    target.content_truncated = target.content.chars().count() > 500;
    for value in [
        &mut target.display_name,
        &mut target.reject_reason,
        &mut target.ai_reason,
    ] {
        if value
            .as_ref()
            .is_some_and(|text| text.chars().count() > 200)
        {
            *value = value.take().map(|text| text.chars().take(200).collect());
            target.content_truncated = true;
        }
    }
    target.content = target.content.chars().take(500).collect();
    if target
        .article_title
        .as_ref()
        .is_some_and(|title| title.chars().count() > 255)
    {
        target.article_title = target
            .article_title
            .map(|title| title.chars().take(255).collect());
        target.content_truncated = true;
    }
    Ok(target)
}

pub(super) async fn load<C: ConnectionTrait>(
    db: &C,
    resource: Resource,
    id: i32,
    lock: bool,
) -> Result<View, DbErr> {
    let target = match row(db, resource, id, lock).await? {
        Some(row) => Some(project(db, &row).await?),
        None => None,
    };
    Ok(View {
        resource: Some(resource),
        id,
        exists: target.is_some(),
        target,
    })
}

pub(super) fn context(row: &Row) -> Option<(i32, Option<i32>)> {
    match row {
        Row::Board(_) => None,
        Row::Comment(row) => Some((row.note_id, row.root_id)),
    }
}

pub(super) async fn lock_context<C: ConnectionTrait>(db: &C, row: &Row) -> Result<(), DbErr> {
    if let Row::Comment(row) = row {
        note::Entity::find_by_id(row.note_id)
            .select_only()
            .column(note::Column::Id)
            .lock_shared()
            .into_tuple::<i32>()
            .one(db)
            .await?;
        if let Some(root) = row.root_id {
            note_comment::Entity::find_by_id(root)
                .select_only()
                .column(note_comment::Column::Id)
                .lock_shared()
                .into_tuple::<i32>()
                .one(db)
                .await?;
        }
    }
    Ok(())
}
