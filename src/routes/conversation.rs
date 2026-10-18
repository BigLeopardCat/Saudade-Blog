use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use sea_orm::{ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait};
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Alias, Expr};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use crate::routes::AppState;
use crate::auth_jwt;
// LIKE 转义（% _ \ → 字面量）：20261006 起唯一实现在 search_core（聚合搜索也用它）。
use crate::search_core::like_escape;
use crate::entity::{
    agent_task, chat_history, chat_summary, conversation, execution_log, pending_action,
};

/// 会话 API（20260903 会话化）：新建/列表/删除 + 会话解析（chat 系端点共用）。
/// 全部照 chat 系惯例：public_routes 组 + handler 内 auth_jwt::auth_uid 手写鉴权。

/// DB 时间戳（+08:00 本地钟面，NaiveDateTime）→ 毫秒时间戳（与 HistoryItem.time 同约定）
fn naive_ms(dt: chrono::NaiveDateTime) -> i64 {
    dt.and_local_timezone(chrono::Local)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// 会话解析（chat.rs 的 /chat、/chat/stream、history、discard 共用）：
/// - 显式 id → 校验归属（不存在/非本人 → Err，统一 conversation_not_found，防 id 枚举探测他人会话）
/// - None → 该用户最新非空会话（取最大消息 id 的归属——空会话无消息不会被解析到）
/// - 仍无会话且 create_if_none → 新建空会话（标题由首条消息入库时派生）
/// Ok(None) 只出现在"无会话且不新建"的只读降级路径（GET 历史无参 / discard 无会话空操作）
pub(crate) async fn resolve_conversation_id(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    requested: Option<i32>,
    create_if_none: bool,
) -> Result<Option<i32>, ()> {
    if let Some(id) = requested {
        let owned = conversation::Entity::find_by_id(id)
            .filter(conversation::Column::UserId.eq(uid))
            .one(db)
            .await
            .ok()
            .flatten();
        return match owned {
            Some(_) => Ok(Some(id)),
            None => Err(()),
        };
    }
    // 最新非空会话：用户最大 id 的消息必然落在最近活跃会话中（idx_user/idx_conv_id 单查）
    let last = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .order_by_desc(chat_history::Column::Id)
        .one(db)
        .await
        .ok()
        .flatten();
    match last {
        Some(h) => Ok(Some(h.conversation_id)),
        None if create_if_none => {
            // 结构体字面量不能直接作 match 判定式（{ 会被解析成 match 块），先绑变量
            let model = conversation::ActiveModel {
                user_id: Set(uid),
                ..Default::default()
            };
            match model.insert(db).await {
                Ok(m) => Ok(Some(m.id)),
                // 建会话失败（DB 故障）：返回 None 由调用方按服务不可用处理，不留脏行
                Err(_) => Ok(None),
            }
        }
        None => Ok(None),
    }
}

/// GET /api/chat/conversations 查询参数
#[derive(Deserialize)]
pub struct ListQuery {
    /// 20260903e 会话搜索：非空时列表收窄为"标题 LIKE（库 collation 不区分大小写）
    /// 或 会话内有消息内容命中"的会话，响应行带 hit_id = 点行后应定位的消息：
    /// 内容命中 → 该会话最新命中消息 id（消息 id 全局自增，desc 首见即最新）；
    /// 仅标题命中 → 会话首条消息 id（标题 = 首条用户消息截断，定位到标题出处）。
    /// null = 未搜索。
    #[serde(default)]
    q: Option<String>,
}

// `like_escape` 已搬到 `crate::search_core`（20261006）：这里原来有一份私有实现，
// `routes/upload.rs` 还有一份，聚合搜索要用第三处 ⇒ 三处一份（语义逐字不变，见模块头注）。
// 名字走文件顶部那条 `use crate::search_core::like_escape;`（`mod tests` 靠 `use super::*` 取到）。

/// GET /api/chat/conversations：当前用户会话列表（最后活动倒序）。
/// q 参数（20260903e）：标题 LIKE OR 会话内消息内容命中过滤，并带 hit_id 供前端定位。
pub async fn list_conversations(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 是这里**本就正确**的状态码（前端按 unauthorized 走登录态恢复），
        // 20260926 起多带一句 message：冻结与"令牌被收回"要能说清是哪种，
        // 否则当事人重登一次仍然进不来，却只看到一句"未登录"。
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "message": e.message()})),
            )
                .into_response();
        }
    };
    let q = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // 内容命中（搜索时）：用户全历史消息内容 LIKE 扫描（带 % _ \ 转义），
    // hit_by_conv 既作列表过滤条件，也随行回传作定位锚点（每会话取**最大** id 那条）。
    //
    // 20261014：折叠从 Rust 搬进 SQL。从前是 `…order_by_desc(Id).all(&db)` 把**每一条**
    // 命中消息的**整行**拉进内存、再逐行 `entry().or_insert()` 折成"每会话一条"——
    // 除了 id / conversation_id 之外那些列没人看，而命中行数随用户历史线性涨
    // （同文件 `search_chat_messages` 是同一条查询 + `limit(100)`，可见这里当初漏了）。
    // 现在 `GROUP BY conversation_id` + `MAX(id)`：**结果与从前逐字等价**
    //（`id` 全局自增 ⇒ 会话内也单调，故"降序首见"就是这个 MAX），传回的行数却从
    // "命中消息数"降到"命中会话数"。过滤/聚合留在 SQL 里，别拉进 Rust 再筛（行业常规做法，
    // 仓里 `note_stats.rs:577` 那批计数查询是同一个写法）。
    // ⚠️ 这里刻意**不加** `limit`：hit_by_conv 是下面那张列表的**过滤条件**，砍掉几条
    // 就会让"明明聊过这个词"的会话从搜索结果里静默消失——比多查几行坏得多。
    // 上界本来就由用户自己的会话数兜着（紧跟其后的列表查询另有 `limit(200)`）。
    let mut hit_by_conv: HashMap<i32, i32> = HashMap::new();
    if let Some(q) = q {
        // ⚠️ **`ILIKE` 不是 `LIKE`**（20261019）。PG 的 `LIKE` **区分大小写**，而切流之前
        // MySQL 的排序规则是 `utf8mb4_0900_ai_ci`（大小写不敏感）⇒ **会话搜索在切流那天
        // 静默变敏感了**。产线实测：`chat_history` 里 `LIKE '%esp32%'` 命中 **0** 行、
        // `ILIKE` 命中 **34** 行 —— 用户搜一个自己明明打过的词，结果是"没聊过"。
        //
        // 这一处与 `notes::search_notes` 那类**不同**：那边 SQL 只是**预筛**，真判定在内存里
        // （`to_lowercase().contains`），所以大小写口径必须与内存一致；这里**没有第二层**
        // ⇒ `ILIKE` 就是这条搜索的全部语义。改它等于改搜索行为，而目标是**回到切流前
        // 用户看到的样子**（本仓在 `pg-business-schema` 里记的"排序规则对不上"那一格）。
        //
        // 本文件共四处：两处正文（这里 + `search_chat_messages`）、两处会话标题
        // （`conversation.title` 是首条用户消息派生的，同一口径）。四处同源。
        let pat = format!("%{}%", like_escape(q));
        let rows = chat_history::Entity::find()
            .select_only()
            .column(chat_history::Column::ConversationId)
            .column_as(
                Expr::col(chat_history::Column::Id).max().cast_as(Alias::new("BIGINT")),
                "max_id",
            )
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::Content.into_expr().ilike(&pat))
            .group_by(chat_history::Column::ConversationId)
            // 聚合列必须按 **i64** 收（`id` 本身是 i32），照 `id` 的类型去解会解不出来
            // ——而 `unwrap_or_default()` 会把"解不出来"咽成**空命中集**
            // （症状 = 内容搜索静默只剩标题命中，且不报任何错）。
            //
            // ⚠️ **20261018 切库到 PG 时补的那一手 `CAST(... AS BIGINT)`**：从前的理由是
            // "MySQL 的 MAX/COUNT 一律以 64 位返回"，那句**在 PG 上不成立** ——
            // `MAX(int4)` 在 PG 里就是 `int4`，按 `Option<i64>` 解同样失败。
            // `SUM` 是反过来的（PG 的 `SUM(integer)` 返回 `bigint`、MySQL 返回 DECIMAL，
            // 见 `note_stats.rs::sum_views`）；**只有 `COUNT(*)` 两边都是 64 位**，
            // 所以 `stats.rs` 那三处不用动。
            // 判据在 `tests/pg_integration.rs::conversation_list_pins_first_and_anchors_hits`
            // ——它抓的正是这条：内容命中那条会话会整个从搜索结果里消失。
            // `Option` 是给"整组 NULL"留的余量（GROUP BY 的组非空，正常取不到 None）。
            .into_tuple::<(i32, Option<i64>)>()
            .all(&state.db)
            .await
            .unwrap_or_default();
        for (cid, hid) in rows {
            if let Some(hid) = hid {
                hit_by_conv.insert(cid, hid as i32);
            }
        }
    }
    // 20260903b：置顶会话 pinned 优先（组内仍按最后活动倒序）
    let mut finder = conversation::Entity::find()
        .filter(conversation::Column::UserId.eq(uid))
        .order_by_desc(conversation::Column::Pinned)
        .order_by_desc(conversation::Column::UpdatedAt)
        .order_by_desc(conversation::Column::Id); // datetime 秒精度并列时 id 兜底
    if let Some(q) = q {
        let pat = format!("%{}%", like_escape(q));
        // 标题 LIKE（Title 可 NULL：NULL LIKE 永不命中，天然安全）或内容命中会话；
        // hits 为空时省略 in 支（MySQL 不接受空 IN () 列表）
        let cond = if hit_by_conv.is_empty() {
            Condition::any().add(conversation::Column::Title.into_expr().ilike(&pat))
        } else {
            Condition::any()
                .add(conversation::Column::Title.into_expr().ilike(&pat))
                .add(conversation::Column::Id.is_in(hit_by_conv.keys().copied()))
        };
        finder = finder.filter(cond);
    }
    let convs = finder
        .limit(200)
        .all(&state.db)
        .await
        .unwrap_or_default();
    // 仅标题命中的行补定位锚：标题 = 首条用户消息截断（标题出处），点行应定位
    // 到该会话首条消息而非停留在"最新消息"处——idx_conv_id (conversation_id, id)
    // 前缀命中的单行索引查询，标题命中行数少（个位~几十），逐行可接受
    if q.is_some() {
        // filter 闭包持 hit_by_conv 借用 → 先收集再逐行插入
        let need: Vec<i32> = convs
            .iter()
            .filter(|c| !hit_by_conv.contains_key(&c.id))
            .map(|c| c.id)
            .collect();
        for cid in need {
            if let Some(h) = chat_history::Entity::find()
                .filter(chat_history::Column::ConversationId.eq(cid))
                .order_by_asc(chat_history::Column::Id)
                .one(&state.db)
                .await
                .ok()
                .flatten()
            {
                hit_by_conv.insert(cid, h.id);
            }
        }
    }
    let items: Vec<serde_json::Value> = convs
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                // Option 原样透传：null = 未派生标题，前端显示"新对话"
                "title": c.title,
                "created_at": naive_ms(c.created_at),
                "updated_at": naive_ms(c.updated_at),
                "pinned": c.pinned,
                // 20260903e 点行定位锚：内容命中 = 最新命中消息；仅标题命中 =
                // 会话首条消息（标题出处）；未搜索 = null
                "hit_id": hit_by_conv.get(&c.id).copied(),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({"conversations": items}))).into_response()
}

