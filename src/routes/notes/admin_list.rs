//! Administrator tables filter and paginate in SQL; bodies are read only by the editor.

use super::{category_names, summary_to_dto, NoteDto, NoteSummary};
use crate::{
    entity::{category, note, note_tag, tag_one, tag_two},
    routes::{catalog::pattern, pagination, AppState},
    search_core::split_terms,
    utils::ApiResponse,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr},
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ListQuery {
    pub page: Option<u64>,
    pub page_size: Option<u64>,
    pub status: Option<String>,
    pub keyword: Option<String>,
    pub title: Option<String>,
    pub categories: Option<String>,
    pub is_top: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub tags: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    items: Vec<NoteDto>,
    total: u64,
    page: u64,
    page_size: u64,
}

pub(super) fn selection(params: &ListQuery) -> Result<sea_orm::Select<note::Entity>, &'static str> {
    for text in [&params.keyword, &params.title, &params.categories]
        .into_iter()
        .flatten()
    {
        if text.trim().is_empty() || text.chars().count() > 100 {
            return Err("筛选文字须为1至100个字符");
        }
    }
    let mut query = note::Entity::find();
    match params.status.as_deref() {
        None | Some("all") => query = query.filter(note::Column::DraftOf.is_null()),
        Some("public") => query = query.filter(super::public_condition()),
        Some("private") => {
            query = query
                .filter(note::Column::Status.eq("private"))
                .filter(note::Column::DraftOf.is_null())
        }
        Some("draft") => query = query.filter(note::Column::Status.eq("draft")),
        _ => return Err("文章状态无效"),
    }
    if let Some(title) = &params.title {
        query = query.filter(Expr::col((note::Entity, note::Column::Title)).ilike(pattern(title)));
    }
    if let Some(name) = &params.categories {
        let ids = category::Entity::find()
            .select_only()
            .column(category::Column::Id)
            .filter(category::Column::Name.eq(name))
            .into_query();
        query = query.filter(note::Column::CategoryId.in_subquery(ids));
    }
    if let Some(top) = params.is_top {
        if ![0, 1].contains(&top) {
            return Err("置顶筛选无效");
        }
        query = query.filter(note::Column::IsTop.eq(top));
    }
    for (raw, start) in [(&params.start_date, true), (&params.end_date, false)] {
        if let Some(raw) = raw {
            let date =
                chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| "日期无效")?;
            let at = date
                .and_hms_opt(
                    if start { 0 } else { 23 },
                    if start { 0 } else { 59 },
                    if start { 0 } else { 59 },
                )
                .ok_or("日期无效")?;
            query = query.filter(if start {
                note::Column::CreatedAt.gte(at)
            } else {
                note::Column::CreatedAt.lte(at)
            });
        }
    }
    if let Some(tags) = &params.tags {
        let ids = tags
            .split(',')
            .map(|part| part.parse::<i32>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "标签编号无效")?;
        if ids.is_empty() || ids.len() > 50 || ids.iter().any(|id| *id <= 0) {
            return Err("标签编号无效");
        }
        let links = note_tag::Entity::find()
            .select_only()
            .column(note_tag::Column::NoteId)
            .filter(
                Condition::any()
                    .add(note_tag::Column::TagOneId.is_in(ids.clone()))
                    .add(note_tag::Column::TagTwoId.is_in(ids)),
            )
            .into_query();
        query = query.filter(note::Column::Id.in_subquery(links));
    }
    if let Some(keyword) = &params.keyword {
        let terms = split_terms(keyword);
        if terms.is_empty() {
            query = query.filter(note::Column::Id.eq(0));
        } else {
            let mut matches = Condition::any();
            for term in terms {
                let value = pattern(&term);
                let tags = note_tag::Entity::find()
                    .select_only()
                    .column(note_tag::Column::NoteId)
                    .left_join(tag_one::Entity)
                    .left_join(tag_two::Entity)
                    .filter(
                        Condition::any()
                            .add(Expr::col((tag_one::Entity, tag_one::Column::Name)).ilike(&value))
                            .add(Expr::col((tag_two::Entity, tag_two::Column::Name)).ilike(&value)),
                    )
                    .into_query();
                matches = matches
                    .add(Expr::col((note::Entity, note::Column::Title)).ilike(&value))
                    .add(Expr::col((note::Entity, note::Column::Content)).ilike(&value))
                    .add(note::Column::Id.in_subquery(tags));
            }
            query = query.filter(matches);
        }
    }
    Ok(query
        .order_by_desc(note::Column::CreatedAt)
        .order_by_desc(note::Column::Id))
}

