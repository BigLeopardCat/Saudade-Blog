//! Versioned editor drafts; publication stays a separate operation.

use super::write_error;
use super::{clamp01, clamp_zoom, map_note, NoteDto};
use crate::{
    entity::{category, note},
    routes::{note_tags, AppState},
    utils::ApiResponse,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseTransaction,
    EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct AutosaveDraftRequest {
    #[serde(rename = "expectedVersion")]
    pub expected_version: Option<String>,
    /// Article id; omission creates a new standalone draft.
    pub id: Option<i32>,
    #[serde(rename = "noteTitle")]
    pub title: Option<String>,
    #[serde(rename = "noteContent")]
    pub content: Option<String>,
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>,
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
    pub description: Option<String>,
    pub cover: Option<String>,
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    #[serde(rename = "coverFit")]
    pub cover_fit: Option<super::CoverFit>,
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,
    #[serde(rename = "carouselFit")]
    pub carousel_fit: Option<super::CoverFit>,
    #[serde(rename = "noteTags")]
    pub tags: Option<String>,
}

#[derive(Serialize, Default)]
pub struct AutosaveDraftResult {
    pub version: String,
    /// 客户端此后继续沿用的文章 id（新建时 = 刚建出来的草稿行 id）
    pub id: i32,
    /// 本次实际写入了哪一行（原文章行 / 独立草稿行 / 修改稿行）
    #[serde(rename = "draftId")]
    pub draft_id: i32,
    /// Whether this save updated a shadow draft without changing its published root.
    #[serde(rename = "isRevision")]
    pub is_revision: bool,
    #[serde(rename = "updateTime")]
    pub update_time: String,
}

/// New articles create drafts; published roots are edited through a separate shadow draft.
async fn resolve_autosave_target(
    db: &DatabaseTransaction,
    root: Option<note::Model>,
    draft: Option<note::Model>,
) -> Result<note::Model, sea_orm::DbErr> {
    let now = chrono::Local::now().naive_local();

    let Some(n) = root else {
        let row = note::ActiveModel {
            title: Set(String::new()),
            content: Set(String::new()),
            status: Set(Some("draft".to_string())),
            is_public: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        return row.insert(db).await;
    };

    let id = n.id;

    if let Some(rev) = draft {
        return Ok(rev);
    }

    if n.status.as_deref() == Some("draft") {
        return Ok(n);
    }

    // Clone content and typed tag references into one revision transaction.
    let mut am: note::ActiveModel = n.into();
    am.id = NotSet;
    am.draft_of = Set(Some(id));
    am.status = Set(Some("draft".to_string()));
    am.is_public = Set(false);
    am.created_at = Set(now);
    am.updated_at = Set(now);
    let rev = am.insert(db).await?;
    note_tags::copy_note_tags(db, id, rev.id).await?;
    Ok(rev)
}

pub(crate) async fn locked_document(
    db: &DatabaseTransaction,
    id: i32,
) -> Result<(note::Model, Option<note::Model>), sea_orm::DbErr> {
    let row = note::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| sea_orm::DbErr::RecordNotFound("文章不存在".into()))?;
    let root_id = row.draft_of.unwrap_or(row.id);
    let root = note::Entity::find_by_id(root_id)
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or_else(|| sea_orm::DbErr::RecordNotFound("原文章已删除".into()))?;
    let draft = note::Entity::find()
        .filter(note::Column::DraftOf.eq(root_id))
        .lock_exclusive()
        .one(db)
        .await?;
    Ok((root, draft))
}

pub(crate) async fn document_version<C: ConnectionTrait>(
    db: &C,
    root: &note::Model,
    draft: Option<&note::Model>,
) -> Result<String, sea_orm::DbErr> {
    let row = draft.unwrap_or(root);
    let tags = note_tags::current_tags(db, row.id).await?;
    let bytes = serde_json::to_vec(&(root, draft, tags))
        .map_err(|e| sea_orm::DbErr::Custom(e.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(super) fn conflict<T: Default>() -> Json<ApiResponse<T>> {
    Json(ApiResponse {
        code: 409,
        message: "草稿已在其他位置修改，请重新读取后合并；当前输入未被覆盖。".into(),
        data: T::default(),
    })
}

pub async fn autosave_note(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AutosaveDraftRequest>,
) -> Json<ApiResponse<AutosaveDraftResult>> {
    let client_id = payload.id;

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return write_error(&e),
    };
    let (root, draft) = if let Some(id) = payload.id {
        let (root, draft) = match locked_document(&txn, id).await {
            Ok(rows) => rows,
            Err(e) => return write_error(&e),
        };
        match document_version(&txn, &root, draft.as_ref()).await {
            Ok(version) if payload.expected_version.as_deref() == Some(&version) => {}
            Ok(_) => return conflict(),
            Err(e) => return write_error(&e),
        }
        (Some(root), draft)
    } else {
        (None, None)
    };
    let target = match resolve_autosave_target(&txn, root, draft).await {
        Ok(t) => t,
        Err(e) => return write_error(&e),
    };

    let is_revision = target.draft_of.is_some();
    // Preserve an existing author; assign the authenticated author to a new draft.
    let author_missing = target.user_id.is_none();
    // Omitted tags retain authoritative associations. A failed read must not clear them.
    let eff_tags = match payload.tags.clone() {
        Some(v) => Some(v),
        None => match note_tags::current_tags(&txn, target.id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("[notes] 自动保存 {}：读现有标签失败: {e}", target.id);
                return Json(ApiResponse::error("Error: 读现有标签失败"));
            }
        },
    };
    let mut am: note::ActiveModel = target.into();

    if author_missing {
        if let Ok(uid) = crate::auth_jwt::auth_uid(&state.db, &headers).await {
            am.user_id = Set(Some(uid));
        }
    }

    if let Some(v) = payload.title {
        am.title = Set(v);
    }
    if let Some(v) = payload.content {
        am.content = Set(v);
    }
    if let Some(v) = payload.category_id {
        am.category_id = Set(Some(v));
    }
    if let Some(v) = payload.description {
        am.description = Set(Some(v));
    }
    if let Some(v) = payload.cover {
        am.cover = Set(Some(v));
    }
    if let Some(v) = payload.cover_focus_x {
        am.cover_focus_x = Set(Some(clamp01(v)));
    }
    if let Some(v) = payload.cover_focus_y {
        am.cover_focus_y = Set(Some(clamp01(v)));
    }
    if let Some(v) = payload.cover_fit {
        am.cover_fit = Set(Some(v.as_str().into()));
    }
    if let Some(v) = payload.carousel_fit {
        am.carousel_fit = Set(Some(v.as_str().into()));
    }
    if let Some(v) = payload.cover_zoom {
        am.cover_zoom = Set(Some(clamp_zoom(v)));
    }
    if let Some(v) = payload.carousel_focus_x {
        am.carousel_focus_x = Set(Some(clamp01(v)));
    }
    if let Some(v) = payload.carousel_focus_y {
        am.carousel_focus_y = Set(Some(clamp01(v)));
    }
    if let Some(v) = payload.carousel_zoom {
        am.carousel_zoom = Set(Some(clamp_zoom(v)));
    }
    if let Some(v) = payload.is_top {
        am.is_top = Set(Some(v));
    }
    // Draft saves preserve publication state; typed tag associations are written below.
    am.updated_at = Set(chrono::Local::now().naive_local());

    if let Err(error) = crate::routes::gallery::references::guard_model(&txn, &am).await {
        return write_error(&error);
    }
    let saved = match am.update(&txn).await {
        Ok(s) => s,
        Err(e) => {
            let _ = txn.rollback().await;
            return write_error(&e);
        }
    };
    if let Err(e) = note_tags::replace_note_tags(&txn, saved.id, eff_tags.as_deref()).await {
        tracing::error!("[notes] 自动保存 {}：写标签失败: {e}", saved.id);
        let _ = txn.rollback().await;
        return write_error(&e);
    }
    let (root, draft) = match locked_document(&txn, saved.id).await {
        Ok(rows) => rows,
        Err(e) => return write_error(&e),
    };
    let version = match document_version(&txn, &root, draft.as_ref()).await {
        Ok(v) => v,
        Err(e) => return write_error(&e),
    };
    match txn.commit().await {
        Ok(_) => Json(ApiResponse::success(AutosaveDraftResult {
            version,
            id: client_id.unwrap_or(saved.id),
            draft_id: saved.id,
            is_revision,
            update_time: saved.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })),
        Err(e) => {
            tracing::error!("[notes] 自动保存：提交失败: {e}");
            write_error(&e)
        }
    }
}

#[derive(Serialize)]
pub struct EditorNoteDto {
    pub version: String,
    /// 原文章行（id 就是 URL 里那个 id）
    pub note: NoteDto,
    /// 待继续编辑的修改稿；null = 没有未发布的修改稿，编辑器直接用 note 回填
    pub draft: Option<NoteDto>,
}

/// Administrator editor snapshot, including unpublished drafts and its concurrency version.
pub async fn get_note_for_edit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
    let result = async {
        let txn = state.db.begin().await?;
        let (root, draft) = locked_document(&txn, id).await?;
        let version = document_version(&txn, &root, draft.as_ref()).await?;
        let mut rows = Vec::new();
        for row in std::iter::once(root).chain(draft) {
            let cat = if let Some(cid) = row.category_id {
                category::Entity::find_by_id(cid)
                    .one(&txn)
                    .await?
                    .map(|c| (c.id, c.name))
            } else {
                None
            };
            rows.push(map_note(row, cat));
        }
        note_tags::attach_tags(&txn, &mut rows).await;
        txn.commit().await?;
        let mut rows = rows.into_iter();
        Ok::<_, sea_orm::DbErr>(EditorNoteDto {
            version,
            note: rows.next().expect("document root"),
            draft: rows.next(),
        })
    }
    .await;
    match result {
        Ok(dto) => (StatusCode::OK, Json(ApiResponse::success(dto))).into_response(),
        Err(sea_orm::DbErr::RecordNotFound(_)) => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                code: 404,
                message: "文章不存在".into(),
                data: Option::<EditorNoteDto>::None,
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("editor read: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::<Option<EditorNoteDto>>::error("草稿读取失败")),
            )
                .into_response()
        }
    }
}
