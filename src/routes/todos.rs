//! Administrator-owned dashboard todos and atomic single-item actions.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use chrono::SubsecRound;
use sea_orm::{
    ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::entity::{dashboard_todo, user};
use crate::routes::AppState;
use crate::utils::{ApiResponse, ApiResponsePage};

const MAX_TODOS: usize = 200;
const MAX_TEXT_CHARS: usize = 200;

fn err<T: Default>(msg: String) -> Json<ApiResponse<T>> {
    Json(ApiResponse::error(&msg))
}

#[derive(Serialize, Deserialize, Default)]
pub struct TodoDto {
    #[serde(default)]
    pub id: Option<i32>,
    #[serde(default)]
    pub version: Option<String>,
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

#[derive(Deserialize)]
pub struct AddTodoRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Deserialize)]
pub struct SetTodoDoneRequest {
    pub id: Option<i32>,
    pub version: Option<String>,
    #[serde(default)]
    pub text: String,
    pub done: bool,
}

#[derive(Deserialize)]
pub struct SetTodoDateRequest {
    pub id: Option<i32>,
    pub version: Option<String>,
    #[serde(default)]
    pub text: String,
    pub date: TodoDate,
}

pub struct TodoDate(pub Option<String>);

impl<'de> Deserialize<'de> for TodoDate {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = TodoDate;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("排期日（`null` 或 年-月-日 的字符串）")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<TodoDate, E> {
                Ok(TodoDate(None))
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<TodoDate, E> {
                Ok(TodoDate(Some(s.to_string())))
            }
            fn visit_string<E: serde::de::Error>(self, s: String) -> Result<TodoDate, E> {
                Ok(TodoDate(Some(s)))
            }
        }
        d.deserialize_any(V)
    }
}

fn parse_due_date(raw: Option<&str>) -> Result<Option<chrono::NaiveDate>, &'static str> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => match chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            Ok(d) if is_iso_shape(s) => Ok(Some(d)),
            _ => Err("排期日期格式不对（应为 年-月-日）"),
        },
        None => Ok(None),
    }
}

fn is_iso_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn pick_todo<'a>(
    rows: &'a [dashboard_todo::Model],
    text: &str,
) -> Result<&'a dashboard_todo::Model, String> {
    let mut hits = rows.iter().filter(|r| r.text == text);
    let Some(row) = hits.next() else {
        return Err(format!("你后台首页的待办里没有「{text}」这一条"));
    };
    let extra = hits.count();
    if extra > 0 {
        return Err(format!(
            "有 {} 条待办都叫「{text}」，分不清是哪一条（先到后台首页把其中一条改个说法）",
            extra + 1
        ));
    }
    Ok(row)
}

async fn begin_list_write(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
) -> Result<sea_orm::DatabaseTransaction, sea_orm::DbErr> {
    let txn = db.begin().await?;
    let actor = user::Entity::find_by_id(uid)
        .lock_exclusive()
        .one(&txn)
        .await?;
    if actor.is_none() {
        return Err(sea_orm::DbErr::RecordNotFound(
            "actor no longer exists".into(),
        ));
    }
    Ok(txn)
}

fn conditional_update(
    uid: i32,
    row: &dashboard_todo::Model,
    changes: dashboard_todo::ActiveModel,
) -> sea_orm::UpdateMany<dashboard_todo::Entity> {
    dashboard_todo::Entity::update_many()
        .set(changes)
        .filter(dashboard_todo::Column::Id.eq(row.id))
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .filter(dashboard_todo::Column::Text.eq(&row.text))
        .filter(dashboard_todo::Column::UpdatedAt.eq(row.updated_at))
}

fn pick_request_todo<'a>(
    rows: &'a [dashboard_todo::Model],
    text: &str,
    id: Option<i32>,
    version: Option<&str>,
) -> Result<&'a dashboard_todo::Model, String> {
    match (id, version) {
        (None, None) => pick_todo(rows, text),
        (Some(id), Some(version)) if id > 0 => rows
            .iter()
            .find(|row| row.id == id && row.text == text && row.updated_at.to_string() == version)
            .ok_or_else(|| "待办已变化，请重新读取后确认".to_string()),
        _ => Err("待办编号与版本必须同时提供".to_string()),
    }
}

