//! 后台首页待办（20260924）。
//!
//! 前端的待办卡手里只有**一个数组**（拖拽换位、空行回收、行文本就地编辑，改的都是它），
//! 所以它用的两个接口就是"读整份 / 写整份"：
//!
//!   GET  /api/protected/todos      → 该用户按 sort_order 排好的整份列表
//!   PUT  /api/protected/todos      → 整份覆盖（事务内先删该用户全部行、再逐条插入）
//!   POST /api/protected/todos/item → **追加一条**（20260926：给 agent 用，见下）
//!   POST /api/protected/todos/done → **按正文翻某一条的完成标记**（20260926：同上）
//!   POST /api/protected/todos/date → **按正文改某一条的排期日**（20260929：同上）
//!
//! 为什么不按行做 CRUD、为什么前端不接服务端 id：见
//! `scripts/migration/dashboard_todo_20260924.sql` 头注（那里写了取舍与代价）。
//!
//! 后三条通道（20260926 两条 / 20260929 一条）的来由：agent 要能"替主人安排一条日程"、
//! "把某件事勾成做完了"、"把某件事挪到别的日子"，而它**手里没有**那份列表。让它复用 PUT
//! 只有两种写法，两种都坏——先读再写（读到写之间主人可能刚改过，写完就把主人的改动抹了），
//! 或者干脆发一份自己拼的（整份覆盖的语义下等于清空主人的待办）。所以给它的是三条
//! **只动自己那一行、既有行一个字节都不动**的最小通道：一条只插入、一条只翻 `done` 列、
//! 一条只改 `due_date` 列。三条共用同一个代价——**只能按正文定位**（线上从不回行 id），
//! 所以"正文是唯一身份"这件事在 [pick_todo] 里被写成三条判据。
//! 前端不消费这三条接口（页面上那几件事始终是整份读写），但前端**必须**在 agent 收尾后
//! 重读一次列表——否则它手里的旧那份会在下一次自动保存时把 agent 改的覆盖掉
//! （见 frontend/src/pages/Dashboard/Home/index.tsx 里 agent-turn-done 那一段）。
//!
//! 三条边界（写在这里，避免以后被"顺手放宽"）：
//!   · **空文本的行不落库**：空行是前端"新增一行"的临时态（失焦就回收），
//!     落库只会攒出一堆空壳；追加那条通道连空文本都不收（没有"临时态"这回事）；
//!   · 条数上限 `MAX_TODOS`、正文上限 `MAX_TEXT_CHARS`（与列宽一致）——超了**拒绝**
//!     而不是悄悄截断（截断会静默改主人的字）。拒绝的**粒度**两种通道不同：
//!     PUT 是整单拒绝（改完再发一次整份），三条最小通道只拒绝这一条（没道理让主人重发整份）；
//!   · 排期只收 `YYYY-MM-DD`（`due_date` 是 date 列，带时间的串在这里就挡掉，
//!     不让它变成"存进去了但读出来少了一截"）；**清空排期必须是说出口的那一下**
//!     （`null` / 空串 = 未排期，与前端 `DatePicker` 的 `allowClear` 同语义）——改排期那条
//!     通道的 `date` 字段与 `done` 同一条纪律（不给默认值），漏传字段整单拒绝，
//!     免得"漏传"被当成"清空"。
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
///
/// `Default` 是给 `ApiResponse::<TodoDto>::error` 用的（它的泛型要求 `T: Default`）：
/// 追加那条通道成功时回的就是**这一条**（不是整份列表），出错时得能造一个空壳。
#[derive(Serialize, Deserialize, Default)]
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

/// 线上口径（追加那条通道的请求体）：`{text, date}`。
///
/// **刻意没有 `done`**：这条通道的语义是"安排一条日程"，一上来就是已完成的日程
/// 没有意义；加完之后主人在页面上打勾才是它的完成态（PUT 那份照旧带 done）。
#[derive(Deserialize)]
pub struct AddTodoRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub date: Option<String>,
}

/// 线上口径（勾完成那条通道的请求体）：`{text, done}`。
///
/// **没有 id 字段**：线上从不回行 id（见文件头），能拿到的身份就是那一行**现在的正文**。
///
/// `done` **刻意不加 `#[serde(default)]`**：这个字段是**方向**，缺了它 serde 会拒绝
/// 整个请求体（400）。给它一个默认值等于"漏传方向 = 取消完成"——那是一个会静默把主人
/// 勾好的事重新变回没做的默认值，宁可让调用方把方向说清楚。
#[derive(Deserialize)]
pub struct SetTodoDoneRequest {
    #[serde(default)]
    pub text: String,
    pub done: bool,
}