/// POST /api/chat/conversations：新建空会话（title NULL，首条用户消息入库时派生标题）。
/// 前端"新对话"按钮本身不发请求——首次发送消息前惰性调用本端点拿 id。
pub async fn create_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 是这里**本就正确**的状态码（前端按 unauthorized 走登录态恢复），
        // 20260926 起多带一句 message：冻结与"令牌被收回"要能说清是哪种，
        // 否则当事人重登一次仍然进不来，却只看到一句"未登录"。
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "message": e.message()})),
            )
                .into_response();
        }
    };
    let model = conversation::ActiveModel {
        user_id: Set(uid),
        ..Default::default()
    };
    match model.insert(&state.db).await {
        Ok(m) => (StatusCode::CREATED, Json(json!({"id": m.id}))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "会话创建失败"})),
        )
            .into_response(),
    }
}

/// 会话数据级联删的**范围**：按会话 id，还是按用户 id（删临时账号走这条）。
pub(crate) enum ConvScope {
    ConversationId(i32),
    UserId(i32),
}

/// 会话数据级联删的**唯一清单**：5 张子表 + `conversation` 本体。
///
/// **为什么要有这个函数**（20261018）：这份清单此前在**两处各写一遍**，而两处写的不是同一份
/// —— `delete_conversation` 删五张，`temp_user::delete_temp_user` 只删三张（漏
/// `execution_log` / `pending_action` / `agent_task`）。于是删掉一个临时账号之后，那三张表里
/// 按 `user_id` 挂着的行全部变成孤儿：它们都按 `conversation_id` 读，会话没了就**没有任何
/// 读取路径**会碰到，也**没有任何东西会红**（`tests/pg_integration.rs` 里那条行为判据就是
/// 为它立的，在改之前是红的）。
///
/// 修法刻意**不是**"给漏的那处补三行"——那只是把同一份清单再抄一遍、等下一次再漏；
/// 是把清单收成**一处**，两处都调它。
///
/// ⚠️ 这里刻意**不加 DB 外键**：chat 家族按约定走应用层级联（`delete_conversation` 下面的
/// 注释记着这条），且 `verify_parity.py` 会比对 PG 与 MySQL 的外键集合。防线是
/// "清单唯一化 + 一条行为判据 + 一条源码锁"，三样都要。
///
/// 事务边界由调用方决定：`delete_conversation` 把它包在自己的事务里，
/// `delete_temp_user` 不包（与它原本的形态一致）。
///
/// **返回值 = 这批被清掉的会话 id**（20261019 批 D）：agent 的上下文住在 checkpoint 库里
/// （20261018 起挂 saver，20261019 起是**另一个 database**），那张表不归本进程管、也没有
/// DB 外键可依 ⇒ 级联只能跨进程请 agent 删。**id 清单仍只有这一处**（同上面那条纪律：
/// 谁要清 checkpoint，问这个函数要 id，别自己再查一遍——两处各查一遍就是上次那个 bug
/// 的形状）。钩子本身在 `drop_checkpoint_threads`，**调用点在事务之外**（见它头注）。
pub(crate) async fn purge_conversation_data<C: sea_orm::ConnectionTrait>(
    db: &C,
    scope: ConvScope,
) -> Result<Vec<i32>, sea_orm::DbErr> {
    match scope {
        ConvScope::ConversationId(id) => {
            chat_history::Entity::delete_many()
                .filter(chat_history::Column::ConversationId.eq(id))
                .exec(db).await?;
            chat_summary::Entity::delete_many()
                .filter(chat_summary::Column::ConversationId.eq(id))
                .exec(db).await?;
            // 跨轮执行记忆（20260904 C5）：执行回执随会话删除级联清理——会话删了，
            // 其 execution_log 行无任何读取路径（prepare_chat 按 conversation_id 注入），
            // 不清理会永久占表
            execution_log::Entity::delete_many()
                .filter(execution_log::Column::ConversationId.eq(id))
                .exec(db).await?;
            // 跨轮待办（20260923）：同上——待办按会话读取，会话没了就无读取路径，
            // 留着只会永久占表（待办不跨会话生效：确认令牌也绑会话）
            pending_action::Entity::delete_many()
                .filter(pending_action::Column::ConversationId.eq(id))
                .exec(db).await?;
            // 会话级任务状态（20260927）：同上——任务按会话读写（prepare_chat 注入 + agent
            // 只发本会话的 task_id），会话没了就没有任何读取路径；与待办的区别只是它活得更久
            // （分钟级 vs 最长 72 小时），**不清理会永久占表**这一条完全一样
            agent_task::Entity::delete_many()
                .filter(agent_task::Column::ConversationId.eq(id))
                .exec(db).await?;
            conversation::Entity::delete_by_id(id).exec(db).await?;
            Ok(vec![id])
        }
        ConvScope::UserId(uid) => {
            // 与上面**逐表同序**，只把过滤列从 conversation_id 换成 user_id。删账号时没有
            // "会话 id"可依，只能按归属列扫——所以五张表都必须在 user_id 上有值（它们都有）。
            //
            // 这一臂的会话 id 要在**删之前**取：下面最后一步把 `conversation` 行本身删掉，
            // 删完就再也问不出"这个 uid 有过哪几个会话"了（`conv_<id>` 线程坐标也随之下落不明）。
            let conv_ids: Vec<i32> = conversation::Entity::find()
                .filter(conversation::Column::UserId.eq(uid))
                .all(db)
                .await?
                .into_iter()
                .map(|c| c.id)
                .collect();
            chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .exec(db).await?;
            chat_summary::Entity::delete_many()
                .filter(chat_summary::Column::UserId.eq(uid))
                .exec(db).await?;
            execution_log::Entity::delete_many()
                .filter(execution_log::Column::UserId.eq(uid))
                .exec(db).await?;
            pending_action::Entity::delete_many()
                .filter(pending_action::Column::UserId.eq(uid))
                .exec(db).await?;
            agent_task::Entity::delete_many()
                .filter(agent_task::Column::UserId.eq(uid))
                .exec(db).await?;
            conversation::Entity::delete_many()
                .filter(conversation::Column::UserId.eq(uid))
                .exec(db).await?;
            Ok(conv_ids)
        }
    }
}

