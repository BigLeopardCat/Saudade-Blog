use axum::{Json, extract::State};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::entity::{announcement, user, user_notification};
use crate::routes::AppState;
use crate::utils::ApiResponse;

// ── 公告 → 个人中心通知的展开（20260922）────────────────────────────────────
//
// 个人中心的红点与「公告和通知」面板读的是 `user_notification`；公告表本身没有
// "谁读过"这一列，而 `user_notification.user_id` 又不许用 `0=全体` 广播哨兵
// （0 没有对应 user 行，与外键 ON DELETE CASCADE 打架——建表注释里写了这条）。
// 所以公告在**发布时按用户逐行展开**（本站用户是个位数，展开最省心，也天然回答
// "谁读过"），改与删同步到已展开的行。
//
// 行的身份 = `(user_id, type='announcement', title, created_at)`：`created_at`
// 写的是**公告自己的 created_at**（不是展开时刻），这样"找出某条公告展开出来的行"
// 是一次精确匹配，不需要给表加 announcement_id 列（本期不做迁移）。
// 标题改过之后旧的匹配键就没了 ⇒ 改之前必须先读一次原行、按旧键匹配再更新。
const KIND_ANNOUNCEMENT: &str = "announcement";

/// 给**所有用户**展开一条公告通知（新用户不会错过历史公告这件事本期不做——
/// 没有回溯补发，见 migration 头注"只建结构，不含数据回填"）。
async fn fan_out(state: &Arc<AppState>, a: &announcement::Model) {
    let users = match user::Entity::find().all(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[announcement] 展开公告失败，读用户列表出错 id={}: {}", a.id, e);
            return;
        }
    };
    for u in users {
        let am = user_notification::ActiveModel {
            user_id: Set(u.id),
            kind: Set(KIND_ANNOUNCEMENT.to_string()),
            title: Set(a.title.clone()),
            content: Set(Some(a.content.clone())),
            link: Set(None), // 公告没有详情页，纯文本通知
            created_at: Set(a.created_at.unwrap_or_else(|| chrono::Local::now().naive_local())),
            ..Default::default()
        };
        if let Err(e) = user_notification::Entity::insert(am).exec(&state.db).await {
            tracing::error!("[announcement] 展开公告失败 id={} uid={}: {}", a.id, u.id, e);
        }
    }
}

#[derive(Serialize)]
pub struct AnnouncementDto {
    pub id: i32,
    pub title: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub async fn list_announcements(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<AnnouncementDto>>> {
    let items = announcement::Entity::find()
        .order_by_desc(announcement::Column::Id)
        .all(&state.db).await.unwrap_or(vec![]);
    let dtos = items.into_iter().map(|a| AnnouncementDto {
        id: a.id,
        title: a.title,
        content: a.content,
        created_at: a.created_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default(),
        updated_at: a.updated_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default(),
    }).collect();
    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertAnnouncement {
    pub title: String,
    pub content: String,
}

pub async fn create_announcement(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    let a = announcement::ActiveModel {
        title: Set(payload.title),
        content: Set(payload.content),
        ..Default::default()
    };
    // 插入后**回读一次**：`created_at` 由 DB 默认值生成，展开出来的通知行要写同一个
    // 时刻（它是"这条通知来自哪条公告"的匹配键，见文件头注释）。
    let saved = match announcement::Entity::insert(a).exec(&state.db).await {
        Ok(r) => announcement::Entity::find_by_id(r.last_insert_id).one(&state.db).await.unwrap_or(None),
        Err(e) => {
            tracing::error!("[announcement] 新建失败: {}", e);
            None
        }
    };
    // 展开失败**不回滚公告**：公告本身已经发出去了（管理员在后台看得见），
    // 少的是通知行——如实记日志，不假装整体成功也不把已经发出去的公告吞掉。
    if let Some(a) = saved {
        fan_out(&state, &a).await;
    }
    Json(ApiResponse::success("Created".to_string()))
}

pub async fn update_announcement(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i32>,
    Json(payload): Json<UpsertAnnouncement>,
) -> Json<ApiResponse<String>> {
    // 改之前先读原行：标题是匹配键的一部分，改完就找不到自己展开出去的那些行了
    let old = announcement::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None);
    let new_title = payload.title.clone();
    let new_content = payload.content.clone();
    let a = announcement::ActiveModel {
        id: Set(id),
        title: Set(payload.title),
        content: Set(payload.content),
        ..Default::default()
    };
    if let Err(e) = announcement::Entity::update(a).exec(&state.db).await {
        return super::db_error("更新公告", &e);
    }
    if let Some(old) = old {
        // 已展开的通知行跟随更新（标题/正文）。`created_at` 不动：通知的时间语义是
        // "公告什么时候发布的"，不是"什么时候被编辑"——它还是匹配键。
        let mut q = user_notification::Entity::update_many()
            .col_expr(user_notification::Column::Title, sea_orm::sea_query::Expr::value(new_title))
            .col_expr(
                user_notification::Column::Content,
                sea_orm::sea_query::Expr::value(Some(new_content)),
            )
            .filter(user_notification::Column::Kind.eq(KIND_ANNOUNCEMENT))
            .filter(user_notification::Column::Title.eq(&old.title));
        q = match old.created_at {
            Some(t) => q.filter(user_notification::Column::CreatedAt.eq(t)),
            None => q.filter(user_notification::Column::CreatedAt.is_null()),
        };
        if let Err(e) = q.exec(&state.db).await {
            tracing::error!("[announcement] 同步通知行失败 id={}: {}", id, e);
        }
    }
    Json(ApiResponse::success("Updated".to_string()))
}

pub async fn delete_announcement(
    State(state): State<Arc<AppState>>,
    Json(ids): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    // 先读再删：展开出去的通知行要一起清掉（删了公告还留着"你有一条未读公告"
    // 就是一条永远点不开、只能靠"全部已读"消掉的红点）
    let rows = announcement::Entity::find()
        .filter(announcement::Column::Id.is_in(ids.clone()))
        .all(&state.db)
        .await
        .unwrap_or_default();
    if let Err(e) = announcement::Entity::delete_many()
        .filter(announcement::Column::Id.is_in(ids))
        .exec(&state.db)
        .await
    {
        return super::db_error("删除公告", &e);
    }
    for a in rows {
        if let Err(e) = user_notification::Entity::delete_many()
            .filter(user_notification::Column::Kind.eq(KIND_ANNOUNCEMENT))
            .filter(user_notification::Column::Title.eq(&a.title))
            .filter(match a.created_at {
                Some(t) => user_notification::Column::CreatedAt.eq(t),
                None => user_notification::Column::CreatedAt.is_null(),
            })
            .exec(&state.db)
            .await
        {
            tracing::error!("[announcement] 清理通知行失败 id={}: {}", a.id, e);
        }
    }
    Json(ApiResponse::success("Deleted".to_string()))
}