#[derive(FromQueryResult)]
struct TagRow {
    note_id: i32,
    tag_one_id: Option<i32>,
    tag_two_id: Option<i32>,
    one_name: Option<String>,
    two_name: Option<String>,
    one_color: Option<String>,
    two_color: Option<String>,
}

async fn tags<C: ConnectionTrait>(db: &C, items: &mut [NoteDto]) -> Result<(), DbErr> {
    if items.is_empty() {
        return Ok(());
    }
    let rows = note_tag::Entity::find()
        .select_only()
        .columns([
            note_tag::Column::NoteId,
            note_tag::Column::TagOneId,
            note_tag::Column::TagTwoId,
        ])
        .column_as(
            Expr::col((tag_one::Entity, tag_one::Column::Name)),
            "one_name",
        )
        .column_as(
            Expr::col((tag_two::Entity, tag_two::Column::Name)),
            "two_name",
        )
        .column_as(
            Expr::col((tag_one::Entity, tag_one::Column::Color)),
            "one_color",
        )
        .column_as(
            Expr::col((tag_two::Entity, tag_two::Column::Color)),
            "two_color",
        )
        .left_join(tag_one::Entity)
        .left_join(tag_two::Entity)
        .filter(note_tag::Column::NoteId.is_in(items.iter().map(|item| item.id)))
        .order_by_asc(note_tag::Column::NoteId)
        .order_by_asc(note_tag::Column::Seq)
        .into_model::<TagRow>()
        .all(db)
        .await?;
    for row in rows {
        let (id, level, name, color) =
            match (row.tag_one_id, row.tag_two_id, row.one_name, row.two_name) {
                (Some(id), None, Some(name), _) => (id, 1, name, row.one_color),
                (None, Some(id), _, Some(name)) => (id, 2, name, row.two_color),
                _ => return Err(DbErr::Custom("Invalid article tag reference".into())),
            };
        if let Some(item) = items.iter_mut().find(|item| item.id == row.note_id) {
            item.tag_refs.push(crate::routes::note_tags::TagRef {
                id,
                level,
                name,
                color,
            });
        }
    }
    for item in items {
        item.tags = item
            .tag_refs
            .iter()
            .map(|tag| tag.id.to_string())
            .collect::<Vec<_>>()
            .join(",");
    }
    Ok(())
}

pub(super) async fn read<C: ConnectionTrait>(
    db: &C,
    params: &ListQuery,
    limit: u64,
) -> Result<Page, DbErr> {
    let query = selection(params).map_err(|error| DbErr::Custom(error.into()))?;
    let total = query.clone().count(db).await?;
    let page = params.page.unwrap_or(1).min(total.div_ceil(limit).max(1));
    let rows = query
        .limit(limit)
        .offset((page - 1) * limit)
        .into_partial_model::<NoteSummary>()
        .all(db)
        .await?;
    let categories = category_names(db, rows.iter().filter_map(|row| row.category_id)).await?;
    let mut items: Vec<_> = rows
        .into_iter()
        .map(|row| summary_to_dto(row, &categories))
        .collect();
    tags(db, &mut items).await?;
    Ok(Page {
        items,
        total,
        page,
        page_size: limit,
    })
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListQuery>,
) -> Result<Json<ApiResponse<Page>>, StatusCode> {
    let (limit, _) = pagination::bounded_window(params.page, params.page_size)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    selection(&params).map_err(|_| StatusCode::BAD_REQUEST)?;
    read(&state.db, &params, limit)
        .await
        .map(|page| Json(ApiResponse::success(page)))
        .map_err(|error| {
            tracing::error!("Administrator article page failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })
}

pub async fn count(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<u64>>, StatusCode> {
    note::Entity::find()
        .filter(note::Column::DraftOf.is_null())
        .count(&state.db)
        .await
        .map(|total| Json(ApiResponse::success(total)))
        .map_err(|error| {
            tracing::error!("Administrator article count failed: {error}");
            StatusCode::SERVICE_UNAVAILABLE
        })
}

#[cfg(test)]
mod tests;