/// 把 checkpoint 库里的 `conv_<id>` 线程删掉（**best-effort**）。
///
/// **为什么是 HTTP 钩子而不是一条 DELETE**：agent 的上下文住在 checkpoint 库里，那张表
/// 不归本进程管（20261019 起更是**另一个 database**）⇒ 级联只能跨进程请 agent 删
/// （本仓 `DELETE /checkpoint/{conversation_id}`）。不删的后果与上面那五张表同形：会话没了，
/// 那份正文**没有任何读取路径**，也**没有任何东西会红**。
///
/// 三条纪律：
///   · **不进 DB 事务**：HTTP 不能挂在 `txn` 里（一次超时会把六张表的行锁攥住几秒），
///     所以两个调用点都在事务之外——`delete_conversation` 在 `commit()` **之后**，
///     `delete_temp_user` 本来就没有事务。
///   · **失败不让业务删除失败**：checkpoint 是派生数据，钩子挂了照样删会话；残留由夜间
///     `eval/pg_retention.py` 的保留期兜底。但**必须留痕**（warn）——「点了没反应」在本仓
///     是禁止的。
///   · **id 只从 `purge_conversation_data` 来**，这里不查库（清单只有一份）。
///   · **有总预算**：一次删账号可能带几十个会话，逐条 3 秒超时会把它拖成 N×3 秒
///     （agent 活着但不回话时每条都要等满）。超了就不再发，剩下的由保留期兜底。
pub(crate) async fn drop_checkpoint_threads(ids: &[i32]) {
    if ids.is_empty() {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let base = crate::routes::graph::agent_base_url();
    let client = reqwest::Client::new();
    for (done, id) in ids.iter().enumerate() {
        if Instant::now() >= deadline {
            tracing::warn!(
                "[会话] checkpoint 钩子超出总预算 10s，剩 {} 条交给夜间保留期清（会话已删）",
                ids.len() - done
            );
            break;
        }
        let url = format!("{base}/checkpoint/{id}");
        match client.delete(&url).timeout(Duration::from_secs(3)).send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => tracing::warn!(
                "[会话] checkpoint 钩子非 2xx（会话已删、agent 侧残留待保留期清）conv={id} status={}",
                r.status()
            ),
            Err(e) => tracing::warn!(
                "[会话] checkpoint 钩子失败（会话已删、agent 侧残留待保留期清）conv={id}: {e}"
            ),
        }
    }
}