#[derive(Default, Deserialize)]
pub struct TodoQuery {
    pub done: Option<bool>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub(super) fn todo_query(uid: i32, done: Option<bool>) -> sea_orm::Select<dashboard_todo::Entity> {
    let mut query = dashboard_todo::Entity::find().filter(dashboard_todo::Column::UserId.eq(uid));
    if let Some(done) = done {
        query = query.filter(dashboard_todo::Column::Done.eq(done));
    }
    query
        .order_by_asc(dashboard_todo::Column::SortOrder)
        .order_by_asc(dashboard_todo::Column::Id)
}

pub async fn list_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<TodoQuery>,
) -> Json<ApiResponsePage<Vec<TodoDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponsePage::error(e.message())),
    };
    let window = match super::pagination::window(params.page, params.page_size) {
        Ok(window) => window,
        Err(msg) => return Json(ApiResponsePage::error(msg)),
    };
    let mut query = todo_query(uid, params.done);
    let total = if window.is_some() {
        match query.clone().count(&state.db).await {
            Ok(total) => Some(total as i64),
            Err(e) => {
                tracing::error!("todo count failed uid={uid}: {e}");
                return Json(ApiResponsePage::error("读取失败，请稍后再试"));
            }
        }
    } else {
        None
    };
    if let Some((limit, offset)) = window {
        query = query.limit(limit).offset(offset);
    }
    let rows = match query.all(&state.db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 读取失败 uid={}: {}", uid, e);
            return Json(ApiResponsePage::error("读取失败，请稍后再试"));
        }
    };
    Json(ApiResponsePage::success(
        rows.into_iter()
            .map(|r| TodoDto {
                id: Some(r.id),
                version: Some(r.updated_at.to_string()),
                text: r.text,
                done: r.done,
                date: r.due_date.map(|d| d.format("%Y-%m-%d").to_string()),
            })
            .collect(),
        total,
    ))
}

