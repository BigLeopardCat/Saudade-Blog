use crate::{
    entity::{note, note_tag, tag_one},
    routes::AppState,
    utils::ApiResponsePage,
};
use axum::{
    Json,
    extract::{Query, State},
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QuerySelect, QueryTrait, Statement, Value, sea_query::Expr,
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
    pub parent_name: Option<String>,
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
    let mut parent_id = params.parent_id;
    if let Some(name) = &params.parent_name {
        let matches = tag_one::Entity::find()
            .filter(tag_one::Column::Name.eq(name))
            .select_only()
            .column(tag_one::Column::Id)
            .limit(2)
            .into_tuple::<i32>()
            .all(db)
            .await?;
        parent_id = match matches.as_slice() {
            [id] => Some(*id),
            [] => return Err(DbErr::RecordNotFound("parent tag unavailable".into())),
            _ => {
                return Err(DbErr::Custom(
                    "parent tag name is ambiguous; use parent_id".into(),
                ));
            }
        };
    } else if let Some(parent) = parent_id {
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
    let values: Vec<Value> = vec![params.level.into(), parent_id.into()];
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
    if !valid_query(&params) {
        return Json(ApiResponsePage::error("标签层级或父标签编号无效"));
    }
    let (limit, offset) =
        match super::super::pagination::bounded_window(params.page, params.page_size) {
            Ok(value) => value,
            Err(message) => return Json(ApiResponsePage::error(message)),
        };
    super::response(read(&state.db, &params, limit, offset).await)
}

fn valid_query(params: &TagQuery) -> bool {
    !params.level.is_some_and(|level| level != 1 && level != 2)
        && !params.parent_id.is_some_and(|id| id <= 0)
        && !params
            .parent_name
            .as_ref()
            .is_some_and(|name| name.trim().is_empty() || name.chars().count() > 100)
        && !(params.parent_id.is_some() && params.parent_name.is_some())
        && !(params.level == Some(1)
            && (params.parent_id.is_some() || params.parent_name.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::MockDatabase;
    use std::collections::BTreeMap;

    #[test]
    fn parent_filters_are_exact_and_mutually_exclusive() {
        for name in ["编程", "Programming", "100%_tag", "' OR true --"] {
            let query = TagQuery {
                parent_name: Some(name.into()),
                ..Default::default()
            };
            assert!(valid_query(&query));
        }
        for name in ["".to_string(), " ".into(), "a".repeat(101)] {
            assert!(!valid_query(&TagQuery {
                parent_name: Some(name),
                ..Default::default()
            }));
        }
        for query in [
            TagQuery {
                parent_id: Some(1),
                parent_name: Some("same".into()),
                ..Default::default()
            },
            TagQuery {
                level: Some(1),
                parent_name: Some("same".into()),
                ..Default::default()
            },
            TagQuery {
                parent_id: Some(0),
                ..Default::default()
            },
        ] {
            assert!(!valid_query(&query));
        }
    }

    #[tokio::test]
    async fn unknown_or_ambiguous_parent_never_runs_a_child_query() {
        for ids in [vec![], vec![7, 8]] {
            let matches: Vec<BTreeMap<&str, Value>> = ids
                .into_iter()
                .map(|id| BTreeMap::from([("id", id.into())]))
                .collect();
            let db = MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([matches])
                .into_connection();
            let query = TagQuery {
                parent_name: Some("named".into()),
                ..Default::default()
            };
            assert!(read(&db, &query, 5, 0).await.is_err());
            assert_eq!(db.into_transaction_log().len(), 1);
        }
    }
}