/// 把「丢弃那一轮」告诉 agent（`POST /checkpoint/{id}/drop_turn`，**best-effort**）。
///
/// **为什么必须告诉它**：20261018 起 agent 的上下文**由图自持**（`server._graph_holds_context()`
/// 把历史注入关了）⇒ `chat_history` 不再是上下文来源。删掉那一轮之后不说一声，agent 下一轮
/// **照样记得**——主人点了"停止生成"、明确说不想要这条进记忆，而记忆里还有。
///
/// `text` = 刚删掉那行的 content（**必给**）：agent 侧拿它确认"state 里最后那条 user 是不是
/// 这一轮"，对不上就不动手——摘错的代价不可逆（删掉主人还想留着的话）。
///
/// 失败/没生效**只 warn**（与 `drop_checkpoint_threads` 同口径：不挡业务删除，但必须留痕）。
pub(crate) async fn drop_checkpoint_turn(conversation_id: i32, text: &str) {
    let url = format!("{}/checkpoint/{conversation_id}/drop_turn",
                      crate::routes::graph::agent_base_url());
    let sent = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "text": text }))
        .timeout(Duration::from_secs(3))
        .send()
        .await;
    match sent {
        Ok(r) => {
            let ok = r.status().is_success();
            let v = r.json::<serde_json::Value>().await
                .unwrap_or_else(|_| serde_json::json!({}));
            if !ok {
                tracing::warn!("[会话] 丢弃那一轮的钩子非 2xx conv={conversation_id}");
            } else if !v["dropped"].as_bool().unwrap_or(false) {
                // `no_text` / `mismatch` 都落这里——它们是"没动手"，**不是成功**。
                tracing::warn!(
                    "[会话] 丢弃那一轮没生效 conv={} why={}（图里那条 user 还在，下一轮它还看得见）",
                    conversation_id, v["why"].as_str().unwrap_or("?")
                );
            }
        }
        Err(e) => tracing::warn!("[会话] 丢弃那一轮的钩子失败 conv={conversation_id}: {e}"),
    }
}