pub async fn save_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SaveTodosRequest>,
) -> Json<ApiResponse<Vec<TodoDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    if payload.todos.len() > MAX_TODOS {
        return err(format!("待办太多了（最多 {MAX_TODOS} 条）"));
    }
    // 先把整份列表验完并成形，再开事务——校验不过就整单拒绝，不写半个字
    let now = chrono::Local::now().naive_local().trunc_subsecs(6);
    let mut prepared: Vec<dashboard_todo::ActiveModel> = Vec::new();
    for (idx, t) in payload.todos.iter().enumerate() {
        let text = t.text.trim();
        if text.is_empty() {
            continue; // 空行是前端的临时态，不落库
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return err(format!("有一条太长了（最多 {MAX_TEXT_CHARS} 字）"));
        }
        let due_date = match parse_due_date(t.date.as_deref()) {
            Ok(d) => d,
            Err(msg) => return Json(ApiResponse::error(msg)),
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

    let txn = match begin_list_write(&state.db, uid).await {
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
    Json(
        list_todos(State(state), headers, Query(TodoQuery::default()))
            .await
            .0
            .base,
    )
}

pub async fn add_todo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AddTodoRequest>,
) -> Json<ApiResponse<TodoDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let text = payload.text.trim();
    if text.is_empty() {
        return Json(ApiResponse::error("这条待办没写内容"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return err(format!("这条太长了（最多 {MAX_TEXT_CHARS} 字）"));
    }
    let due_date = match parse_due_date(payload.date.as_deref()) {
        Ok(d) => d,
        Err(msg) => return Json(ApiResponse::error(msg)),
    };
    let txn = match begin_list_write(&state.db, uid).await {
        Ok(txn) => txn,
        Err(e) => {
            tracing::error!("todo append transaction failed uid={uid}: {e}");
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    let rows = match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .all(&txn)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 追加前读取失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if rows.len() >= MAX_TODOS {
        return err(format!(
            "待办已经满了（最多 {MAX_TODOS} 条），先到后台首页清掉几条再记"
        ));
    }
    let next_sort = rows.iter().map(|r| r.sort_order).max().unwrap_or(-1) + 1;

    let now = chrono::Local::now().naive_local().trunc_subsecs(6);
    let row = dashboard_todo::ActiveModel {
        user_id: Set(uid),
        sort_order: Set(next_sort),
        text: Set(text.to_string()),
        done: Set(false),
        due_date: Set(due_date),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    let inserted = match dashboard_todo::Entity::insert(row).exec(&txn).await {
        Ok(inserted) => inserted,
        Err(e) => {
            tracing::error!("[todos] 追加失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if let Err(e) = txn.commit().await {
        tracing::error!("todo append commit failed uid={uid}: {e}");
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    Json(ApiResponse::success(TodoDto {
        id: Some(inserted.last_insert_id),
        version: Some(now.to_string()),
        text: text.to_string(),
        done: false,
        date: due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

pub async fn set_todo_done(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SetTodoDoneRequest>,
) -> Json<ApiResponse<TodoDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let text = payload.text.trim();
    if text.is_empty() {
        return Json(ApiResponse::error("这条待办没写内容"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return err(format!("这条太长了（最多 {MAX_TEXT_CHARS} 字）"));
    }
    let rows = match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 翻完成标记前读取失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    let row = match pick_request_todo(&rows, text, payload.id, payload.version.as_deref()) {
        Ok(r) => r,
        Err(msg) => return err(msg),
    };
    let updated = if row.done != payload.done {
        chrono::Local::now().naive_local().trunc_subsecs(6)
    } else {
        row.updated_at
    };
    if row.done != payload.done {
        let now = updated;
        let am = dashboard_todo::ActiveModel {
            done: Set(payload.done),
            updated_at: Set(now),
            ..Default::default()
        };
        let changed = match conditional_update(uid, row, am).exec(&state.db).await {
            Ok(result) => result.rows_affected,
            Err(e) => {
                tracing::error!("[todos] 翻完成标记失败 uid={} id={}: {}", uid, row.id, e);
                return Json(ApiResponse::error("保存失败，请稍后再试"));
            }
        };
        if changed != 1 {
            return Json(ApiResponse::error("待办已变化，请重新读取后确认"));
        }
        // 审计只记 uid/id/目标态，**不记正文**：这是他私人清单里的内容，诊断不需要它
        tracing::info!(
            "[todos] 翻完成标记 uid={} id={} done={}",
            uid,
            row.id,
            payload.done
        );
    }
    Json(ApiResponse::success(TodoDto {
        id: Some(row.id),
        version: Some(updated.to_string()),
        text: row.text.clone(),
        done: payload.done,
        date: row.due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

pub async fn set_todo_date(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SetTodoDateRequest>,
) -> Json<ApiResponse<TodoDto>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
    };
    let text = payload.text.trim();
    if text.is_empty() {
        return Json(ApiResponse::error("这条待办没写内容"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return err(format!("这条太长了（最多 {MAX_TEXT_CHARS} 字）"));
    }
    let due_date = match parse_due_date(payload.date.0.as_deref()) {
        Ok(d) => d,
        Err(msg) => return Json(ApiResponse::error(msg)),
    };
    let rows = match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 改排期前读取失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    let row = match pick_request_todo(&rows, text, payload.id, payload.version.as_deref()) {
        Ok(r) => r,
        Err(msg) => return err(msg),
    };
    let updated = if row.due_date != due_date {
        chrono::Local::now().naive_local().trunc_subsecs(6)
    } else {
        row.updated_at
    };
    if row.due_date != due_date {
        let now = updated;
        let am = dashboard_todo::ActiveModel {
            due_date: Set(due_date),
            updated_at: Set(now),
            ..Default::default()
        };
        let changed = match conditional_update(uid, row, am).exec(&state.db).await {
            Ok(result) => result.rows_affected,
            Err(e) => {
                tracing::error!("[todos] 改排期失败 uid={} id={}: {}", uid, row.id, e);
                return Json(ApiResponse::error("保存失败，请稍后再试"));
            }
        };
        if changed != 1 {
            return Json(ApiResponse::error("待办已变化，请重新读取后确认"));
        }
        // 审计只记 uid/id/目标日期，**不记正文**：这是他私人清单里的内容，诊断不需要它
        tracing::info!(
            "[todos] 改排期 uid={} id={} date={:?}",
            uid,
            row.id,
            due_date
        );
    }
    Json(ApiResponse::success(TodoDto {
        id: Some(row.id),
        version: Some(updated.to_string()),
        text: row.text.clone(),
        done: row.done,
        date: due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

#[cfg(test)]
#[path = "todos_native_tests.rs"]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn 排期只认年月日() {
        assert_eq!(
            parse_due_date(Some("2026-09-27")),
            Ok(Some(NaiveDate::from_ymd_opt(2026, 9, 27).unwrap()))
        );
        // 前后空白是线上的常见脏值（前端有时带、有时不带），不该当格式错误
        assert_eq!(
            parse_due_date(Some("  2026-09-27 ")),
            Ok(Some(NaiveDate::from_ymd_opt(2026, 9, 27).unwrap()))
        );
        // "没填"的两种形态（null 与空串）归一成同一个 None，与 TodoDto 的注释一致
        assert_eq!(parse_due_date(None), Ok(None));
        assert_eq!(parse_due_date(Some("")), Ok(None));
        assert_eq!(parse_due_date(Some("   ")), Ok(None));
    }

    #[test]
    fn 改排期请求体必须把日期说清楚() {
        assert!(
            serde_json::from_str::<SetTodoDateRequest>(r#"{"text":"买菜"}"#).is_err(),
            "漏传 date 不该被当成清空"
        );
        // 类型错也是硬错误：`date` 只认 null 与字符串，数字/布尔不该被悄悄接受
        assert!(
            serde_json::from_str::<SetTodoDateRequest>(r#"{"text":"买菜","date":20261008}"#)
                .is_err()
        );
        for clear in [
            r#"{"text":"买菜","date":null}"#,
            r#"{"text":"买菜","date":""}"#,
            r#"{"text":"买菜","date":"  "}"#,
        ] {
            let d = serde_json::from_str::<SetTodoDateRequest>(clear).unwrap();
            assert_eq!(parse_due_date(d.date.0.as_deref()), Ok(None), "{clear}");
        }
        let d = serde_json::from_str::<SetTodoDateRequest>(
            r#"{"text":"更新简历","date":"2026-10-08"}"#,
        )
        .unwrap();
        assert_eq!(d.text, "更新简历");
        assert_eq!(
            parse_due_date(d.date.0.as_deref()),
            Ok(Some(NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()))
        );
        let d =
            serde_json::from_str::<SetTodoDateRequest>(r#"{"text":"更新简历","date":"10月8日"}"#)
                .unwrap();
        assert!(parse_due_date(d.date.0.as_deref()).is_err());
    }

    #[test]
    fn 带时间的串与认不出的写法一律拒绝() {
        // due_date 是 date 列：带时间的串存进去会少一截，宁可在入口挡掉
        for bad in [
            "2026-09-27 10:00",
            "2026/09/27",
            "26-09-27",
            "9-27",
            "明天",
            "2026-02-30",
            "2026-13-01",
        ] {
            assert!(parse_due_date(Some(bad)).is_err(), "{bad} 不该被接受");
        }
    }

    /// 造一行待办（单测用；时间列给个固定值，判据不看它）
    fn row(id: i32, text: &str, done: bool) -> dashboard_todo::Model {
        let t = NaiveDate::from_ymd_opt(2026, 9, 26)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        dashboard_todo::Model {
            id,
            user_id: 1,
            sort_order: id,
            text: text.to_string(),
            done,
            due_date: None,
            created_at: t,
            updated_at: t,
        }
    }

    #[test]
    fn 按正文定位三条判据() {
        let rows = vec![
            row(1, "买菜", false),
            row(2, "交房租", true),
            row(3, "遛狗", false),
        ];
        // 唯一命中 → 就是那一行。**完成态照样要能定位**：取消完成也要先找得到那一行
        assert_eq!(pick_todo(&rows, "交房租").map(|r| r.id), Ok(2));
        assert!(pick_todo(&rows, "交房租").unwrap().done);
        // 查无此条 → 拒绝（而不是"就近挑一条"：挑错等于把主人另一件事勾成了做完了）
        let e = pick_todo(&rows, "接孩子").unwrap_err();
        assert!(e.contains("没有「接孩子」这一条"), "{e}");
        // 两条同名 → 拒绝，且如实报出**条数**（主人据此知道要去页面上改哪个字）
        let same = vec![row(1, "买菜", false), row(2, "买菜", true)];
        let e = pick_todo(&same, "买菜").unwrap_err();
        assert!(e.contains("2 条") && e.contains("分不清"), "{e}");
        // 空列表走的是同一条"没有这一条"，不是 panic、也不是"没有就跳过"
        assert!(pick_todo(&[], "买菜").is_err());
    }

    #[test]
    fn 定位是逐字相等() {
        let rows = vec![row(1, "买菜", false)];
        assert!(pick_todo(&rows, "买 菜").is_err(), "多一个空格是另一条待办");
        assert!(pick_todo(&rows, "买菜。").is_err(), "标点不同也是另一条");
        assert!(pick_todo(&rows, "买").is_err(), "前缀不算命中");
    }
}
