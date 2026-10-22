//! Article catalog excludes editor shadow drafts and never selects article bodies.

use axum::{
    extract::{Query, State},
    Json,
};
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr},
    ColumnTrait, Condition, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait, Statement,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    entity::{category, note, note_tag, tag_one, tag_two},
    routes::AppState,
    utils::ApiResponsePage,
};

#[derive(Default, Deserialize)]
pub struct ArticleQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub id: Option<i32>,
    pub keyword: Option<String>,
    pub category: Option<String>,
    pub category_id: Option<i32>,
}

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: i32,
    pub title: String,
    pub status: Option<String>,
    pub is_public: bool,
    pub is_top: Option<i32>,
    pub category_id: Option<i32>,
    pub category_name: Option<String>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
    #[sea_orm(skip)]
    pub tags: Vec<Tag>,
    #[sea_orm(skip)]
    pub tags_truncated: bool,
}

#[derive(Serialize)]
pub struct Tag {
    pub id: i32,
    pub level: u8,
    pub name: String,
}

#[derive(FromQueryResult)]
struct TagRow {
    note_id: i32,
    one_id: Option<i32>,
    one_name: Option<String>,
    two_id: Option<i32>,
    two_name: Option<String>,
}

pub(super) fn query(
    params: &ArticleQuery,
    category_id: Option<i32>,
) -> sea_orm::Select<note::Entity> {
    let mut query = note::Entity::find().filter(note::Column::DraftOf.is_null());
    if let Some(id) = params.id {
        query = query.filter(note::Column::Id.eq(id));
    }
    if let Some(id) = params.category_id {
        query = query.filter(note::Column::CategoryId.eq(id));
    }
    if let Some(id) = category_id {
        query = query.filter(note::Column::CategoryId.eq(id));
    }
    if let Some(keyword) = &params.keyword {
        let pattern = super::pattern(keyword);
        let tags = note_tag::Entity::find()
            .select_only()
            .column(note_tag::Column::NoteId)
            .left_join(tag_one::Entity)
            .left_join(tag_two::Entity)
            .filter(
                Condition::any()
                    .add(Expr::col((tag_one::Entity, tag_one::Column::Name)).ilike(&pattern))
                    .add(Expr::col((tag_two::Entity, tag_two::Column::Name)).ilike(&pattern)),
            )
            .into_query();
        query = query.filter(
            Condition::any()
                .add(Expr::col(note::Column::Title).ilike(&pattern))
                .add(Expr::col(note::Column::Content).ilike(&pattern))
                .add(note::Column::Id.in_subquery(tags)),
        );
    }
    query
        .order_by_desc(note::Column::CreatedAt)
        .order_by_desc(note::Column::Id)
}

async fn attach_tags<C: ConnectionTrait>(db: &C, articles: &mut [Article]) -> Result<(), DbErr> {
    let ids: Vec<i32> = articles.iter().map(|row| row.id).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let slots = (1..=ids.len())
        .map(|index| format!("(${index}::integer)"))
        .collect::<Vec<_>>()
        .join(",");
    let rows = TagRow::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "SELECT links.note_id, links.tag_one_id AS one_id, one_tag.name AS one_name, \
                 links.tag_two_id AS two_id, two_tag.name AS two_name \
                 FROM (VALUES {slots}) AS requested(note_id) \
                 CROSS JOIN LATERAL (SELECT note_id,seq,tag_one_id,tag_two_id FROM note_tag \
                    WHERE note_id=requested.note_id ORDER BY seq LIMIT 21) AS links \
                 LEFT JOIN tag_one AS one_tag ON links.tag_one_id=one_tag.id \
                 LEFT JOIN tag_two AS two_tag ON links.tag_two_id=two_tag.id \
                 ORDER BY links.note_id,links.seq"
        ),
        ids.into_iter().map(Into::into).collect::<Vec<_>>(),
    ))
    .all(db)
    .await?;
    for row in rows {
        let tag = match (row.one_id, row.one_name, row.two_id, row.two_name) {
            (Some(id), Some(name), None, None) => Tag { id, name, level: 1 },
            (None, None, Some(id), Some(name)) => Tag { id, name, level: 2 },
            _ => return Err(DbErr::Custom("invalid article tag reference".into())),
        };
        if let Some(article) = articles
            .iter_mut()
            .find(|article| article.id == row.note_id)
        {
            if article.tags.len() < 20 {
                article.tags.push(tag);
            } else {
                article.tags_truncated = true;
            }
        }
    }
    Ok(())
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &ArticleQuery,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Article>, i64), DbErr> {
    read_view(db, params, limit, offset, false, false).await
}

pub(crate) async fn read_public<C: ConnectionTrait>(
    db: &C,
    params: &ArticleQuery,
    limit: u64,
    offset: u64,
    top_only: bool,
) -> Result<(Vec<Article>, i64), DbErr> {
    read_view(db, params, limit, offset, true, top_only).await
}

async fn read_view<C: ConnectionTrait>(
    db: &C,
    params: &ArticleQuery,
    limit: u64,
    offset: u64,
    public_only: bool,
    top_only: bool,
) -> Result<(Vec<Article>, i64), DbErr> {
    let cat_id = if let Some(name) = &params.category {
        let ids = category::Entity::find()
            .select_only()
            .column(category::Column::Id)
            .filter(category::Column::Name.eq(name))
            .limit(2)
            .into_tuple::<i32>()
            .all(db)
            .await?;
        if ids.len() != 1 {
            return Err(DbErr::Custom("category missing or ambiguous".into()));
        }
        Some(ids[0])
    } else {
        None
    };
    let mut query = query(params, cat_id);
    if public_only {
        query = query.filter(super::super::notes::public_condition());
    }
    if top_only {
        query = query.filter(note::Column::IsTop.eq(1));
    }
    let total = query.clone().count(db).await? as i64;
    let mut items = query
        .limit(limit)
        .offset(offset)
        .left_join(category::Entity)
        .select_only()
        .columns([
            note::Column::Id,
            note::Column::Title,
            note::Column::Status,
            note::Column::IsPublic,
            note::Column::IsTop,
            note::Column::CategoryId,
            note::Column::CreatedAt,
            note::Column::UpdatedAt,
        ])
        .column_as(
            Expr::col((category::Entity, category::Column::Name)),
            "category_name",
        )
        .into_model::<Article>()
        .all(db)
        .await?;
    attach_tags(db, &mut items).await?;
    Ok((items, total))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ArticleQuery>,
) -> Json<ApiResponsePage<Vec<Article>>> {
    if !super::valid_text(params.keyword.as_deref())
        || !super::valid_text(params.category.as_deref())
        || params.id.is_some_and(|id| id <= 0)
        || params.category_id.is_some_and(|id| id <= 0)
    {
        return Json(ApiResponsePage::error("关键词、分类或编号无效"));
    }
    let (limit, offset) = match super::window(params.page, params.page_size) {
        Ok(value) => value,
        Err(message) => return Json(ApiResponsePage::error(message)),
    };
    super::response(read(&state.db, &params, limit, offset).await)
}