/// 线上口径（改排期那条通道的请求体）：`{text, date}`。
///
/// **没有 id 字段**：同 [SetTodoDoneRequest]，线上从不回行 id。
///
/// `date` **刻意不加 `#[serde(default)]`**（与 `done` 同一条纪律，虽然方向不同）：缺了它
/// serde 会拒绝整个请求体（400）。给它默认值等于"漏传日期 = 清空排期"——那是一个会静默
/// 抹掉主人排期的默认值。**要清空**这条通道也有路：显式传 `null` 或空串（`parse_due_date`
/// 把两种"没填"归一成同一个 None）——"清空"和"漏传"必须分开。
#[derive(Deserialize)]
pub struct SetTodoDateRequest {
    #[serde(default)]
    pub text: String,
    pub date: Option<String>,
}

/// 排期串 → `NaiveDate`；`None`/空串 = 未排期，认不出的格式 → Err（中文文案）。
///
/// 三条通道共用（PUT 的每一行、追加的那一条、改排期的那一条）——"什么算合法的排期"只在
/// 这里定义一处，免得两边慢慢分叉（同族的纪律：日期格式放宽一次就要三处一起放宽，而漏改
/// 的那一处会静默接受一个存进去就少一截的串）。
fn parse_due_date(raw: Option<&str>) -> Result<Option<chrono::NaiveDate>, &'static str> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => match chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            // 形状先卡死（10 个 ASCII 字符、第 5 与第 8 位是 `-`、其余是数字）再交给
            // chrono：`%Y` **不要求四位年**，`26-09-27` 会被它读成"公元 26 年"
            // ——"日期打错了"于是变成一条落在两千年前、前端日历上谁也找不到的待办。
            // 长度与分隔位先卡住，才谈得上"格式不对"（下一句才是有意义的那个判据）。
            Ok(d) if is_iso_shape(s) => Ok(Some(d)),
            _ => Err("排期日期格式不对（应为 年-月-日）"),
        },
        None => Ok(None),
    }
}

/// `YYYY-MM-DD` 的字面形状（不看语义，"2026-02-30" 这种交给 chrono 拒）。
fn is_iso_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| {
            i == 4 || i == 7 || c.is_ascii_digit()
        })
}

/// 按**正文**在这份列表里认出唯一那一行；认不出 / 认多了都给中文原因（Err）。
///
/// 这个函数是 `POST …/done` 的**全部安全性**所在，所以单独抽成纯函数（无库无网，
/// 单测直接喂三行数据就能覆盖三条判据）。线上没有行 id、正文就是身份，于是"正文对不上
/// 的时候怎么办"必须是一条**拒绝**而不是"就近挑一条"——挑错的代价是把主人另一件事
/// 勾成做完了，而他只能靠自己发现。
///
/// 判据（口径与 PUT / 追加两条通道同源：库里存的正文都是**写入时 trim 过**的，
/// 调用方传进来的那一份也要先 trim，比较就在同一处口径上）：
///   · 一条都没匹配 → Err（"查无此条"绝不是"那就随便改一条"）；
///   · 匹配上多条   → Err（数据上不可区分，挑任意一条都是替主人猜）；
///   · 恰好一条     → Ok（那一行）。
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

