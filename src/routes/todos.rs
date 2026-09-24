//! 后台首页待办（20260924）。
//!
//! 两个接口就够，因为**这份列表的数据模型就是"一个数组"**（前端的待办卡手里只有
//! 一个数组：拖拽换位、空行回收、行文本就地编辑，改的都是它）：
//!
//!   GET  /api/protected/todos → 该用户按 sort_order 排好的整份列表
//!   PUT  /api/protected/todos → 整份覆盖（事务内先删该用户全部行、再逐条插入）
//!
//! 为什么不按行做 CRUD、为什么前端不接服务端 id：见
//! `scripts/migration/dashboard_todo_20260924.sql` 头注（那里写了取舍与代价）。
//!
//! 三条边界（写在这里，避免以后被"顺手放宽"）：
//!   · **空文本的行不落库**：空行是前端"新增一行"的临时态（失焦就回收），
//!     落库只会攒出一堆空壳；
//!   · 条数上限 `MAX_TODOS`、正文上限 `MAX_TEXT_CHARS`（与列宽一致）——超了**整单拒绝**
//!     而不是悄悄截断（截断会静默改主人的字）；
//!   · 排期只收 `YYYY-MM-DD`（`due_date` 是 date 列，带时间的串在这里就挡掉，
//!     不让它变成"存进去了但读出来少了一截"）。
//!
//! 鉴权：本模块挂在 `protected_routes`（admin 守卫）之下，每个 handler 仍按 uid 过滤
//! ——守卫管"能不能进后台"，uid 管"是谁的那份列表"，两者不互相替代。

use axum::{extract::State, http::HeaderMap, Json};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::entity::dashboard_todo;
use crate::routes::AppState;
use crate::utils::ApiResponse;

/// 一份列表最多多少条（前端没有条数限制，这里给一个诚实的上限：够用，且 PUT 体积可控）
const MAX_TODOS: usize = 200;
/// 单条正文上限（= 列宽 varchar(200)，按**字符**数算，中文不会被按字节砍短）
const MAX_TEXT_CHARS: usize = 200;

/// 带常量的中文文案要拼串，而 `ApiResponse::error` 只收 `&str`——统一从这里过一手
/// （不改 utils 的公共签名，本模块自己收口）。
fn err<T: Default>(msg: String) -> Json<ApiResponse<T>> {
    Json(ApiResponse::error(&msg))
}

/// 线上口径（前端字段名）：`{text, done, date}`
#[derive(Serialize, Deserialize)]
pub struct TodoDto {
    pub text: String,
    #[serde(default)]
    pub done: bool,
    /// 排期那天 `YYYY-MM-DD`；null / 空串 = 未排期（两种"没填"在这里归一成一串 None）
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveTodosRequest {
    #[serde(default)]
    pub todos: Vec<TodoDto>,
}

/// GET /api/protected/todos：我的整份待办（按位次）。
pub async fn list_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TodoDto>>> {
    let Some(uid) = crate::auth_jwt::auth_uid(&headers) else {
        return Json(ApiResponse::error("未登录"));
    };
    let rows = match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .order_by_asc(dashboard_todo::Column::SortOrder)
        .order_by_asc(dashboard_todo::Column::Id)
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 读取失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("读取失败，请稍后再试"));
        }
    };
    Json(ApiResponse::success(
        rows.into_iter()
            .map(|r| TodoDto {
                text: r.text,
                done: r.done,
                date: r.due_date.map(|d| d.format("%Y-%m-%d").to_string()),
            })
            .collect(),
    ))
}

/// PUT /api/protected/todos：整份覆盖。
///
/// 事务内"先删后插"而不是逐条 diff：见文件头。前端每次改动（打勾、改字、拖拽、
/// 新增/删除）都会把整份列表发过来，**空数组 = 清空**（不是"没改"，前端不会在
/// 没加载出列表时发 PUT——见 DashboardMethods.tsx 头注里那条纪律）。
pub async fn save_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SaveTodosRequest>,
) -> Json<ApiResponse<Vec<TodoDto>>> {
    let Some(uid) = crate::auth_jwt::auth_uid(&headers) else {
        return Json(ApiResponse::error("未登录"));
    };
    if payload.todos.len() > MAX_TODOS {
        return err(format!("待办太多了（最多 {MAX_TODOS} 条）"));
    }
    // 先把整份列表验完并成形，再开事务——校验不过就整单拒绝，不写半个字
    let now = chrono::Local::now().naive_local();
    let mut prepared: Vec<dashboard_todo::ActiveModel> = Vec::new();
    for (idx, t) in payload.todos.iter().enumerate() {
        let text = t.text.trim();
        if text.is_empty() {
            continue; // 空行是前端的临时态，不落库
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return err(format!("有一条太长了（最多 {MAX_TEXT_CHARS} 字）"));
        }
        let due_date = match t
            .date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => match chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                Ok(d) => Some(d),
                Err(_) => {
                    return Json(ApiResponse::error("排期日期格式不对（应为 年-月-日）"));
                }
            },
            None => None,
        };
        prepared.push(dashboard_todo::ActiveModel {
            user_id: Set(uid),
            // 位次用**原数组下标**（空行被跳过后会留空洞，空洞无害：排序只按大小）
            sort_order: Set(idx as i32),
            text: Set(text.to_string()),
            done: Set(t.done),
            due_date: Set(due_date),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        });
    }

    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[todos] 开事务失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if let Err(e) = dashboard_todo::Entity::delete_many()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .exec(&txn)
        .await
    {
        tracing::error!("[todos] 清旧行失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    // 逐条 insert（不用 insert_many）：主键自增由库分配，这里不需要回读 id；
    // 上限 200 条，这点开销可忽略，换来的是不依赖 insert_many 的返回值口径。
    for am in prepared {
        if let Err(e) = dashboard_todo::Entity::insert(am).exec(&txn).await {
            tracing::error!("[todos] 写入失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    }
    if let Err(e) = txn.commit().await {
        tracing::error!("[todos] 提交失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    // 回读一次而不是回显入参：让前端拿到的是**库里此刻的样子**（含空行被剔除后的
    // 真实位次），省得前端本地状态与库悄悄分叉。
    list_todos(State(state), headers).await
}
