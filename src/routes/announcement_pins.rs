use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Path, State},
    Json,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder, Statement,
};
use serde::Deserialize;

use super::{announcements::AnnouncementDto, AppState};
use crate::{
    entity::{announcement, web_info},
    utils::ApiResponse,
};

const KEY: &str = "pinnedAnnouncements";

async fn selected<C: ConnectionTrait>(db: &C) -> Result<Vec<i32>, DbErr> {
    let Some(row) = web_info::Entity::find()
        .filter(web_info::Column::KeyName.eq(KEY))
        .one(db)
        .await?
    else {
        return Ok(vec![]);
    };
    let ids: Vec<i32> = serde_json::from_str(&row.value)
        .map_err(|_| DbErr::Custom("公告置顶配置格式无效".into()))?;
    let mut seen = HashSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| *id > 0 && seen.insert(*id))
        .collect())
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<ApiResponse<Vec<AnnouncementDto>>> {
    let ids = match selected(&state.db).await {
        Ok(ids) => ids,
        Err(error) => return super::db_error("读取公告置顶配置", &error),
    };
    if ids.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }
    match announcement::Entity::find()
        .filter(announcement::Column::Id.is_in(ids))
        .order_by_desc(announcement::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(rows) => Json(ApiResponse::success(
            rows.into_iter().map(AnnouncementDto::from).collect(),
        )),
        Err(error) => super::db_error("读取置顶公告", &error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinRequest {
    pinned: bool,
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<PinRequest>,
) -> Json<ApiResponse<String>> {
    if id <= 0 {
        return Json(ApiResponse::error("公告编号无效"));
    }
    // One UPSERT merges the locked current value; concurrent toggles cannot replace each other's IDs.
    let result = state.db.execute(Statement::from_sql_and_values(DbBackend::Postgres, r#"
        INSERT INTO web_info (key_name, value)
        SELECT 'pinnedAnnouncements', CASE WHEN $2::boolean THEN jsonb_build_array($1::integer)::text ELSE '[]' END
        WHERE EXISTS (SELECT 1 FROM announcement WHERE id = $1)
        ON CONFLICT (key_name) DO UPDATE SET value = (
            SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)::text FROM (
                SELECT DISTINCT item::integer AS id FROM jsonb_array_elements_text(web_info.value::jsonb) AS old(item)
                WHERE item::integer <> $1
                UNION SELECT $1::integer WHERE $2::boolean
            ) AS selected
        )
    "#, [id.into(), payload.pinned.into()])).await;
    match result {
        Ok(result) if result.rows_affected() > 0 => {
            Json(ApiResponse::success("公告置顶已更新".to_owned()))
        }
        Ok(_) => Json(ApiResponse::error("公告不存在")),
        Err(error) => super::db_error("保存公告置顶", &error),
    }
}