/// DELETE /api/chat/conversations/:id：删除会话 + 级联删其历史与摘要（用户级清洗手段）。
/// 归属校验合并为一个查询：不存在或非本人统一 404（防枚举）。
pub async fn delete_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 是这里**本就正确**的状态码（前端按 unauthorized 走登录态恢复），
        // 20260926 起多带一句 message：冻结与"令牌被收回"要能说清是哪种，
        // 否则当事人重登一次仍然进不来，却只看到一句"未登录"。
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "message": e.message()})),
            )
                .into_response();
        }
    };
    let owned = conversation::Entity::find_by_id(id)
        .filter(conversation::Column::UserId.eq(uid))
        .one(&state.db)
        .await
        .ok()
        .flatten();
    if owned.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"success": false, "error": "conversation_not_found"})),
        )
            .into_response();
    }
    // 级联删除（应用层，无 DB 外键——与全项目"实体零关系"惯例一致），事务保证五步一致
    // （失败回滚，不出现孤儿消息/摘要/执行回执）。清单**只有一份**：
    // `purge_conversation_data`（20261018 收口，此前这里与 `temp_user.rs` 各写一份且不同）。
    //
    // ⚠️ 20261018 顺带修了一处**注释与代码不符**：原实现六条 `let _ = …` 把每个错误都吞掉，
    // 于是 `txn` 从来不会因为子表删除失败而回滚 —— 上面那句"失败回滚"当时是**做不到的**。
    // 现在错误会真的往上走：删不干净就整体回滚并如实报错（宁可"这次没删成"，不要
    // "删了一半、剩下三张表的孤儿谁也不认识"）。
    let txn = match state.db.begin().await {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "error": "删除失败"})),
            )
                .into_response()
        }
    };
    let threads = match purge_conversation_data(&txn, ConvScope::ConversationId(id)).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[会话] 级联删除失败，回滚 conversation_id={id}: {e}");
            let _ = txn.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success": false, "error": "删除失败"})),
            )
                .into_response();
        }
    };
    match txn.commit().await {
        // checkpoint 钩子**在 commit 之后**（HTTP 不进事务，见 `drop_checkpoint_threads`）。
        // 失败只 warn、不改这次的响应：会话在业务库里已经删干净了，这时候回一句"删除失败"
        // 是假话——用户重试一次会得到 404。
        Ok(_) => {
            drop_checkpoint_threads(&threads).await;
            (StatusCode::OK, Json(json!({"success": true}))).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": "删除失败"})),
        )
            .into_response(),
    }
}