/// GET /api/protected/todos：我的整份待办（按位次）。
pub async fn list_todos(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<ApiResponse<Vec<TodoDto>>> {
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
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
    let uid = match crate::auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(e) => return Json(ApiResponse::error(e.message())),
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

/// POST /api/protected/todos/item：**追加一条**（agent 安排日程用的那条通道）。
///
/// 语义只有一句"往这份列表末尾加一条"，既有的行一个字节都不动（来由见文件头）。
/// 四个判据与 PUT 同源、粒度不同：空文本不收、正文上限、条数上限、日期只收
/// `YYYY-MM-DD`——**超限只拒绝这一条**（PUT 是整单拒绝）。
///
/// 位次 = 当前最大值 + 1（排在最后）。两件事几乎同时到达时可能算出同一个
/// `sort_order`——不影响正确性：读取路径按 `(sort_order, id)` 排序（见 `list_todos`），
/// 自增 id 天然分出先后。
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
    // 一次读全（≤200 行）同时拿条数与最大位次：两个值出自同一份快照，
    // 不会出现"数出来没满、位次却按更早的一次读算"这种自相矛盾的组合。
    let rows = match dashboard_todo::Entity::find()
        .filter(dashboard_todo::Column::UserId.eq(uid))
        .all(&state.db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[todos] 追加前读取失败 uid={}: {}", uid, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if rows.len() >= MAX_TODOS {
        return err(format!("待办已经满了（最多 {MAX_TODOS} 条），先到后台首页清掉几条再记"));
    }
    let next_sort = rows.iter().map(|r| r.sort_order).max().unwrap_or(-1) + 1;

    let now = chrono::Local::now().naive_local();
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
    if let Err(e) = dashboard_todo::Entity::insert(row).exec(&state.db).await {
        tracing::error!("[todos] 追加失败 uid={}: {}", uid, e);
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }
    Json(ApiResponse::success(TodoDto {
        text: text.to_string(),
        done: false,
        date: due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

/// POST /api/protected/todos/done：按**正文**把某一条勾成完成 / 取消完成（agent 用的通道）。
///
/// 第四条通道（20260926）的来由见文件头：主人说"这件事办完了"，要落成那份列表里的一个勾，
/// 而 agent 手里没有列表。这条通道只做最小的一件事——**认出唯一那一行、只翻它的 `done`**：
/// 正文、排期、位次、别的行，一个字节都不动（复用 PUT 的那对坏选项在文件头写着）。
///
/// 定位判据全在 [pick_todo]（查无此条 / 有多条一律拒绝，零写）。
/// **幂等**：`done` 已经是目标态时成功返回、**不写库**（连 `updated_at` 都不动——"没发生
/// 的事"不该在库里留时间戳）。回话里刻意**不区分**"刚改的"与"本来就如此"：调用方（agent）
/// 手里有写前那份快照、它自己分得出，后端重复表达同一件事只是多一处会分叉的说法。
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
    let row = match pick_todo(&rows, text) {
        Ok(r) => r,
        Err(msg) => return err(msg),
    };
    if row.done != payload.done {
        let now = chrono::Local::now().naive_local();
        let am = dashboard_todo::ActiveModel {
            done: Set(payload.done),
            updated_at: Set(now),
            ..Default::default()
        };
        // 按主键更新（不是按正文再匹配一次）：上面那一步之后、这一句之前，主人可能正好
        // 在页面上把这一行的正文改了——按 id 落刀依然只动**我们认出来的那一行**，
        // 而按正文再匹配一次会在这时变成"零行受影响"（静默不生效）或改到别的行。
        if let Err(e) = dashboard_todo::Entity::update_many()
            .set(am)
            .filter(dashboard_todo::Column::Id.eq(row.id))
            .exec(&state.db)
            .await
        {
            tracing::error!("[todos] 翻完成标记失败 uid={} id={}: {}", uid, row.id, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
        // 审计只记 uid/id/目标态，**不记正文**：这是他私人清单里的内容，诊断不需要它
        tracing::info!("[todos] 翻完成标记 uid={} id={} done={}", uid, row.id, payload.done);
    }
    Json(ApiResponse::success(TodoDto {
        text: row.text.clone(),
        done: payload.done,
        date: row.due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

/// POST /api/protected/todos/date：按**正文**改某一条的排期日（agent 用的通道）。
///
/// 第五条通道（20260929）的来由见文件头：主人说"把简历那条挪到 10 月 8 号"，要落成那份列表
/// 里**那一行**的日期，而 agent 手里没有列表。与 `/done` 同形状的最小通道——**认出唯一那一
/// 行、只改它的 `due_date`**：正文、完成态、位次、别的行，一个字节都不动（复用 PUT 的那对
/// 坏选项在文件头写着）。**排期可清空**：传 `null`/空串 = 未排期（见 [SetTodoDateRequest]）。
///
/// 定位判据全在 [pick_todo]（查无此条 / 有多条一律拒绝，零写）。
/// **幂等**：目标日期与现状相同时成功返回、**不写库**（连 `updated_at` 都不动——"没发生的
/// 事"不该在库里留时间戳）。回话里刻意**不区分**"刚改的"与"本来就是这一天"：调用方（agent）
/// 手里有写前那份快照、它自己分得出（卡面上要印"现在是几号"），后端重复表达同一件事只是多
/// 一处会分叉的说法。
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
    // 日期先归一（认不出就整单拒绝，**绝不替主人挑一天顶上**）：这一步在读写之前，
    // 于是"日期打错了"这件事不会先落一次库再报错。
    let due_date = match parse_due_date(payload.date.as_deref()) {
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
    let row = match pick_todo(&rows, text) {
        Ok(r) => r,
        Err(msg) => return err(msg),
    };
    if row.due_date != due_date {
        let now = chrono::Local::now().naive_local();
        let am = dashboard_todo::ActiveModel {
            due_date: Set(due_date),
            updated_at: Set(now),
            ..Default::default()
        };
        // 按主键更新（不是按正文再匹配一次）：理由与 [set_todo_done] 那一步逐字相同
        // ——按 id 落刀只动**我们认出来的那一行**，而按正文再匹配一次会在主人刚好改了
        // 这一行正文时变成"零行受影响"（静默不生效）或改到别的行。
        if let Err(e) = dashboard_todo::Entity::update_many()
            .set(am)
            .filter(dashboard_todo::Column::Id.eq(row.id))
            .exec(&state.db)
            .await
        {
            tracing::error!("[todos] 改排期失败 uid={} id={}: {}", uid, row.id, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
        // 审计只记 uid/id/目标日期，**不记正文**：这是他私人清单里的内容，诊断不需要它
        tracing::info!("[todos] 改排期 uid={} id={} date={:?}", uid, row.id, due_date);
    }
    Json(ApiResponse::success(TodoDto {
        text: row.text.clone(),
        done: row.done,
        date: due_date.map(|d| d.format("%Y-%m-%d").to_string()),
    }))
}

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
        // 与 `SetTodoDoneRequest.done` 同一条纪律的镜像：**漏传字段 ≠ 显式清空**。
        // 漏传由 serde 拒掉整个请求体（400，agent 侧会收到一个明确的失败而不是一次静默
        // 抹除）；要清空必须说出口（`null` 或空串），两者在这里分得开。
        assert!(
            serde_json::from_str::<SetTodoDateRequest>(r#"{"text":"买菜"}"#).is_err(),
            "漏传 date 不该被当成清空"
        );
        for clear in [r#"{"text":"买菜","date":null}"#, r#"{"text":"买菜","date":""}"#,
                      r#"{"text":"买菜","date":"  "}"#] {
            let d = serde_json::from_str::<SetTodoDateRequest>(clear).unwrap();
            assert_eq!(parse_due_date(d.date.as_deref()), Ok(None), "{clear}");
        }
        let d = serde_json::from_str::<SetTodoDateRequest>(
            r#"{"text":"更新简历","date":"2026-10-08"}"#,
        )
        .unwrap();
        assert_eq!(d.text, "更新简历");
        assert_eq!(
            parse_due_date(d.date.as_deref()),
            Ok(Some(NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()))
        );
        // 认不出的日期在**读写之前**就被挡下（handler 里那一步的位置），这条锁的是
        // "日期归一只有 [parse_due_date] 一处"——多一条解析路径就会在这里分叉。
        let d = serde_json::from_str::<SetTodoDateRequest>(
            r#"{"text":"更新简历","date":"10月8日"}"#,
        )
        .unwrap();
        assert!(parse_due_date(d.date.as_deref()).is_err());
    }

    #[test]
    fn 带时间的串与认不出的写法一律拒绝() {
        // due_date 是 date 列：带时间的串存进去会少一截，宁可在入口挡掉
        for bad in ["2026-09-27 10:00", "2026/09/27", "26-09-27", "9-27", "明天",
                    "2026-02-30", "2026-13-01"] {
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
        let rows = vec![row(1, "买菜", false), row(2, "交房租", true), row(3, "遛狗", false)];
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
        // 口径说明：库里存的正文都是**写入时 trim 过**的，所以"要匹配的那一份"由 handler
        // trim 后再传进来（trim 在 handler 一处做）。这个用例锁的是**这个函数只认逐字相等**
        // ——任何"模糊匹配/包含匹配"的放宽都会在这里红，而那正是会勾错行的改法。
        let rows = vec![row(1, "买菜", false)];
        assert!(pick_todo(&rows, "买 菜").is_err(), "多一个空格是另一条待办");
        assert!(pick_todo(&rows, "买菜。").is_err(), "标点不同也是另一条");
        assert!(pick_todo(&rows, "买").is_err(), "前缀不算命中");
    }
}
