use crate::{
    entity::{note, note_tag, tag_one},
    routes::AppState,
    utils::ApiResponsePage,
};
use axum::{
    extract::{Query, State},
    Json,
};
use sea_orm::{
    sea_query::Expr, ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait,
    FromQueryResult, QueryFilter, QuerySelect, QueryTrait, Statement, Value,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

const ROWS: &str = "SELECT id,name,1::smallint AS level,NULL::integer AS parent_id FROM tag_one \
                UNION ALL SELECT id,name,2::smallint AS level,tag_one_id AS parent_id FROM tag_two";
const FILTER: &str = "($1::smallint IS NULL OR level=$1) AND ($2::integer IS NULL OR parent_id=$2)";

#[derive(Default, Deserialize)]
pub struct TagQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub level: Option<i16>,
    pub parent_id: Option<i32>,
}

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i32,
    pub name: String,
    pub level: i16,
    pub parent_id: Option<i32>,
    #[sea_orm(skip)]
    pub public_article_count: i64,
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &TagQuery,
    limit: u64,
    offset: u64,
) -> Result<(Vec<Tag>, i64), DbErr> {
    if let Some(parent) = params.parent_id {
        let found = tag_one::Entity::find_by_id(parent)
            .select_only()
            .column(tag_one::Column::Id)
            .into_tuple::<i32>()
            .one(db)
            .await?;
        if found.is_none() {
            return Err(DbErr::RecordNotFound("parent tag unavailable".into()));
        }
    }
    let values: Vec<Value> = vec![params.level.into(), params.parent_id.into()];
    let row = db
        .query_one(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!("SELECT COUNT(*) AS total FROM ({ROWS}) AS tags WHERE {FILTER}"),
            values.clone(),
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("missing tag count".into()))?;
    let total: i64 = row.try_get("", "total")?;
    let mut args = values;
    args.push((limit as i64).into());
    args.push((offset as i64).into());
    let mut items = Tag::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!(
            "SELECT * FROM ({ROWS}) AS tags WHERE {FILTER} ORDER BY level,id LIMIT $3 OFFSET $4"
        ),
        args,
    ))
    .all(db)
    .await?;
    for level in [1, 2] {
        let ids: Vec<i32> = items
            .iter()
            .filter(|row| row.level == level)
            .map(|row| row.id)
            .collect();
        if ids.is_empty() {
            continue;
        }
        let column = if level == 1 {
            note_tag::Column::TagOneId
        } else {
            note_tag::Column::TagTwoId
        };
        let public_ids = super::visible_notes()
            .select_only()
            .column(note::Column::Id)
            .into_query();
        let counts: HashMap<Option<i32>, i64> = note_tag::Entity::find()
            .select_only()
            .column(column)
            .column_as(Expr::cust("COUNT(DISTINCT note_tag.note_id)"), "count")
            .filter(column.is_in(ids))
            .filter(note_tag::Column::NoteId.in_subquery(public_ids))
            .group_by(column)
            .into_tuple::<(Option<i32>, i64)>()
            .all(db)
            .await?
            .into_iter()
            .collect();
        for row in items.iter_mut().filter(|row| row.level == level) {
            row.public_article_count = counts.get(&Some(row.id)).copied().unwrap_or(0);
        }
    }
    Ok((items, total))
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TagQuery>,
) -> Json<ApiResponsePage<Vec<Tag>>> {
    if params.level.is_some_and(|level| level != 1 && level != 2)
        || params.parent_id.is_some_and(|id| id <= 0)
        || (params.level == Some(1) && params.parent_id.is_some())
    {
        return Json(ApiResponsePage::error("标签层级或父标签编号无效"));
    }
    let (limit, offset) =
        match super::super::pagination::bounded_window(params.page, params.page_size) {
            Ok(value) => value,
            Err(message) => return Json(ApiResponsePage::error(message)),
        };
    super::response(read(&state.db, &params, limit, offset).await)
}