/// PATCH /api/chat/conversations/:id：部分更新（重命名 title / 置顶 pinned）。
/// 归属校验同 delete（不存在或非本人统一 404，防枚举）。
#[derive(Deserialize)]
pub struct UpdateConversationReq {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    pinned: Option<bool>,
}

pub async fn update_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
    Json(req): Json<UpdateConversationReq>,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 是这里**本就正确**的状态码（前端按 unauthorized 走登录态恢复），
        // 20260926 起多带一句 message：冻结与"令牌被收回"要能说清是哪种，
        // 否则当事人重登一次仍然进不来，却只看到一句"未登录"。
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "message": e.message()})),
            )
                .into_response();
        }
    };
    if req.title.is_none() && req.pinned.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "error": "nothing_to_update"})),
        )
            .into_response();
    }
    let owned = conversation::Entity::find_by_id(id)
        .filter(conversation::Column::UserId.eq(uid))
        .one(&state.db)
        .await
        .ok()
        .flatten();
    let Some(model) = owned else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"success": false, "error": "conversation_not_found"})),
        )
            .into_response();
    };
    // Model → ActiveModel 全字段 Set，只覆盖本次要改的字段
    let mut am: conversation::ActiveModel = model.clone().into();
    if let Some(t) = req.title {
        let t = t.trim();
        if t.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success": false, "error": "title_empty"})),
            )
                .into_response();
        }
        // char 级截 64（title 列 varchar(64)，防 UTF-8 截断 panic）
        am.title = Set(Some(t.chars().take(64).collect()));
    }
    if let Some(p) = req.pinned {
        am.pinned = Set(p);
    }
    // updated_at 写回原值：重命名/置顶属整理操作，不刷新"最后发言"活动排序
    //（防表结构日后带 ON UPDATE CURRENT_TIMESTAMP 时被自动 touch）
    am.updated_at = Set(model.updated_at);
    match am.update(&state.db).await {
        Ok(_) => (StatusCode::OK, Json(json!({"success": true}))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": "更新失败"})),
        )
            .into_response(),
    }
}

/// GET /api/chat/search 查询参数
#[derive(Deserialize)]
pub struct SearchQuery {
    /// 20260903f 消息级检索词：trim 后非空必填，空 → 400 q_required。
    #[serde(default)]
    q: Option<String>,
}

/// GET /api/chat/search?q=：会话历史**消息级**内容检索（20260903f 用户拍板形态——
/// 检索结果列表 = 命中的对话轮次（消息行）而非会话行；点行 → 切会话并定位到该
/// 消息）。只按 content LIKE（标题 = 首条用户消息截断，搜标题词自然命中首条轮次，
/// 无需单独标题匹配）；取候选池 = id desc limit 100，再**按会话活动时间倒序**重排
/// （20260919 用户拍板：与会话历史列表同序，行上时间 = 会话最后活动时间）；每行带
/// 会话标题 + conv_updated_at + 命中轮次自身时间。like_escape 同 list_conversations
/// （防 % _ \ 通配注入）。
pub async fn search_chat_messages(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 是这里**本就正确**的状态码（前端按 unauthorized 走登录态恢复），
        // 20260926 起多带一句 message：冻结与"令牌被收回"要能说清是哪种，
        // 否则当事人重登一次仍然进不来，却只看到一句"未登录"。
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized", "message": e.message()})),
            )
                .into_response();
        }
    };
    let q = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let Some(q) = q else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "q_required"})),
        )
            .into_response();
    };
    let pat = format!("%{}%", like_escape(q));
    // 候选池 = 最新 100 条命中（id desc），随后按**会话活动**重排（见下）
    let mut rows = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::Content.into_expr().ilike(&pat))
        .order_by_desc(chat_history::Column::Id)
        .limit(100)
        .all(&state.db)
        .await
        .unwrap_or_default();
    // 命中消息的会话元信息批量补查（标题 + 最后活动时间）
    let mut meta_by_conv: HashMap<i32, (Option<String>, i64)> = HashMap::new();
    {
        let ids: std::collections::HashSet<i32> =
            rows.iter().map(|r| r.conversation_id).collect();
        if !ids.is_empty() {
            let convs = conversation::Entity::find()
                .filter(conversation::Column::Id.is_in(ids.iter().copied()))
                .all(&state.db)
                .await
                .unwrap_or_default();
            for c in convs {
                meta_by_conv.insert(c.id, (c.title, naive_ms(c.updated_at)));
            }
        }
    }
    // 20260919（用户拍板）：与会话历史列表**同序**——会话活动时间倒序，同会话内命中
    // 消息 id 倒序。此前按消息 id 排 = 消息插入序：候选池里最旧会话的消息 id 也远大于
    // 最新会话的消息 id，于是一条 9 天前说的命中照样顶在列表最前，把"真正刚聊过的
    // 会话"压到下面。会话缺失（理论不可能：删会话在事务内级联删消息）记 0 排最后。
    let act_of = |id: i32| meta_by_conv.get(&id).map(|m| m.1).unwrap_or(0);
    rows.sort_by(|a, b| {
        act_of(b.conversation_id)
            .cmp(&act_of(a.conversation_id))
            .then(b.id.cmp(&a.id))
    });
    let hits: Vec<serde_json::Value> = rows
        .iter()
        .map(|h| {
            let (title, act) = meta_by_conv
                .get(&h.conversation_id)
                .map(|m| (m.0.clone(), m.1))
                .unwrap_or((None, 0));
            json!({
                "id": h.id,
                "conversation_id": h.conversation_id,
                // Option 原样透传 null（纯图轮会话未派生标题）→ 前端显示"新对话"
                "conv_title": title,
                // 行上时间用它（= 会话最后活动时间），不是命中那条消息的时间
                "conv_updated_at": act,
                "role": h.role,
                // char 级截 200 防大 payload；完整内容由切会话后的 history 拉取
                "content": h.content.chars().take(200).collect::<String>(),
                // 命中轮次自身的时间：前端挂在引文前，标注"这轮是什么时候说的"
                "time": naive_ms(h.created_at),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({"hits": hits, "count": hits.len()}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    // `like_escape` 的五条测试随实现一起搬到了 `crate::search_core::like_escape_tests`
    // （20261006）。这里不再留一份：同一份规则两份测试，改一份另一份开始假绿。
    // 会话搜索自己的那半（真库真的按字面匹配）仍在 `tests/pg_integration.rs`。

    // ── DB 时间戳 → 毫秒 ───────────────────────────────────────────────────
    #[test]
    fn 毫秒时间戳按本地钟面解释() {
        // 库里的 datetime 是 **+08:00 本地钟面**（不是 UTC）。判据就是这一条：
        // 把它当本地时间读 ⇒ 与"当 UTC 读"恰好差一个本机偏移。
        // 写成本地偏移的式子而不是 `assert_eq!(ms, expect)`：后者把函数体又抄了一遍，
        // 抄错了也一起错；这里两边来自**不同的** chrono 入口，叉乘得出真实结论。
        let t = chrono::NaiveDate::from_ymd_opt(2026, 10, 4)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let offset_ms = chrono::Local::now().offset().local_minus_utc() as i64 * 1000;
        assert_eq!(
            naive_ms(t),
            t.and_utc().timestamp_millis() - offset_ms,
            "本地钟面被当成 UTC 读了 ⇒ 前端时间戳整体飘一个时区（本机时区 UTC 时这条恒真，\
             那样说明不了问题，但也不会红）"
        );
    }
}
