mod control;
mod task_inputs;
pub use task_inputs::{submit_handler as task_input_handler, status_handler as task_input_status_handler};
mod pending;
mod persistence;
use persistence::{save_assistant_reply, save_execution_log, PERSISTENCE_ERROR};
mod protocol;
#[cfg(test)]
mod stream_tests;
use protocol::{Frame, event as stream_event};
use eventsource_stream::Eventsource;
use axum::response::sse::Sse;
mod approval;
pub use approval::cancel_handler;
use approval::claim_confirm_token;
#[cfg(test)]
use approval::{b64url_decode, token_jti};

use axum::{
    Json,
    body::Bytes,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::routes::AppState;
use crate::auth_jwt;
use crate::entity::user;
use tracing::{info, warn};

#[derive(Deserialize, Serialize)]
pub struct BrowserResult {
    pub command_id: String,
    pub status: String,
    pub path: String,
}

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub task_inputs: bool,
    #[serde(default)]
    pub resume_task: String,
    #[serde(default)]
    pub browser_feedback: bool,
    #[serde(default)]
    pub browser_result: Option<BrowserResult>,
    #[serde(default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub current_effects: Option<String>,
    #[serde(default)]
    pub current_darkmode: Option<String>,
    // 多模态图片输入（20260828，20260828s 多图）：前端压缩后的 dataURL 数组
    // （最多 6 张、每张 ≤1MB），透传 Python agent
    #[serde(default)]
    pub image: Option<Vec<String>>,
    // 会话标识（20260903 会话化）：显式 id 不存在/非本人 → 404 conversation_not_found
    // （在消息入库前拦截，不留脏行）；None → 服务端解析最新非空会话（无则自动新建），
    // 兼容部署过渡期仍缓存的旧前端（今天的单桶行为即"续接最新会话"）
    #[serde(default)]
    pub conversation_id: Option<i32>,
    // 隐藏确认请求（20260921 写操作确认弹窗）：用户在确认框上点了「确定」时由前端
    // 带上的 HMAC 待办令牌（agent 侧签发与验签，见 saudade-blog-agent/agent/confirm.py）。
    // 语义是"这是一次已授权的执行"而不是一条用户发言：
    //   ① **不落用户消息**（历史里不留空消息，否则污染 20 条注入窗口与标题派生）；
    //   ② Rust 侧**不验签**（单进程多线程、零状态；令牌的 uid/会话绑定由 agent 校验，
    //      agent 拿到的 uid 是本端已鉴权的 uid）；
    //   ③ 回复与执行回执照常落库（那就是真发生过的执行）。
    #[serde(default)]
    pub confirm_token: Option<String>,
    // 确认卡上"只办其中一件"的选择记号（20260929 批 F）：形态 `pick:<下标>`（0 基，
    // 对应签名清单里的位置），空 = 全部办。**纯透传**——与 confirm_token 的写法逐字
    // 同源：不验签、不解析、不落库（Rust 侧不知道卡片上有几件，也不该知道）。
    // 语义收窄只发生在 agent 侧（`confirm.narrow`）：越界/读不懂一律零执行。
    #[serde(default)]
    pub confirm_pick: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait, QuerySelect, ActiveModelTrait};
use sea_orm::sea_query::Expr; // Expr 不在 sea-orm 根（0.12.15 仅 pub use sea_query 全名）
use crate::entity::{
    agent_task, chat_history, chat_image, conversation, execution_log, pending_action,
};
use crate::routes::conversation::resolve_conversation_id;
use super::chat_context::{self, BootstrapContext};
use futures::StreamExt;
use async_stream::stream;

/// 对话上下文：由 prepare_chat 组装，/chat 与 /chat/stream 共用
struct ChatCtx {
    uid: i32,
    /// 本轮消息所属会话（prepare_chat 内解析，用户消息入库前确定）
    conversation_id: i32,
    trace_id: String,
    body: serde_json::Value,
    /// 当前数据库核实的角色，同时记录为本轮历史的来源；未知时保留为空。
    role: Option<String>,
}

/// 链路追踪：X-Request-ID 全链路透传（浏览器 → nginx → Rust → agent → LLM 日志）。
/// 上游给了就用，没给生成一个（r 前缀区分 Rust 生成，agent 端无上游 id 时会再生成）。
fn trace_id_of(req: &Request) -> String {
    req.headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("r{}", uuid::Uuid::new_v4().simple()))
}

/// 历史条目（GET /api/chat/history 返回）：id = DB 主键（前端稳定去重 id）
#[derive(Serialize)]
pub struct HistoryItem {
    pub id: i32,
    pub role: String,
    pub content: String,
    pub time: i64,
    /// 聊天图片（20261018）：完整 dataURL 数组，**与前端 `item.images` 同形状**
    /// （前端零转换直接塞进渲染路径）。空数组 = 这条消息没有图 —— **不是缺键**
    /// （前端 `migrateItem` 认的是数组本身，给 `null` 会走另一条路）。
    /// 顺序 = 用户发送顺序（`chat_image.seq`）。
    ///
    /// ⚠️ 只有 `GET /api/chat/history` 带这个字段；`GET /api/chat/search` 的命中行
    /// **不带**（只显示 200 字摘要，带图没意义，还要白扛几十 MB）。
    pub images: Vec<String>,
}

/// 历史响应里图片的字节预算（20261018）：8 MiB —— **与请求体上限同一个数**
/// （少一个要记的魔数）。为什么必须有：一次回 50 条，而 Rust 侧只校验请求体 8MB、
/// **不校验张数与单张大小**（前端那"最多 6 张 ×1MB"是**前端自律**）⇒ 理论最坏几十 MB。
/// 而 `saveHistory` 故意把 `images` 剥掉不落 localStorage ⇒ **每次刷新都要重下**；
/// 前端 `pullHistory` 有 8 秒超时，超时**静默**走 `applyLocal()`（只打一行 console）
/// ⇒ 用户看到的还是占位块、**没有任何红**。
/// 正常用法永远碰不到它，它是安全阀不是常规路径。
const CHAT_HISTORY_IMAGE_BUDGET: usize = 8 * 1024 * 1024;

/// 按预算裁剪图片（纯函数，判据在下面的 `mod tests`）。
/// 输入**从新到旧**的 `(消息 id, 该条图片总字节)`，返回允许带图的 id 集合。
/// 装不下的那条**与比它更早的全部**不给图 —— 给"残缺数组"（本该 3 张只给 1 张）
/// 会让用户以为图丢了，空数组走的是前端既有的"这条没图"路径，是诚实的那一个。
fn fit_image_budget(newest_first: &[(i32, usize)]) -> std::collections::HashSet<i32> {
    let mut out = std::collections::HashSet::new();
    let mut used = 0usize;
    for &(id, n) in newest_first {
        if n == 0 {
            continue; // 这条本来就没图，不占预算也不算"装不下"
        }
        if used + n > CHAT_HISTORY_IMAGE_BUDGET {
            break;
        }
        used += n;
        out.insert(id);
    }
    out
}

/// 先读取 id 与字节数，在预算内才读取 TOAST 大字段。
/// 第二次查询按第一步的图片 id 限定，避免两次查询之间新增图片突破预算。
async fn load_history_images(
    db: &sea_orm::DatabaseConnection,
    recent: &[chat_history::Model],
) -> Result<std::collections::HashMap<i32, Vec<String>>, sea_orm::DbErr> {
    let mut out = std::collections::HashMap::new();
    if recent.is_empty() { return Ok(out); }
    let ids: Vec<i32> = recent.iter().map(|h| h.id).collect();
    let sizes = chat_image::Entity::find()
        .select_only()
        .column(chat_image::Column::Id)
        .column(chat_image::Column::MessageId)
        .column_as(Expr::cust("octet_length(\"data\")"), "bytes")
        .filter(chat_image::Column::MessageId.is_in(ids))
        .into_tuple::<(i32, i32, i32)>()
        .all(db).await?;
    let mut totals = std::collections::HashMap::<i32, usize>::new();
    for (_, mid, bytes) in &sizes {
        *totals.entry(*mid).or_default() += (*bytes).max(0) as usize;
    }
    let budget_in: Vec<(i32, usize)> = recent.iter()
        .map(|h| (h.id, totals.get(&h.id).copied().unwrap_or(0))).collect();
    let allowed = fit_image_budget(&budget_in);
    let image_ids: Vec<i32> = sizes.into_iter()
        .filter(|(_, mid, _)| allowed.contains(mid)).map(|(id, _, _)| id).collect();
    if image_ids.is_empty() { return Ok(out); }
    let rows = chat_image::Entity::find()
        .filter(chat_image::Column::Id.is_in(image_ids))
        .order_by_asc(chat_image::Column::MessageId)
        .order_by_asc(chat_image::Column::Seq)
        .all(db).await?;
    for row in rows {
        out.entry(row.message_id).or_insert_with(Vec::new).push(row.data);
    }
    Ok(out)
}

/// GET /api/chat/history 查询参数（20260903 会话化）：conversation_id 可选——
/// 缺省 = 最新非空会话（部署过渡期旧前端不带参的降级路径，与 POST 的 None 语义对称）。
/// before_id（20260903e 内容搜索定位用）：只取 id < before_id 的会话内更早窗口
/// （每页 50，升序回传）——前端定位"检索命中但不在最近 50 条窗口内"的消息时逐页
/// 向前翻，直到命中或翻尽。
#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub before_id: Option<i32>,
}

/// 前端对话历史的权威数据源（20260828 重构：localStorage 降级为离线缓存；
/// 20260903 会话化：改为按会话取最近 50 条）。
/// 无/无效 token → 401（前端统一 fallback 本地 guest 历史；合规长文只属于
/// "使用 AI 服务"，历史读取有本地兜底）；显式 id 不存在/非本人 → 404
/// conversation_not_found（前端据此触发"当前会话已被删"恢复流程）；DB 查询失败 → 500。
pub async fn chat_history_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 保持原样（前端按 status 401 走登录态恢复），只多带一句 message
        // 说明是"冻结"还是"令牌被收回"（20260926）
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "items": [], "count": 0, "error": "unauthorized", "message": e.message()
                })),
            )
                .into_response();
        }
    };
    // 会话解析（GET 不自动建会话，保持无副作用）：无会话 → 200 空列表
    let conv_id = match resolve_conversation_id(&state.db, uid, query.conversation_id, false).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (StatusCode::OK, Json(serde_json::json!({"items": [], "count": 0}))).into_response();
        }
        Err(()) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"items": [], "count": 0, "error": "conversation_not_found"})),
            )
                .into_response();
        }
    };
    // 会话内最近 50 条（与前端显示上限一致）；会话内 order_by_desc(Id) 单调唯一、
    // 即时间序（单会话串行写入，CreatedAt 排序从此退役），命中 idx_conv_id 索引。
    // before_id 时改为"该 id 之前最近 50 条"（更早窗口翻页，仍升序回传）
    let mut finder = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conv_id));
    if let Some(bid) = query.before_id {
        finder = finder.filter(chat_history::Column::Id.lt(bid));
    }
    let recent = finder
        .order_by_desc(chat_history::Column::Id)
        .limit(50)
        .all(&state.db)
        .await
        .unwrap_or_default();
    let imgs = load_history_images(&state.db, &recent).await;
    let mut imgs_by_msg = match imgs {
        Ok(v) => v,
        Err(e) => {
            warn!(user_id = uid, conversation_id = conv_id,
                "chat: 历史图片查询失败（本轮历史不带图）: {}", e);
            std::collections::HashMap::new()
        }
    };
    let items: Vec<HistoryItem> = recent
        .iter()
        .rev() // 时间升序（聊天软件阅读序）
        .map(|h| HistoryItem {
            id: h.id,
            role: h.role.clone(),
            content: h.content.clone(),
            time: h.created_at.and_local_timezone(chrono::Local).single().map(|dt| dt.timestamp_millis()).unwrap_or(0),
            images: imgs_by_msg.remove(&h.id).unwrap_or_default(),
        })
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "items": items,
            "count": items.len(),
            // 20260903：回传实际会话 id——无参拉取（缺省=最新非空会话）时前端据此
            // 采纳当前会话（分键/回传/广播都需要它），不必再猜
            "conversation_id": conv_id
        })),
    )
        .into_response()
}

/// 丢弃本轮（POST /api/chat/discard，20260828b 新增）：用户点击"停止生成"时前端显式调用，
/// 删除指定会话最后一条 user 消息及后续残缺回复（全删语义）——主动停止 = 用户明确
/// 不想要这条进记忆，与连接中断时仅丢弃内存回复的行为互补。
/// 无/无效 token → 401。幂等：无 user 消息时无操作返回 success。
/// 20260903 会话化：范围收敛到 conversation_id（显式 / None → 最新非空会话；
/// 会话已被删 → 空操作 success，不阻断前端 abort 流程——恢复由其他端点的
/// conversation_not_found 驱动）。跨会话误删防护：新前端停止生成必带本轮的
/// conversation_id（旧前端不带 → 落到"最新非空会话"，等于其消息所在会话）。
/// 可选 body {"text": 原文}（20260829 重发机制）：非空时要求最后一条 user 消息
/// 与原文一致才删除——失败气泡重发路径防误删：用户失败后若已发新消息，绝不能用
/// 新轮顶替删除（abort 路径不带 body，最后一条 user 即被停止的轮，无需校验）。
/// 带图轮 DB content 是 "原文\n[图片…]" 拼接（prepare_chat 入库），校验兼容后缀。
#[derive(Deserialize)]
pub struct DiscardReq {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
}

pub async fn discard_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Option<Json<DiscardReq>>,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        // 401 保持原样，多带一句 message（同上）
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "success": false, "error": "unauthorized", "message": e.message()
                })),
            )
                .into_response();
        }
    };
    let conv_opt = payload.as_ref().and_then(|p| p.conversation_id);
    // 会话解析：显式 id 已删 / 无任何会话 → 空操作 success（幂等设计，见上注释）
    let conv_id = match resolve_conversation_id(&state.db, uid, conv_opt, false).await {
        Ok(Some(c)) => c,
        _ => return (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
    };
    let last_user = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conv_id))
        .filter(chat_history::Column::Role.eq("user"))
        .order_by_desc(chat_history::Column::Id)
        .one(&state.db)
        .await;
    let Ok(Some(u)) = last_user else {
        return (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response();
    };
    if let Some(Json(DiscardReq { text: Some(t), .. })) = payload {
        if !t.is_empty()
            && u.content != t
            && !u
                .content
                .strip_prefix(t.as_str())
                .map(|rest| rest.is_empty() || rest.starts_with("\n[图片"))
                .unwrap_or(false)
        {
            // 不匹配：期间已发新消息或原文不一致——不删任何记录（保留新轮）
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": false,
                    "reason": "mismatch",
                    "error": "最后一条消息不是重发原文（可能已发送新消息），未删除"
                })),
            )
                .into_response();
        }
    }
    if let Err(error) = chat_context::discard(&state.db, uid, conv_id, u.id).await {
        warn!(%error, user_id=uid, conversation_id=conv_id, "chat discard failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false, "error": "未能保存本次丢弃，请稍后重试"
        }))).into_response();
    }
    // 历史提交后同步清理执行内核上下文；带原文防止误删较新的轮次。
    crate::routes::conversation::drop_checkpoint_turn(conv_id, &u.content, uid).await;
    (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response()
}

/// 鉴权 + 请求体解析 + 会话解析 + 保存用户消息 + 加载历史/摘要 + 组装 agent 请求体。
/// 错误形态：Err(OK, …) = 历史 200 语义的 JSON 错误（合规文案/解析失败，前端既有
/// 分支不变）；Err(NOT_FOUND, …) = 会话不存在/非本人（404；前端按 body.error ==
/// conversation_not_found 恢复流程，与状态码无关）
async fn prepare_chat(state: &Arc<AppState>, req: Request) -> Result<ChatCtx, (StatusCode, Json<ChatResponse>)> {
    // 先取链路追踪 id（headers 在 into_body 前可读）
    let trace_id = trace_id_of(&req);
    // 从 Authorization header 提取 token（auth_jwt::auth_uid，20260830 上移共享；
    // 20260926 起它还负责判"账号是否冻结 / 令牌是否已被收回"，所以要多传一个 db）
    let auth = auth_jwt::auth_uid(&state.db, req.headers()).await;

    // 解析请求体（8MB：多模态多图 base64 数据（最多 6 张 × 每张 ≤1MB dataURL），
    // 原 2MB 会拒掉多图）
    let body_bytes = match axum::body::to_bytes(req.into_body(), 8 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return Err((StatusCode::OK, Json(ChatResponse { reply: String::new(), success: false, error: Some("请求体过大".into()) }))),
    };
    let payload: ChatRequest = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(e) => return Err((StatusCode::OK, Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("JSON解析失败: {}", e)) }))),
    };
    if !control::valid(&payload) {
        return Err((StatusCode::BAD_REQUEST, Json(ChatResponse {
            reply: String::new(), success: false,
            error: Some("继续任务请求包含无效标识或新的操作内容".into()),
        })));
    }

    let uid = match auth {
        Ok(id) => id,
        // 冻结 / 令牌已被收回（20260926）：**不能**落进下面那条访客分支——那会回一段
        // "请申请临时体验账号"的合规文案，把"你被冻结了"说成"你没登录"，
        // 当事人照着文案去申请账号只会白跑一趟。如实说是哪一件事。
        Err(e @ (auth_jwt::AuthError::Frozen | auth_jwt::AuthError::Revoked)) => {
            return Err((StatusCode::OK, Json(ChatResponse {
                reply: e.message().into(),
                success: false,
                error: Some(e.message().into()),
            })))
        }
        Err(_) => return Err((StatusCode::OK, Json(ChatResponse {
            reply: "尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客顶部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日".into(),
            success: true,
            error: None,
        }))),
    };

    // 角色（20260920，身份与权限地基）：查 DB 而非读登录 token 里的 role——token
    // 7 天有效，改过角色的用户会带着旧角色跑（与 middleware::auth_guard 同一条纪律）。
    // 角色以当前数据库为准；未知身份不补造权限或历史来源。
    let user_row: Option<user::Model> = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(u)) => Some(u),
        Ok(None) => None,
        Err(e) => {
            warn!(uid = uid, error = %e, "角色查询失败，按身份不明下发（agent 侧零权限）");
            None
        }
    };
    let role: Option<String> = user_row.as_ref().map(|u| u.role.clone())
        .filter(|role| crate::authz::is_known_role(role));

    // 会话解析（20260903 会话化）——必须在用户消息入库前完成：显式 id 非法 → 404
    // 拦截不留脏行；None → 最新非空会话（无则自动新建 = 历史单桶行为，旧前端降级）。
    // 全部 Err 路径都在入库前返回，非法会话不产生任何写入
    let conversation_id = match resolve_conversation_id(&state.db, uid, payload.conversation_id, true).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            // 仅建会话失败（DB 故障）会走到这里：按服务不可用返回，不落任何行
            return Err((StatusCode::OK, Json(ChatResponse { reply: String::new(), success: false, error: Some("会话创建失败，请稍后重试".into()) })));
        }
        Err(()) => {
            return Err((StatusCode::NOT_FOUND, Json(ChatResponse { reply: String::new(), success: false, error: Some("conversation_not_found".into()) })));
        }
    };

    // 保存用户消息（取回主键供中断清理快照：只删其后的残缺回复，用户消息本体保留）
    // 图片轮：落库加 "[图片]"（单图）/"[图片×N]"（多图）文本标记（后续轮历史中模型
    // 可感知该轮有图；图片本体不落库）
    // 隐藏确认轮（20260921）：**不落用户消息**——它代表的是一次点击而非一条发言，
    // 落一条空消息会占掉注入窗口、干扰标题派生，前端也不该出现这条气泡（前端同样不发）
    let is_confirm = payload.confirm_token.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

    // ── 额度闸门（20260929）────────────────────────────────────────────────────
    // **位置是判据**：落在 `is_confirm` 之后、确认令牌认领之前。
    //   · 确认轮**整段跳过**（不读、不写，这一轮免费）：主人点一次确认卡不是新的一轮
    //     对话。早几行落的话每次点确认都会烧掉一轮，而现成的离线判据**一条都抓不到**
    //     （前端 `.test.py` 沙箱用的是假 axios，跑不到这一段）——真机核对第 2 条是它
    //     唯一的判据。
    //   · 复用的是上面那次已经取回来的 user 行 ⇒ **零额外查询**。
    //   · 不限量的角色（`quota::is_unlimited` ⇒ admin/superadmin）**不发 UPDATE**：
    //     既不增长，也不为"扣了再撤销"制造一条假记录。
    //   · DB 故障（`Degraded`）⇒ `quota` 保持 None ⇒ body 里 `chat_quota` **整个键缺席**。
    //     **绝不发零值**：那会让 agent 对着正在说话的访客说一句"剩 0 轮"，而他自己
    //     刷新一次就能证伪。fail-open 与上方那次角色查询同一取向——DB 抖动不阻断对话。
    //   · 用尽 ⇒ 只置 `quota_blocked`，**其余一切照旧**（用户消息入库、标题派生、
    //     updated_at bump、边界快照都不动）：额度管"能不能用"，记录管"发生过什么"。
    //     拒答那句话由 agent 侧写（见 C7）——那里已有确定性拒答帧协议，
    //     在这里合成 SSE 要复制一份帧协议，且早期出口是 HTTP 200 + JSON body，
    //     流式前端根本解析不出帧（既有隐患，另开一票）。
    let (quota, quota_blocked) = if is_confirm {
        (None, false)
    } else {
        let role_ref = user_row.as_ref().map(|u| u.role.as_str());
        if crate::quota::is_unlimited(role_ref) {
            (Some(crate::quota::view(0, 0, true)), false)
        } else {
            let limit = crate::quota::limit();
            // 这一行的用量：只用于**注入一行事实**，不是判据——判据是那条带
            // `WHERE chat_quota_used < ?` 的 UPDATE。并发下它可能比真实值小一两轮
            // （读到之后、扣之前另一轮先扣了），代价是 agent 报的剩余轮数略偏高；
            // 为此多查一次库不值得（多一次查询 = 多一处失败面）。
            let seen_used = user_row.as_ref().map(|u| u.chat_quota_used).unwrap_or(0);
            match crate::quota::try_consume(&state.db, uid, limit).await {
                crate::quota::ConsumeOutcome::Consumed => {
                    (Some(crate::quota::view(seen_used + 1, limit, false)), false)
                }
                crate::quota::ConsumeOutcome::Exhausted => {
                    info!(
                        user_id = uid, trace_id = %trace_id, used = seen_used, limit = limit,
                        "chat: 额度用尽，本轮零 LLM 拒答（仍然入对话记录）"
                    );
                    (Some(crate::quota::view(seen_used, limit, false)), true)
                }
                crate::quota::ConsumeOutcome::Degraded => (None, false),
            }
        }
    };

    // Legacy cards retain the host claim; signed native executors own replay.
    if is_confirm {
        if let Some(tok) = payload.confirm_token.as_deref() {
            if let Some(reason) = claim_confirm_token(&state.db, uid, tok).await {
                // 留痕（不含令牌）：重放/双标签页同点这件事此前在链路上完全无声，
                // 而它是"点了一次确定，什么都没发生"的三种成因之一。
                info!(user_id = uid, conversation_id, "chat: 确认令牌已被用掉，零转发：{}", reason);
                return Err((
                    StatusCode::CONFLICT,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("confirm_already_used".into()),
                    }),
                ));
            }
        }
    }
    let stored_content = match payload.image.as_deref() {
        // 20260829b：空数组不拼标记（防御旧客户端发 image:[]）——否则无图消息
        // 也带 [图片] 落库，pull 后前端全部 user 气泡出现图片图标
        Some(v) if v.is_empty() => payload.message.clone(),
        Some(v) if v.len() > 1 => format!("{}\n[图片×{}]", payload.message, v.len()),
        Some(_) => format!("{}\n[图片]", payload.message),
        None => payload.message.clone(),
    };
    let user_msg_id = if is_confirm || !payload.resume_task.is_empty() {
        None
    } else {
        chat_history::ActiveModel {
            user_id: Set(uid),
            conversation_id: Set(conversation_id),
            role: Set("user".into()),
            source_role: Set(role.clone()),
            content: Set(stored_content.clone()),
            ..Default::default()
        }.insert(&state.db).await.ok().map(|m| m.id)
    };

    // 图片按消息批量原子写入；失败保留已保存的用户文本并告警。
    // 删除随消息外键级联，确认请求没有新消息可挂靠。
    if let (Some(mid), Some(imgs)) = (user_msg_id, payload.image.as_deref()) {
        if !imgs.is_empty() {
            let rows: Vec<chat_image::ActiveModel> = imgs
                .iter()
                .enumerate()
                .map(|(i, data)| chat_image::ActiveModel {
                    message_id: Set(mid),
                    seq: Set(i as i16),
                    data: Set(data.clone()),
                    ..Default::default()
                })
                .collect();
            if let Err(e) = chat_image::Entity::insert_many(rows).exec(&state.db).await {
                warn!(
                    user_id = uid,
                    conversation_id,
                    message_id = mid,
                    count = imgs.len(),
                    "chat: 聊天图片落库失败（图没存上，回复照常）: {}",
                    e
                );
            }
        }
    }

    // 会话标题守卫 + 最后活动时间（列表排序）
    if user_msg_id.is_some() {
        // 标题 = 首条用户消息剥尾部图片标记后截 40 字符（derive_conv_title）。
        // 条件 UPDATE 语句级原子：并发首条只有一个命中 = first-writer-wins；
        // 剥空（纯图轮）保持 NULL，下一条文字消息自动补派生
        // **确认轮跳过**（20260921）：它没有用户消息，拿合成文本派生标题
        // 会把会话名写成"确认执行：…"，与"标题 = 首条用户消息"的语义不符
        if let Some(title) = derive_conv_title(&stored_content) {
            let _ = conversation::Entity::update_many()
                .col_expr(conversation::Column::Title, Expr::value(title).into())
                .filter(conversation::Column::Id.eq(conversation_id))
                .filter(
                    Expr::col(conversation::Column::Title)
                        .is_null()
                        .or(Expr::col(conversation::Column::Title).eq("")),
                )
                .exec(&state.db)
                .await;
        }
    }
    // Confirmation and continuation are activity without new user messages.
    if user_msg_id.is_some() || is_confirm || !payload.resume_task.is_empty() {
        let _ = conversation::Entity::update_many()
            .col_expr(conversation::Column::UpdatedAt, Expr::current_timestamp().into())
            .filter(conversation::Column::Id.eq(conversation_id))
            .exec(&state.db)
            .await;
    }

    let memory = chat_context::load_bootstrap(
        &state.db, uid, conversation_id, role.as_deref(), user_msg_id,
    ).await.unwrap_or_else(|error| {
        warn!(%error, conversation_id, "chat memory unavailable; continuing without imported context");
        BootstrapContext::default()
    });

    // 跨轮执行记忆（20260904 C5；20260920 批次 c 补时间戳 + 去重）：读本会话最近
    // 40 条执行回执（execution_log.detail 写时已渲染定稿，这里直取零映射），**读侧**
    // 去重后取最近 8 条 → "· " 拼串注入 recent_executions=——供"质疑上轮执行是否属实"
    // 据实作答（双向失真修复：编造"欢迎回来"/否认真实显示）。
    //  - **去重**：同一动作重复执行（连跑几遍同一个检索/同一句屏显）会占满 8 行窗口，
    //    跨轮记忆里就只剩同一件事（20260920 实证：窗口里 4 行同款）；现按 detail
    //    合并，保留最近一次的时间、附（×N）。取 40 去重是为了"8 条不同的动作"这个
    //    窗口语义本身能被满足（先取 8 再去重会退化）。
    //  - **时间戳**：行首 MM-DD HH:MM = created_at（+08:00 本机钟面，与全站时区约定
    //    一致，不做二次偏移）；落库时刻 = 该轮回复收尾，与真实执行相差仅数秒。质疑轮
    //    叙及"刚刚/刚才那次"才有依据——无时序的 8 行分不清哪次是刚发生的。
    //  - 两处都在读侧 ⇒ DB 里的存量回执无需迁移/回填，旧会话回看即带时间。
    // 读取失败（表未建/DB 抖动）→ 空串，agent 端按"无记录"如实处理，不阻断对话。
    let (executions_text, recent_tools, execution_rows): (String, Vec<String>, String) = {
        let recent = execution_log::Entity::find()
            .filter(execution_log::Column::UserId.eq(uid))
            .filter(execution_log::Column::ConversationId.eq(conversation_id))
            .order_by_desc(execution_log::Column::Id)
            .limit(Some(40))
            .all(&state.db)
            .await
            .unwrap_or_default();
        // 由新到旧扫描：首次见到某动作 = 它最近的一次（记时间），之后同款只累加次数
        let mut seen: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        let mut rows: Vec<ExecRow> = Vec::new();
        for r in &recent {
            match seen.get(r.detail.as_str()) {
                Some(i) => rows[*i].2 += 1,
                None => {
                    seen.insert(r.detail.as_str(), rows.len());
                    rows.push((
                        r.created_at.format("%m-%d %H:%M").to_string(),
                        r.detail.as_str(),
                        1,
                        r.payload.as_deref(),
                    ));
                }
            }
        }
        rows.truncate(8);
        let text = rows
            .iter()
            .rev() // 新→旧取回 → 旧→新拼串
            .map(|(at, detail, n, _)| {
                if *n > 1 {
                    format!("{at} {detail}（×{n}）")
                } else {
                    format!("{at} {detail}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n· ");
        // 上一轮执行过的**工具名**（20260929 批 F1'）：**同一次查询、同一批行**取
        // `tool` 列而不是渲染好的 detail——detail 是给人看的动作行，工具名是给判据
        // 用的机器事实。去重后截 8 条，与上面 `rows.truncate(8)` 同口径（"最近 8 条
        // 不同的动作"），于是"上一轮读过审核队列吗"有了一个**类型化**的说法，不再
        // 只靠对 narrator 散文做正则。
        // `tool` 是 20260927 才加的列：NULL（存量行）与空串一律跳过，**不当成一个
        // 工具名**（把"不知道"塞进"已知"那一栏，正是这一族最贵的错法）。
        let mut seen_tool: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut tools: Vec<String> = Vec::new();
        for r in &recent {
            let Some(t) = r.tool.as_deref() else { continue };
            if t.is_empty() || !seen_tool.insert(t) {
                continue;
            }
            tools.push(t.to_string());
            if tools.len() >= 8 {
                break;
            }
        }
        (text, tools, exec_rows_json(&rows))
    };

    // 跨轮待办（20260923）：本会话最新一条**仍 pending 且未超时效**的待办，渲染成
    // 一行给 agent（planner 见它才知道"上一轮我提过一件事、还没办"）。读失败
    // （表未建/DB 抖动）→ 空串，agent 按"没有待办"如实处理，绝不阻断对话。
    let pending_text: String = {
        let cutoff = chrono::Local::now().naive_local()
            - chrono::Duration::minutes(PENDING_READ_TTL_MINUTES);
        pending_action::Entity::find()
            .filter(pending_action::Column::ConversationId.eq(conversation_id))
            .filter(pending_action::Column::Status.eq("pending"))
            .filter(pending_action::Column::CreatedAt.gte(cutoff))
            .order_by_desc(pending_action::Column::Id)
            .one(&state.db)
            .await
            .ok()
            .flatten()
            .map(|r| render_pending_action(&r))
            .unwrap_or_default()
    };

    // 会话级任务状态（20260927）：本会话未完结的任务。与上面那条的分工写在迁移文件
    // 头注里——`pending_action` 是"等你点头的一件事"（分钟级），这里是"还没做完的
    // 几件事"（跨多轮）。读失败 → `[]`（agent 按"没有任务"如实处理）。
    let agent_tasks = load_agent_tasks(&state.db, conversation_id).await;

    let mut body = serde_json::json!({
        "message": payload.message,
        "task_id": payload.task_id,
        "task_inputs": payload.task_inputs,
        "resume_task": payload.resume_task,
        "browser_feedback": payload.browser_feedback,
        "browser_result": payload.browser_result,
        "conversation_id": conversation_id,
        "current_url": payload.current_url.as_deref().unwrap_or(""),
        "page_title": payload.page_title.as_deref().unwrap_or(""),
        "current_effects": payload.current_effects.as_deref().unwrap_or(""),
        "current_darkmode": payload.current_darkmode.as_deref().unwrap_or(""),
        "image": payload.image.clone().unwrap_or_default(),
        "user_id": uid,
        "history": memory.history,
        "history_scope": memory.history_scope,
        "summary": memory.summary,
        "summary_scope": memory.summary_scope,
        "executions": executions_text,
        "pending_action": pending_text,
        "agent_tasks": agent_tasks,
        "confirm_token": payload.confirm_token.as_deref().unwrap_or(""),
        "recent_tools": recent_tools,
        "execution_rows": execution_rows,
        "confirm_pick": payload.confirm_pick.as_deref().unwrap_or(""),
    });

    // 额度两个键（20260929）**必须条件插入**——`json!` 对 `Option` 会写成 `null`，
    // 而 C1/C3 的契约是"读不到就没有这个键"：agent 侧 `null` 与缺席都会走到
    // "什么都不注入"，但 `null` 会让 `quota_blocked: null` 这种形状透到下游，
    // 且掩盖了"键缺席"这条明确语义。**缺席 ≠ 零值**，这是本批反复强调的一条。
    if let Some(obj) = body.as_object_mut() {
        if let Some(q) = &quota {
            obj.insert("chat_quota".into(), crate::quota::forward_json(q));
        }
        if quota_blocked {
            obj.insert("quota_blocked".into(), serde_json::Value::Bool(true));
        }
    }

    if std::env::var("CHAT_DEBUG_BODY").is_ok() {
        eprintln!("[chat-debug] body={}", body);
    }
    Ok(ChatCtx { uid, conversation_id, trace_id, body, role })
}


/// 会话标题派生（20260903）：首条用户消息剥尾部图片标记行后取前 40 字符。
/// 入库格式最后一行可能是 "[图片]" / "[图片×N]"（prepare_chat 拼接）；剥空（纯图轮）
/// → None：保持 NULL，前端显示"新对话"，下一条文字消息自动补派生。
/// 截断用 .chars()（UTF-8 安全；字节切片 [..40] 遇中文会 panic）
fn derive_conv_title(content: &str) -> Option<String> {
    let mut lines: Vec<&str> = content.lines().collect();
    while let Some(last) = lines.last() {
        let is_marker = *last == "[图片]"
            || (last.starts_with("[图片×") && last.ends_with(']'));
        if is_marker { lines.pop(); } else { break; }
    }
    let text = lines.join("\n").trim().to_string();
    if text.is_empty() { return None; }
    Some(text.chars().take(40).collect())
}

/// 写操作行的执行身份前缀（20260921 第二轮，管理助手）。
///
/// detail 进生产库、之后又被注入回 narrator 的上下文，写操作**必须**留得下
/// "这是谁动的"——那是审计记录唯一的存在形式（用户拍板"零迁移：写进 detail"）。
/// 取不到角色（旧回执 / 字段缺失）返回**空串**而不是"访客"：写操作从不由访客
/// 发起，把管理员的操作标成访客是伪造审计记录，宁可不写前缀。
/// 只落角色、**不落 uid**（uid 会进生产库并被 narrator 念出来）。
fn actor_prefix(row: &serde_json::Value) -> String {
    match row["principal_role"].as_str().unwrap_or("") {
        "admin" => "以管理员身份 · ".to_string(),
        // 超级管理员（20260926）：不加这一臂的后果是"超管动的那一下，回执上什么都没写"，
        // 而前缀缺失与"旧回执没这个字段"长得一模一样 ⇒ 审计链上凭空少一截。
        "superadmin" => "以超级管理员身份 · ".to_string(),
        _ => String::new(),
    }
}

/// 变更前 → 变更后（agent 侧回执顶层 before/after，均为字符串）。
/// 任一侧缺失就只显示有的那侧；两侧都缺 → 空串（调用方自己带上"修改文章 N："）。
fn arrow(row: &serde_json::Value) -> String {
    let before = row["before"].as_str().unwrap_or("");
    let after = row["after"].as_str().unwrap_or("");
    match (before.is_empty(), after.is_empty()) {
        (false, false) => format!("{} → {}", before, after),
        (false, true) => before.to_string(),
        (true, false) => after.to_string(),
        (true, true) => String::new(),
    }
}

/// 回执 args 里**列表参数**的取回（20260923）。
///
/// agent 侧落回执前把每个实参统一 `str(v)`（`agent/graph.py` execute_node 的
/// rcpt 构造——那是为了跨语言契约里只留一种类型），所以一个 `[7, 8]` 到了这里
/// 是**字符串** `"[7, 8]"`（Python 的 list repr）。这个函数把那串 repr 里的正整数
/// 取回来；形态认不出就返回空（调用方自会退回不带列表的说法，绝不猜编号）。
fn py_int_list(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"'))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
        .collect()
}

/// 动作措辞的**唯一实现**在 Python（`agent/action_text.py::receipt_action`，落回执顶层
/// `action`）——20260928 收敛：此前这里与 `server.py::_tool_action_text` 是两份互不
/// 相干的实现（同一件事两处措辞），逐行对照实测 54 条取样只有 31 条逐字相同。
///
/// **这里从此只排版**，四件都不搬去 Python（它们要么依赖本地渲染语境、要么是列宽问题）：
///   ① `actor_prefix`——写操作的执行身份前缀（回执行里的"谁做的"，呈现层的事）；
///   ② 方括号归一为「」——只对渲染产物做，args 里的原始内容仍是 `[` `]`；
///   ③ `digest` 拼接——实体摘要（`agent/entities.py` 产）拼在动作行后面；
///   ④ 列宽截断——无摘要 120、有摘要 300（detail 列宽 varchar(300)）。
///
/// `action` 缺失或为空串时回落 `legacy_exec_row`：存量回执（20260928 之前落库的行）
/// 与**无臂工具**（Python 侧没收敛的那几件）都走它——于是这次改动的**存量行为逐字节
/// 不变**，只有新回执带 `action` 的那些行换成新措辞。
fn render_exec_row(row: &serde_json::Value) -> String {
    let detail = match row["action"].as_str() {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => legacy_exec_row(row),
    };
    // 写操作带执行身份前缀（20260921 第二轮）：非写回执没有 principal_role，
    // actor_prefix 返回空串，行为与改动前逐字节一致。
    let detail = format!("{}{}", actor_prefix(row), detail);
    let detail = detail.replace('[', "「").replace(']', "」");
    // 实体摘要（20260920，agent/entities.py 产）：数据工具取回的条目/计数/候选标题，
    // 随回执落库——工具帧只活当轮，不落这一行则下轮「第二条写了什么」只能把工具再跑
    // 一遍（探针实测）。agent 只搬事实、Rust 只做拼接（语义渲染仍在数据所在的一侧）。
    // 有摘要时上限放宽到列宽（varchar(300)），无摘要保持 120 不变。
    let digest = row["digest"].as_str().unwrap_or("");
    if digest.is_empty() {
        detail.chars().take(120).collect()
    } else {
        format!("{} — {}", detail, digest).chars().take(300).collect()
    }
}

/// 结构那份的字符预算（= agent 侧 `ChatRequest.execution_rows` 的 `max_length`）。
/// **两处必须同值**：Rust 多给一个字符，agent 那侧就是每轮对话 422。
const EXEC_ROWS_MAX_CHARS: usize = 8000;

/// 去重后的一行执行回执：`(时间, 渲染好的动作行, 次数, 回执原文)`。
/// 前三个字段喂 `executions` 那个拼串，第四个只喂结构那份（`exec_rows_json`）。
type ExecRow<'a> = (String, &'a str, usize, Option<&'a str>);

/// 跨轮执行记忆的**结构那份**（20261020）：`[{at, n, payload}]` 的 JSON 数组串。
///
/// 与同一批行渲染出的 `executions` **同源同序**；这里只做"取出来、限长、拼成合法
/// JSON"，形状与语义的演化只动 agent 一侧（同 `agent_tasks` 的先例，见 `load_agent_tasks`
/// 那条注）。`payload` = 回执原文（20260927 加列），存量行为 `NULL` ⇒ `null`——
/// **agent 侧按"拿不到结构就不进锚点"处理**，不回落去解析渲染好的 detail：那正是
/// "结构化事实先编码进人话、再正则抠回"这条路，这批拆的就是它。
///
/// **限长是硬要求**：agent 侧 `ChatRequest.execution_rows` 有 `max_length`（同值），
/// 超了就是每轮对话 422。所以超预算时**从最旧的一行开始**把 payload 降成 `null`
/// （最近的几行才是判据要用的），并记一条 WARNING —— 不许静默砍。
fn exec_rows_json(rows: &[ExecRow<'_>]) -> String {
    let mut out: Vec<serde_json::Value> = rows
        .iter()
        .rev() // 新→旧取回 → 旧→新输出（与 executions 同一顺序）
        .map(|(at, _detail, n, payload)| {
            serde_json::json!({
                "at": at,
                "n": n,
                "payload": payload.and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()),
            })
        })
        .collect();
    let mut dropped = 0usize;
    while serde_json::to_string(&out).map(|s| s.len()).unwrap_or(0) > EXEC_ROWS_MAX_CHARS {
        let Some(obj) = out.iter_mut().find_map(|r| {
            let o = r.as_object_mut()?;
            (!o.get("payload")?.is_null()).then_some(o)
        }) else {
            break; // 已经没有可降的了：剩下的只有 at/n，本身就在预算内
        };
        obj.insert("payload".to_string(), serde_json::Value::Null);
        dropped += 1;
    }
    if dropped > 0 {
        tracing::warn!(
            "[chat] execution_rows 超预算（上限 {EXEC_ROWS_MAX_CHARS} 字符），最旧 {dropped} 行的 payload 降为 null"
        );
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// 老表（20260904 起、逐轮补臂的那一张）：**只在 `render_exec_row` 认不出 `action` 时
/// 走**——存量回执行（20260928 之前落库的）与 Python 侧尚未收敛的工具（`action_text.py`
/// 对它们返回空串）。新工具的动作词加在 Python 那侧，**别再加到这里**。
///
/// **本表自 20260929 起冻结：只减不增。** 一条臂的两种活路径都要求"这个工具在
/// 20260928（动作措辞搬去 Python 那天）就已经存在"：要么是 agent 回滚到旧版本后
/// 送进来的回执行，要么是 Python 侧至今没有臂的工具（`action_text.py` 只对两件死工具
/// 返回空串）。**新工具两条都不满足**——回滚到没有这个工具的旧 agent，它压根不会出现在
/// 回执行里；Python 那侧则一定有臂（`test_action_text.py` ③ 有 `_unarmed == 两件死工具`
/// 那条锁）。所以给新工具加臂是**永远走不到的死代码**，而它看着像"两边都写了一遍、
/// 互为对账锚点"⇒ 让措辞的跨语言对账显得比实际更严——20260929 批 G 曾照着这个错觉给
/// `reschedule_dashboard_todo` 加过一臂，已撤。
/// 这条纪律不是靠上面这段话守的：`tests/test_action_text.py` ④ 从本函数现取臂集合，
/// 拿"注册表里**没有**臂的工具"与一份声明相等比较——**给任何工具加一条臂都会红**，
/// 逼作者先写清理由（要加得先改那份声明）。
///
/// 跨轮执行记忆渲染（20260904）：checker 验收回执行 → 中文动作行，写时一次定稿、
/// 读时零映射（execution_log.detail 落的就是这里的产物，prepare_chat 直取拼串）。
/// 输入 = Python agent __EXEC__ 帧里的 {skill,tool,args,result,ts}。动作词映射
/// 按 tool 名；内容取自 args（文案注入后值——device_oled_display 的 args.text 即
/// 实际屏文）；残余 [ ] 归一为「」（容 args 里带方括号的内容），截 ≤120 字。
///
/// 20260921 第二轮起，**写操作**（write.console）的回执另带顶层
/// principal_role/op/article_id/before/after/tag_name/level（键名是 Python 写、
/// Rust 读的跨语言契约，见 agent/graph.py 的 _RCPT_META_KEYS；两侧都要同步改）。
/// 全部按字符串取——agent 侧落库前统一 str()，不留 int/str 混装。
/// 20260921 第三轮补 `category_name` 与 `change`：标签改/删与分类增删改的渲染
/// 需要一句人话描述（改名/改色/换层级/影响了几篇文章），它由 agent 侧生成。
fn legacy_exec_row(row: &serde_json::Value) -> String {
    let tool = row["tool"].as_str().unwrap_or("");
    let args = row["args"].as_object().cloned().unwrap_or_default();
    let arg = |k: &str| -> String {
        args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    let detail = match tool {
        "device_oled_display" => format!("屏幕显示「{}」", arg("text")),
        "navigate_to" => format!("跳转「{}」", arg("path")),
        "toggle_effect" => {
            let on = arg("action") != "off";
            format!("特效「{}」已{}", arg("effect"), if on { "开" } else { "关" })
        }
        // Python 侧 toggle_dark_mode 实参 = {"mode": "on"|"off"}（skills.py 模板 $mode，
        // 经 str() 落盘仍为字符串）——曾误读 arg("on") 且比 "True"（bool 形态属其他
        // 工具），键值双错位导致每次执行记录恒渲染「已关」
        "toggle_dark_mode" => format!(
            "夜间模式已{}", if arg("mode") == "on" { "开" } else { "关" }
        ),
        "search_notes" => format!("搜索「{}」", arg("keyword")),
        "rag_search" => format!("站内检索「{}」", arg("query")),
        // 带标题（20260912）：回执顶层的 title（agent 侧从详情返回提取的 noteTitle，与
        // args 平级——它是派生事实不是工具实参）非空时展示《标题》：下轮「那篇讲架构的」
        // 要对得上号，只有 id 无从核对（跨轮指代锚点）。缺失（提取失败/旧回执）回落纯 id。
        //
        // 动作词按 **doc_type** 取（20260928）：get_article_detail 是**四个数据源共用的
        // 一件工具**（note/talk/board/announcement），此前这里恒渲染「读取文章」⇒ 读一条
        // 留言，跨轮执行记忆里写的是「读取文章 100」，下一轮 narrator 照抄，主人看到的
        // 就是"把留言编号当成文章"（trace `20260928T032411` 实证：那两条 100/97 全是
        // `doc_type=board` 的留言读取）。title 只有 note 分支会派生（agent 侧 `_doc_title`
        // 只认 `noteTitle`），所以这里按 doc_type 分名词、标题仍只在非空时附上。
        // 中文名词与 Python 侧同源：`tools/base.py::DOC_TYPE_CN`（改一处必须同步另一处）。
        "get_article_detail" => {
            let what = match arg("doc_type").as_str() {
                "board" => "留言",
                "talk" => "说说",
                "announcement" => "公告",
                _ => "文章",
            };
            match row["title"].as_str().unwrap_or("") {
                "" => format!("读取{} {}", what, arg("article_id")),
                t => format!("读取{} {}《{}》", what, arg("article_id"), t),
            }
        }
        "list_devices" => "查看设备列表".to_string(),
        "get_current_time" => "查看当前时间".to_string(),
        "list_guestbook" => "查看留言板".to_string(),
        "list_talks" => "查看说说".to_string(),
        "get_announcements" => "查看公告".to_string(),
        "list_notes" => "查看文章列表".to_string(),
        // 站点信息类数据工具（20260913 入 planner 白名单）：此前 planner 点不到、
        // 无从执行，渲染层也就没有对应动作词，落默认「操作记录(<tool>)」内部格式。
        // 措辞与 agent 侧 server.py _NOARG_VERB 同源，跨轮执行记忆行才读得懂。
        "get_blog_info" => "查看博客信息".to_string(),
        "get_social_links" => "查看社交链接".to_string(),
        "get_site_map" => "查看站点结构".to_string(),
        "get_top_notes" => "查看置顶文章".to_string(),
        "list_categories" => "查看分类".to_string(),
        "list_tags" => "查看标签".to_string(),
        "get_weather" => format!("查看天气「{}」", arg("location")),
        // 管理助手报表类（20260921）：措辞与 agent 侧 server.py _NOARG_VERB 同源。
        // 这几个必须显式列出——漏了会落进默认分支，把 `操作记录(get_server_status)`
        // 这种内部工具名连同下划线写进 execution_log，narrator 跨轮读到会照抄给用户。
        "get_server_status" => "查看服务器状态".to_string(),
        "get_service_health" => "查看服务健康".to_string(),
        "get_moderation_status" => "查看审核状况".to_string(),
        "get_user_stats" => "查看用户统计".to_string(),
        // 后台管理面（20260921 第二轮）：读一个 + 写三个。写行**刻意不带《标题》**
        // ——回执会经 recent_executions 注入下一轮上下文，带《文章标题》会被读成
        // "我读过这篇"的跨轮指代证据（rule 6b 的取值指代走 digest 那套）。
        // 措辞与 agent 侧 server.py _NOARG_VERB / _tool_action_text 同源。
        "list_admin_notes" => "查看后台文章列表".to_string(),
        "create_tag" => {
            // tag_name 是回执**顶层** meta（与 op/level 同族，见 _RCPT_META_KEYS），
            // 不是工具实参——曾误读 args["tag_name"]（该键不存在），生产上每次新建
            // 标签都渲染成「新建一级标签「」」（名字恒空），跨轮执行记忆跟着失真。
            let name = row["tag_name"].as_str().unwrap_or("");
            let lvl = if row["level"].as_str().unwrap_or("1") == "2" { "二级" } else { "一级" };
            if row["op"].as_str().unwrap_or("") == "tag_reuse" {
                format!("复用已有{}标签「{}」", lvl, name)
            } else {
                format!("新建{}标签「{}」", lvl, name)
            }
        }
        // 标签改/删 + 分类增删改（20260921 第三轮）：与 create_tag 同族，读的是回执
        // **顶层 meta**（tag_name/level/category_name/change），不是工具实参。
        // `change` 是一句中文描述（改名/改色/换层级/影响面），由 agent 侧生成——
        // 渲染语义留在数据所在的一侧，这里只拼装。
        "update_tag" => {
            let name = row["tag_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改标签「{}」", name)
            } else {
                format!("修改标签「{}」：{}", name, change)
            }
        }
        "delete_tag" => {
            let name = row["tag_name"].as_str().unwrap_or("");
            let lvl = if row["level"].as_str().unwrap_or("1") == "2" { "二级" } else { "一级" };
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("删除{}标签「{}」", lvl, name)
            } else {
                format!("删除{}标签「{}」：{}", lvl, name, change)
            }
        }
        "create_category" => {
            format!("新建分类「{}」", row["category_name"].as_str().unwrap_or(""))
        }
        "update_category" => {
            let name = row["category_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改分类「{}」", name)
            } else {
                format!("修改分类「{}」：{}", name, change)
            }
        }
        "delete_category" => {
            let name = row["category_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("删除分类「{}」", name)
            } else {
                format!("删除分类「{}」：{}", name, change)
            }
        }
        // 站内公告代发/改/删（20260922 第五轮）：同族，读回执顶层 meta
        // （announcement_title/announcement_id/change）。**一律不带正文**——公告正文
        // 可能有几百字，而 detail 列宽 300、读侧只取最近 8 行：把正文写进回执行会把
        // 跨轮执行记忆的窗口占满，还会让"我发过这条公告"的正文跨轮被 narrator 复述。
        "create_announcement" => {
            format!("发布公告「{}」", row["announcement_title"].as_str().unwrap_or(""))
        }
        "update_announcement" => {
            let title = row["announcement_title"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改公告「{}」", title)
            } else {
                format!("修改公告「{}」：{}", title, change)
            }
        }
        "delete_announcement" => {
            format!("删除公告「{}」", row["announcement_title"].as_str().unwrap_or(""))
        }
        // 河灯留言人工复核（20260922 第六轮）：同族，读回执顶层 meta
        // （board_id/board_author/change）。**不带留言正文**——正文是访客写的、可能很长，
        // 而 detail 列宽 300、读侧只取最近 8 行；更关键的是正文进了跨轮执行记忆就会被
        // narrator 当作"我读过这条留言"的证据复述。指认留言只用 #id + 作者。
        "audit_board_comment" => {
            let id = row["board_id"].as_str().unwrap_or("");
            let who = row["board_author"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            let head = if who.is_empty() {
                format!("人工复核留言 #{}", id)
            } else {
                format!("人工复核留言 #{}（{} 的留言）", id, who)
            };
            if change.is_empty() {
                head
            } else {
                format!("{}：{}", head, change)
            }
        }
        "delete_board_comment" => {
            let id = row["board_id"].as_str().unwrap_or("");
            let who = row["board_author"].as_str().unwrap_or("");
            if who.is_empty() {
                format!("删除留言 #{}", id)
            } else {
                format!("删除留言 #{}（{} 的留言）", id, who)
            }
        }
        // 账号冻结/解冻（20260926）：读回执顶层 meta 的 account_name（与 op/change 同族）。
        // **不落 uid**：uid 是内部编号（审计里要的是人能核对的账号名，与 board_author 同族），
        // 而这一行会经 recent_executions 注入下一轮上下文。
        // 带上 `change`（"状态本来就是冻结，本次未发生变更"这类）：幂等/未变更的那一次
        // 若只渲染成「冻结账号「X」」，跨轮记忆里就成了一次真动作。
        // 措辞与 agent 侧 server.py _tool_action_text 的同名臂逐字一致。
        "freeze_account" | "unfreeze_account" => {
            let verb = if tool == "freeze_account" { "冻结" } else { "解冻" };
            let name = row["account_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("{}账号「{}」", verb, name)
            } else {
                format!("{}账号「{}」：{}", verb, name, change)
            }
        }
        // 给单个账号发通知（20260926）：与冻结族同一条纪律——读回执顶层 meta 的
        // account_name，**不落 uid**（那一行会经 recent_executions 注入下一轮上下文，
        // 要的是人能核对的账号名），也**不落正文**（正文是主人刚在确认卡上核对过的那段话，
        // 回执里再抄一遍会让卡片上面的字和下面的字看起来是两件事；正文要复述时，
        // agent 回执文本本身已经带了节选）。
        // 措辞与 agent 侧 server.py _tool_action_text 的同名臂逐字一致。
        "send_user_notice" => {
            let name = row["account_name"].as_str().unwrap_or("");
            if name.is_empty() {
                "给账号发通知".to_string()
            } else {
                format!("给账号「{}」发通知", name)
            }
        }
        // 后台首页待办 / 日程（20260926 补臂）：读一件 + 写一件。**从 args 渲染**——
        // 回执顶层 meta 里没有 text/date（那是 agent 侧 `_RCPT_META_KEYS` 的白名单，
        // 不必为这两条给所有回执多开两个口子），而 args 由 agent 侧 str() 落盘、上限
        // 200 字，本行下游还有 300 字的列宽截断。
        // 写的那件带正文：它是这条待办**唯一的指认方式**（没有标题也没有 id），与标签/
        // 公告那种"能靠名字指认、正文只是内容"的情况不同——所以这里不按"不带正文"处理。
        // 措辞与 agent 侧 server.py _tool_action_text 的同名臂一致（那边按 24 字截断，
        // 分工同 device_oled_display）。
        "list_dashboard_todos" => "查看待办列表".to_string(),
        "create_dashboard_todo" => {
            let text = arg("text");
            let date = arg("date");
            if text.is_empty() {
                "添加待办".to_string()
            } else if date.is_empty() {
                format!("添加待办「{}」", text)
            } else {
                format!("添加待办「{}」（{}）", text, date)
            }
        }
        // 勾完成（20260926 第十轮）：正文是这一行**唯一的指认方式**（待办没有标题也
        // 没有 id），所以必须带上——同 create_dashboard_todo 那条注。**不写「已完成」**：
        // 这一行会经 recent_executions 注入下一轮，而后端在"本来就是完成"那次是真 no-op
        // （agent 侧回执用 meta 的 before/after 区分，不在这一行的措辞里）。
        // 措辞与 agent 侧 server.py _tool_action_text 的同名臂逐字一致。
        "complete_dashboard_todo" => {
            let text = arg("text");
            if text.is_empty() {
                "勾完成待办".to_string()
            } else {
                format!("把待办「{}」勾成完成", text)
            }
        }
        // 用户自己的数据（20260923）：**读三个 + 写三个**。读的措辞与 agent 侧
        // server.py _NOARG_VERB 同源——漏了会落默认分支，把 `操作记录(list_my_favorites)`
        // 这种带下划线的内部工具名写进 execution_log 被下一轮 narrator 照抄。
        "list_my_favorites" => "查看我的收藏".to_string(),
        "get_unread_summary" => "查看未读汇总".to_string(),
        "list_notifications" => "查看站内通知".to_string(),
        // 站内信（私信，20260923 批 8）：与「站内通知」是两回事（通知是系统推的、
        // 信是一对一写的），措辞必须分开——回执行会经 recent_executions 注入下一轮，
        // 把两者写成同一个词，planner 就会拿通知的 id 去标记信（反之亦然）。
        "list_my_messages" => "查看站内信".to_string(),
        // 写三件（scope=write.own）：走真写路径时**回执不带 meta**——AUDIT_SCOPES 只含
        // write.console（test_authz 精确锁着），所以那种行只能从 args 渲染。args 一律是
        // 字符串（见 py_int_list 的头注：`all` 的 bool 过来是 Python repr 的 "True"）。
        // 收藏行**刻意不带《标题》**：同上面那句纪律（会经 recent_executions 注入
        // 下一轮，被读成"我读过这篇"的跨轮指代证据）。
        // 措辞与 agent 侧 server.py _tool_action_text 的同名臂**逐字一致**：预告帧
        // 与落库回执行是同一件事的两处渲染，不一致会让主人以为发生了两件事。
        //
        // **工具短路那次改读 `change`（20260926）**：这四件在工具层有幂等短路——目标
        // 状态本来就已经是它要的样子时**不发写请求**（agent 侧 `tools/base.py`），回执带
        // `noop: True` + `change`；`graph.py` 的 meta 闸**只在这种短路回执上**放行
        // `change` 这一个键（真写路径一个字都不放，所以这里的 `change.is_empty()`
        // 分支在走真写时**必然**成立）。短路那种行的动作词必须整个不出现：它会经
        // recent_executions 注回下一轮上下文，写「收藏文章 12」就是在说"我动过你的
        // 收藏"——主人问"你刚才动过我收藏吗"，planner 看到的正是这一行。
        // 对象（哪一篇/哪几条）要留着，动作词丢掉。
        "add_favorite" | "remove_favorite" => {
            let id = arg("article_id");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                if tool == "add_favorite" {
                    format!("收藏文章 {}", id)
                } else {
                    format!("取消收藏文章 {}", id)
                }
            } else {
                // 「文章 12 本来已收藏（未改动）」
                format!("文章 {} {}（未改动）", id, change)
            }
        }
        "read_notifications" => {
            let change = row["change"].as_str().unwrap_or("");
            if !change.is_empty() {
                // 「站内通知本来就没有未读的（未改动）」——同上面那条：动作词不出现。
                format!("站内通知{}（未改动）", change)
            } else {
                let want_all = matches!(arg("all").as_str(), "True" | "true" | "1");
                if want_all {
                    "标记站内通知已读（全部未读）".to_string()
                } else {
                    let ids = py_int_list(&arg("ids"));
                    match ids.len() {
                        0 => "标记站内通知已读".to_string(),
                        n if n > 3 => format!("标记站内通知已读（{} 等 {} 条）",
                                              ids[..3].join("、"), n),
                        _ => format!("标记站内通知已读（{}）", ids.join("、")),
                    }
                }
            }
        }
        "read_messages" => {
            let change = row["change"].as_str().unwrap_or("");
            if !change.is_empty() {
                // 「站内信本来就读过（未改动）」
                format!("站内信{}（未改动）", change)
            } else {
                let want_all = matches!(arg("all").as_str(), "True" | "true" | "1");
                if want_all {
                    "标记站内信已读（全部未读）".to_string()
                } else {
                    let ids = py_int_list(&arg("ids"));
                    match ids.len() {
                        0 => "标记站内信已读".to_string(),
                        n if n > 3 => format!("标记站内信已读（{} 等 {} 条）",
                                              ids[..3].join("、"), n),
                        _ => format!("标记站内信已读（{}）", ids.join("、")),
                    }
                }
            }
        }
        "set_article_status_batch" => format!("批量修改文章状态：{}", row.get("result").and_then(|value| value.as_str()).unwrap_or("批量操作已回执")),
        "set_article_status" => format!("修改文章 {}：{}", arg("article_id"), arrow(row)),
        "set_article_tags" => format!("修改文章 {} 标签：{}", arg("article_id"), arrow(row)),
        _ => format!("操作记录({})", tool),
    };
    // 写操作带执行身份前缀（20260921 第二轮）：非写回执没有 principal_role，
    // actor_prefix 返回空串，行为与改动前逐字节一致。
    let detail = format!("{}{}", actor_prefix(row), detail);
    let detail = detail.replace('[', "「").replace(']', "」");
    // 实体摘要（20260920，agent/entities.py 产）：数据工具取回的条目/计数/候选标题，
    // 随回执落库——工具帧只活当轮，不落这一行则下轮「第二条写了什么」只能把工具再跑
    // 一遍（探针实测）。agent 只搬事实、Rust 只做拼接（语义渲染仍在数据所在的一侧）。
    // 有摘要时上限放宽到列宽（varchar(300)），无摘要保持 120 不变。
    let digest = row["digest"].as_str().unwrap_or("");
    if digest.is_empty() {
        detail.chars().take(120).collect()
    } else {
        format!("{} — {}", detail, digest).chars().take(300).collect()
    }
}

// ── 跨轮待办（20260923；表与语义见 entity/pending_action.rs 与迁移文件头注）────
/// 读侧时效：超过这个时长的 pending 行不再注入 planner（确认令牌自身 10 分钟
/// 即失效，更旧的行只会让下一轮把一件早凉的事重新规划一遍）。
const PENDING_READ_TTL_MINUTES: i64 = 60;
/// 注入行里工具参数最多带多少字符：planner 要靠它原样重建动作，但一行不该被
/// 一个长参数撑爆。
const PENDING_ARGS_INLINE_MAX: usize = 200;
/// 注入行整体上限（与 recent_executions 同一量级）。
const PENDING_INLINE_MAX: usize = 600;
/// Complete proposal JSON and display text are rejected above these bounds, never truncated.
const PENDING_ARGS_COL_MAX: usize = 32_768;
const PENDING_QUESTION_COL_MAX: usize = 32_768;
/// Legacy choice lists and native confirmation/cancellation buttons share this bound.
const PENDING_OPTIONS_COL_MAX: usize = 600;

/// 待办行 → 注入 planner 的那一行：主人看得懂的目标（写时定稿的 target）＋
/// 重建动作需要的工具与参数＋时间与状态。**参数在这里给出是刻意的**——短应答/
/// 授权式轮次要原样重建同一件事，而不是回历史里挑一句自然语言当目标
/// （20260923 13:19 事故：模型上一轮的提议指向早已通过的留言，系统账上真正
/// 待审的是另一条）。前缀的定性同 recent_executions：这是泠月自己提出的事，
/// 不是访客的浏览痕迹。
fn render_pending_action(r: &pending_action::Model) -> String {
    let mut s = r.target.clone();
    if !r.tool.is_empty() {
        s.push_str(&format!("；动作 {}", r.tool));
    }
    if !r.skill.is_empty() {
        s.push_str(&format!("（技能 {}）", r.skill));
    }
    if let Some(a) = r.args.as_deref().filter(|a| !a.is_empty()) {
        s.push_str(&format!(
            "；参数 {}",
            a.chars().take(PENDING_ARGS_INLINE_MAX).collect::<String>()
        ));
    }
    s.push_str(&format!(
        "；提出于 {}；状态 awaiting（等主人点头，尚未执行）",
        r.created_at.format("%m-%d %H:%M")
    ));
    s.chars().take(PENDING_INLINE_MAX).collect()
}

/// 取 JSON 字段并限长（缺字段/类型不对一律空串——待办是辅助事实，宁可少说）。
fn json_capped(v: &serde_json::Value, key: &str, cap: usize) -> String {
    v[key].as_str().unwrap_or("").chars().take(cap).collect()
}

// ── 会话级任务状态（20260927；表与语义见 entity/agent_task.rs 与迁移文件头注）────
/// **未完结状态**（六态里的三态）——读侧查询过滤的唯一来源。写侧不判状态（状态由
/// agent 声明，Rust 只存）；这里只有一个消费者，所以不另造 `is_open(state)` 包装。
const TASK_OPEN_STATES: [&str; 3] = ["submitted", "running", "input_required"];
// 「同一次注入最多列几条未完结任务」这一格**20261013 起不在这里**（原先有个
// `TASK_INLINE_MAX = 3`，与 execution_log 的读侧去重同一条纪律）。
//
// 挪走的理由是一次实证事故（会话 347，`logs/agent/traces/20261013/` 23:07–23:10）：
// 读侧按"最新 3 条"截断，而**回执结算与"下一件做什么"两条判据读的就是读回来的这份
// 列表**（agent 侧 `tasks.rows_to_settle` / `graph._ledger_next`）——于是排序第 4 位
// 往后的未完结行**结构上结不了账**（`advance_by_receipts` 拿不到它），却会在前面几行
// 结算掉、窗口往前挪之后**复活成"台账里剩下的那件"**。当晚现场：09:52 那次登记的两行
// 「以你的口吻通知他」（一行措辞长、一行是主人原话的切片）分别落在窗口内外，站内通知
// 发出去的那一轮只结算了窗口里那行，另一行 4 分钟后被当成"下一件"重做了一遍
// ——**同一条通知发了两遍**（发出后没有撤回通道）。
//
// 治法：**读侧给全集，裁剪只留在渲染那一步**。列几行给模型看是提示词尺寸的事，
// 口径在 agent 侧（`config/settings.py` 的 `agent_task_inject_max`，由
// `tasks.render_open_tasks` 施加）——两处都限就会让"结算射程"跟着提示词尺寸走，
// 那正是这次事故的形状。
//
// 注意**改这里不改 graph 臂的提示词**：`render_open_tasks` 仍按最新优先取前 N 行，
// 而下面的排序是 `order_by_desc(Id)`，所以注入的文本逐字节不变（只是它挑的那 3 行
// 现在是从全集里挑的，不再是"碰巧被 SQL 留下的那 3 行"）。
/// 读侧时效：超过这个时长的未完结任务不再注入（72 小时）。
/// 与 `pending_action` 的 60 分钟刻意不同：那件事的凭据（确认令牌）10 分钟就失效，
/// 而任务存在的理由正是"别把主人要的事忘了"——它必须比一轮对话活得久。但无限期挂着
/// 同样有害（三天前没做完的事突然被翻出来重问，比忘掉更糟），所以给一个宽但有限的口子。
const TASK_READ_TTL_HOURS: i64 = 72;
/// `goal` / `pending_question` 列上限（= 迁移里的 varchar(300)）
/// `steps` 列上限（审计线索，非执行依据；超出只存前缀，绝不为了"看起来是合法 JSON"
/// 去改写内容——解不出来时读侧会如实给 Null）
///
/// **20261012 从 4000 上调到 16000**：agent 侧的步骤从"只有工具名"扩成
/// `{label,tool,skill,args}`（参数落库，见 `agent/tasks.py` 的同名常量），4000 字符
/// 已经不够八步带实参的计划。两处常量**必须同值**——它是跨语言的契约，只改一边就是
/// 一边在截、一边以为没截（Python 侧 `tasks.certify_steps` 按同一个数自证）。
///
/// 16000 是**算出来的、不是拍的**：`steps` 是 MySQL `text`＝65535 **字节**，而
/// `.chars().take()` 数的是**字符**。utf8mb4 下 1 字符 ≤ 4 字节 ⇒
/// 16000 × 4 = 64000 < 65535，最坏情况下也顶不到列宽（超过列宽在严格模式下是
/// 1406，那一行会整个落不进去）。再往上调之前，先把这条不等式重算一遍。
/// 幂等键列上限（= 迁移里的 varchar(80)）

/// 任务落库（20260927）：agent 在 planner 认定"这一轮做不完"时随 `__TASK__` 发来的
/// 结构化声明。**按 `task_id` upsert，不做"新的顶掉旧的"**——这是与 `pending_action`
/// 最大的行为差异，也是分表的理由：那张表装"最新那次提议"（主人心里只有一件事），
/// 这张表装**可以同时存在的多件事**（跨技能排队正是靠这一点）。
/// `let _ =` 吞错，与 execution_log / pending_action 同口径：辅助事实，落库失败不阻断
/// 对话主链路（下一轮少一条线索，而不是这一轮报错）。
async fn load_agent_tasks(db: &sea_orm::DatabaseConnection, conversation_id: i32) -> String {
    let cutoff =
        chrono::Local::now().naive_local() - chrono::Duration::hours(TASK_READ_TTL_HOURS);
    let rows = agent_task::Entity::find()
        .filter(agent_task::Column::ConversationId.eq(conversation_id))
        .filter(agent_task::Column::CreatedAt.gte(cutoff))
        // 终态过滤**在查询里**（不是取回来再筛）：先取再筛会让几条已完结的任务把
        // 注入的行挤掉，注入的行数变少且没人看得出来为什么
        .filter(agent_task::Column::State.is_in(TASK_OPEN_STATES))
        .order_by_desc(agent_task::Column::Id)
        // **这里没有 `.limit(...)` 是刻意的，别加回来**（20261013，理由见
        // `TASK_OPEN_STATES` 上方那段）：这一份列表同时是**注入文本的来源**与
        // **结算／"下一件做什么"两条判据的射程**，给它加窗口就等于让"哪几件事结得
        // 掉账"跟着提示词尺寸走。列几行给模型看由 agent 侧 `render_open_tasks` 决定
        // （最新优先取前 N 行），与这里取全集是两件事。
        .all(db)
        .await
        .unwrap_or_default();
    let out: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "task_id": r.task_id,
                "goal": r.goal,
                "state": r.state,
                "total_steps": r.total_steps,
                "cursor": r.cursor,
                "pending_question": r.pending_question,
                // 解不出来给 Null（"这份计划读不出来了"），**不编一个空数组**——
                // 空数组的意思是"没有剩余步骤"，那是另一件事（做完了 vs 读不出来）
                "steps": r
                    .steps
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .unwrap_or(serde_json::Value::Null),
                "created_at": r.created_at.format("%m-%d %H:%M").to_string(),
            })
        })
        .collect();
    serde_json::Value::Array(out).to_string()
}

fn agent_chat_url() -> String {
    std::env::var("AGENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8010/chat".to_string())
}

pub async fn chat_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Response {
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        // 404/200 错误按原样透传（含 conversation_not_found 与合规文案等）
        Err(e) => return e.into_response(),
    };

    let agent_url = agent_chat_url();
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, "chat: 转发 agent 非流式");
    // 传输层偶发失败（agent worker 重启、瞬时断连等）自动重试最多 3 次，
    // 避免对话偶发 "connection closed before message completed" 报错。
    // 超时不重试：长回答（公式推导等）单次生成可长达 180s，超时重试只会从头再生成一遍
    let mut resp_opt: Option<reqwest::Response> = None;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match reqwest::Client::new().post(&agent_url)
            // 身份断言：agent 验签后据此覆盖请求体里的 user_id（见 auth_jwt.rs）
            .header("X-Agent-Assertion", crate::auth_jwt::create_agent_assertion(ctx.uid, ctx.role.as_deref()))
            .header("X-Request-ID", &ctx.trace_id)
            .json(&ctx.body)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await {
            Ok(r) => { resp_opt = Some(r); break; }
            Err(e) => {
                last_err = e.to_string();
                if e.is_timeout() { break; } // 超时说明生成确实很慢，重试无意义
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                }
            }
        }
    }

    match resp_opt {
        Some(r) => {
            if r.status().is_success() {
                let data: serde_json::Value = r.json().await.unwrap_or_default();
                let exec_rows = data["executions"].as_array().cloned().unwrap_or_default();
                if ctx.uid > 0 && !exec_rows.is_empty() {
                    let state = state.clone();
                    let (uid, cid) = (ctx.uid, ctx.conversation_id);
                    if persistence::run(&ctx.trace_id, async move {
                        save_execution_log(&state.db, uid, cid, &exec_rows).await
                    }).await.is_err() {
                        return Json(ChatResponse { reply: String::new(), success: false,
                            error: Some(PERSISTENCE_ERROR.into()) }).into_response();
                    }
                }
                match agent_reply_of(&data) {
                    Ok(reply) => {
                        if ctx.uid > 0 {
                            let state = state.clone();
                            let saved_reply = reply.clone();
                            if persistence::run(&ctx.trace_id, async move {
                                save_assistant_reply(&state.db, ctx.uid, ctx.conversation_id,
                                    ctx.role, saved_reply).await
                            }).await.is_err() {
                                return Json(ChatResponse { reply, success: false,
                                    error: Some(PERSISTENCE_ERROR.into()) }).into_response();
                            }
                        }
                        Json(ChatResponse { reply, success: true, error: None }).into_response()
                    }
                    Err(msg) => {
                        warn!(trace_id = %ctx.trace_id, "chat: agent did not complete a reply: {}", msg);
                        Json(ChatResponse {
                            reply: String::new(),
                            success: false,
                            error: Some(format!("Agent error: {}", msg)),
                        }).into_response()
                    }
                }
            } else {
                Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent error: {}", r.status())) }).into_response()
            }
        }
        None => {
            Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent unavailable: {}", last_err)) }).into_response()
        }
    }
}


/// agent 非流式响应体 → 这一轮的回复文本；**没生成出回复**时给 Err(原因)。
///
/// 曾经这里是 `data["reply"].as_str().unwrap_or("")` —— 只看 HTTP 状态码，HTTP 200
/// 就当作成功并把 reply 落库。于是 agent 内部异常（它自己回的是
/// `{"reply": "", "success": false, "error": "..."}`，HTTP 仍是 200）在这条路上变成
/// **一条空的 assistant 消息**：主人看到的是一片空白，历史里多了一行空回复，而
/// `error` 字段没有任何人读过。这与 20260927 那条 SSE 事故同族（异常被吞成"正常但空"），
/// 只是走的是另一条通道 —— 判据因此也放在这里：**这一轮到底有没有生成出回复**，
/// 由三个事实按序回答（agent 自报的 `success` / 回复是否为空 / 字段在不在），
/// 而不是由 HTTP 状态码代答。
///
/// 三态（`success` 字段**在不在**是有信息的一态）：
///   · `success: false` → Err（用它自报的 `error`，agent 侧已不再下发内部异常原文）；
///   · `success` 缺失 → 按回复非空判（兼容不带这个字段的旧版 agent）；
///   · 回复只有空白 → Err（**空回复不算成功**，见上）。
fn agent_reply_of(data: &serde_json::Value) -> Result<String, String> {
    let reply = data["reply"].as_str().unwrap_or("").trim().to_string();
    match data.get("success").and_then(|v| v.as_bool()) {
        Some(false) => Err(data["error"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("agent 报告这一轮没能生成回复（未给出原因）")
            .to_string()),
        _ if reply.is_empty() => Err("agent 返回了空回复".to_string()),
        _ => Ok(reply),
    }
}

/// Preserve business status codes and emit all other early outcomes as named SSE.
fn early_exit_response(status: StatusCode, body: ChatResponse, from: &str) -> Response {
    if status == StatusCode::NOT_FOUND || status == StatusCode::CONFLICT {
        return (status, Json(body)).into_response();
    }
    info!(stage = from, status = %status, "chat: early stream outcome");
    let events = if body.success && !body.reply.is_empty() {
        vec![stream_event("text", body.reply), stream_event("done", serde_json::json!({}))]
    } else {
        let message = body.error.filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "服务暂时不可用，这一轮没有生成回复，请稍后再试。".to_string());
        vec![stream_event("error", message)]
    };
    let stream = futures::stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
    ([(header::HeaderName::from_static("x-accel-buffering"), "no"),
      (header::HeaderName::from_static("x-agent-stream-version"), "2")],
     Sse::new(stream)).into_response()
}

pub async fn chat_stream_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Response {
    // Reject cached v1 clients before creating messages or consuming confirmation grants.
    if req.headers().get("x-agent-stream-version").and_then(|v| v.to_str().ok()) != Some("2") {
        return (StatusCode::CONFLICT, Json(ChatResponse {
            reply: String::new(), success: false,
            error: Some("聊天版本已更新，请刷新页面后重试。".to_string()),
        })).into_response();
    }
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        // 早退一律转成 SSE 帧（见 early_exit_response 的头注）：这里原本是
        // `e.into_response()`，会把 200 + JSON 原样吐给一个只认 SSE 的客户端
        Err((status, Json(body))) => return early_exit_response(status, body, "prepare_chat"),
    };

    let stream_url = agent_chat_url().strip_suffix("/chat").unwrap_or("").to_string() + "/chat/stream/v2";
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, "chat: 转发 agent 流式");
    // 流式连接不设整体超时（长回答可达数分钟），connect/首字节由 reqwest 默认处理
    let upstream = match reqwest::Client::new()
        .post(&stream_url)
        // 身份断言（同上）：流式这条路同样要带，否则 agent 打开强制校验后它会 401
        .header("X-Agent-Assertion", crate::auth_jwt::create_agent_assertion(ctx.uid, ctx.role.as_deref()))
        .header("X-Request-ID", &ctx.trace_id)
        .json(&ctx.body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => {
            return early_exit_response(
                StatusCode::OK,
                ChatResponse {
                    reply: String::new(),
                    success: false,
                    // 这句话现在**会显示给用户**（此前只进 JSON body，客户端不解析）⇒
                    // 说人话，不把 reqwest 的英文错误串摆给用户；细节留在上一条 WARN 里
                    error: Some(format!("服务这边暂时联系不上（{}），这一轮没有生成回复，请稍后再说一次。", e)),
                },
                "agent_connect",
            );
        }
    };
    if !upstream.status().is_success() {
        return early_exit_response(
            StatusCode::OK,
            ChatResponse {
                reply: String::new(),
                success: false,
                error: Some(format!(
                    "服务这边出了点问题（上游 {}），这一轮没有生成回复，请稍后再说一次。",
                    upstream.status().as_u16()
                )),
            },
            "agent_status",
        );
    }

    let state = state.clone();
    let uid = ctx.uid;
    let conversation_id = ctx.conversation_id;
    // 帧循环里的告警要用（stream! 生成器闭包不能借用 ctx——它后面还要用 ctx 写响应头）
    let trace_id = ctx.trace_id.clone();

    let body_stream = forward_agent_stream(state, uid, conversation_id, ctx.role, trace_id, upstream.bytes_stream());

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONNECTION, "keep-alive"),
            // 关键：告知 nginx 不要缓冲此响应，否则 SSE 会被攒到结束才一次性下发
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
            // 链路追踪：透传 trace id 给前端（前端可在网络面板按此 id 关联全链路日志）
            (header::HeaderName::from_static("x-request-id"), &ctx.trace_id),
        ],
        Sse::new(body_stream),
    ).into_response()
}

/// 流生命周期内只持有本轮未完成正文；取消时丢弃内存，不删数据库行。
fn forward_agent_stream(
    state: Arc<AppState>,
    uid: i32,
    conversation_id: i32,
    source_role: Option<String>,
    trace_id: String,
    upstream_stream: impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> impl futures::Stream<Item = Result<axum::response::sse::Event, axum::Error>> + Send {
    stream! {
        let upstream = upstream_stream.eventsource();
        futures::pin_mut!(upstream);
        let mut reply = String::new();
        let mut terminal = false;
        while let Some(incoming) = upstream.next().await {
            let incoming = match incoming {
                Ok(value) => value,
                Err(_) => break,
            };
            let frame = match protocol::decode(&incoming) {
                Ok(frame) => frame,
                Err(_) => {
                    warn!(trace_id = %trace_id, user_id = uid, "chat: invalid upstream SSE event");
                    break;
                }
            };
            match frame {
                Frame::Done(_) => {
                    terminal = true;
                    if uid > 0 && !reply.is_empty() {
                        let state = state.clone();
                        if persistence::run(&trace_id, async move {
                            save_assistant_reply(&state.db, uid, conversation_id, source_role, reply).await
                        }).await.is_err() {
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                    break;
                }
                Frame::Error(_) => {
                    terminal = true;
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                    break;
                }
                Frame::Receipts(rows) => {
                    if uid > 0 && !rows.is_empty() {
                        let state = state.clone();
                        if persistence::run(&trace_id, async move {
                            save_execution_log(&state.db, uid, conversation_id, &rows).await
                        }).await.is_err() {
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Pending(value) => {
                    if uid > 0 {
                        let state = state.clone();
                        if persistence::run(&trace_id, async move {
                            if pending::save_pending_action(&state.db, uid, conversation_id, &value.into()).await {
                                Ok(())
                            } else {
                                Err(sea_orm::DbErr::Custom("pending state was not saved".into()))
                            }
                        }).await.is_err() {
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Text(text) => {
                    reply.push_str(&text);
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                }
                Frame::TaskInput(value) => {
                    match task_inputs::persist_event(&state.db, uid, conversation_id,
                        source_role.as_deref().unwrap_or(""), value).await {
                        Ok(value) => yield Ok(stream_event("task_input", value)),
                        Err(error) => {
                            warn!(%error, "task input stream persistence failed");
                            terminal = true;
                            yield Ok(stream_event("error", PERSISTENCE_ERROR));
                            break;
                        }
                    }
                }
                Frame::Progress(_) | Frame::Confirmation(_) | Frame::Command(_) => {
                    yield Ok(axum::response::sse::Event::default().event(incoming.event).data(incoming.data));
                }
            }
        }
        if !terminal {
            yield Ok::<_, axum::Error>(stream_event("error", "与 Agent 的连接中断，回复可能不完整"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn cancelling_stream_does_not_delete_any_persisted_turn() {
        let state = Arc::new(AppState {
            db: sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres).into_connection(),
            rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
            post_limiter: crate::risk::PostRateLimiter::new(),
            report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
        });
        let upstream = futures::stream::once(async {
            Ok(Bytes::from_static(b"event: text\ndata: \"partial reply\"\n\n"))
        }).chain(futures::stream::pending());
        let mut response = Box::pin(forward_agent_stream(state.clone(), 7, 42, Some("user".into()), "cancel-test".into(), upstream));
        assert!(response.next().await.unwrap().is_ok());
        drop(response);
        tokio::task::yield_now().await;
        let state = Arc::try_unwrap(state).ok().expect("取消后没有数据库清理任务持有状态");
        assert!(state.db.into_transaction_log().is_empty(), "取消不能发出任何范围删除");
    }

    #[tokio::test]
    async fn over_budget_history_images_are_not_loaded_from_database() {
        use std::collections::BTreeMap;
        let metadata: BTreeMap<&str, sea_orm::Value> = BTreeMap::from([
            ("id", 99.into()), ("message_id", 42.into()),
            ("bytes", ((CHAT_HISTORY_IMAGE_BUDGET + 1) as i32).into()),
        ]);
        let db = sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres)
            .append_query_results([vec![metadata]]).into_connection();
        let recent = vec![chat_history::Model {
            id: 42, user_id: 7, conversation_id: 1, role: "user".into(), source_role: Some("user".into()),
            content: "image".into(), created_at: chrono::Local::now().naive_local(),
        }];
        let images = load_history_images(&db, &recent).await.unwrap();
        assert!(images.is_empty());
        let log = db.into_transaction_log();
        assert_eq!(log.len(), 1, "超预算只查元数据，不发第二条大字段查询");
        let query = format!("{:?}", log[0]);
        assert!(query.contains("octet_length"));
    }

    /// 历史图片的字节预算（20261018）。**为什么值得有这条判据**：`CHAT_HISTORY_IMAGE_BUDGET`
    /// 是一个"正常用法永远碰不到"的安全阀 —— 没有判据钉着，它会在某次重构里被顺手删掉
    /// 或改成 `>=`，而**没有任何东西会红**（线上要等某个用户攒够几十 MB 图才发现）。
    /// 输入按 `(id, 字节)` **从新到旧**给（与 `chat_history_handler` 里 `recent` 的顺序一致）。
    #[test]
    fn image_budget_fills_newest_first_and_cuts_the_rest() {
        let mb = 1024 * 1024;
        // 新→旧：3MB + 3MB 装得下；第 3 条 3MB 会越界 ⇒ 它**和更早的**都不给图
        let got = fit_image_budget(&[(30, 3 * mb), (20, 3 * mb), (10, 3 * mb), (5, 1 * mb)]);
        assert!(got.contains(&30) && got.contains(&20), "预算内的必须带上");
        assert!(!got.contains(&10), "越界的那条不给图（不是残缺数组）");
        assert!(!got.contains(&5), "比越界那条更早的也不给 —— 装填是从新到旧的单向过程");
    }

    /// 边界：恰好等于预算**算装得下**（`>` 不是 `>=`）。这条钉的是"安全阀不要早咬一口"。
    #[test]
    fn image_budget_boundary_is_inclusive() {
        let mb = 1024 * 1024;
        let got = fit_image_budget(&[(1, 4 * mb), (2, 4 * mb)]);
        assert_eq!(got.len(), 2, "4+4 == 8MiB 恰好等于预算 ⇒ 两条都带");
        let got = fit_image_budget(&[(1, 4 * mb), (2, 4 * mb + 1)]);
        assert!(!got.contains(&2), "多 1 字节就越界");
    }

    /// 没图的消息（0 字节）**不占预算、也不中断装填** —— 否则"中间夹着一条纯文本"
    /// 会把更早的图全部误杀（这是最容易写错的一种：把 0 当成"装不下"）。
    #[test]
    fn image_budget_skips_imageless_without_breaking_the_fill() {
        let mb = 1024 * 1024;
        let got = fit_image_budget(&[(3, 4 * mb), (2, 0), (1, 4 * mb)]);
        assert_eq!(got, [1, 3].into_iter().collect(), "0 字节那条跳过，后面的照装");
    }

    /// agent 自报 `success: false`（HTTP 仍是 200）⇒ 必须**判失败**，且把它的原话当原因。
    /// 事故形状：这条路上曾经只看 HTTP 状态码，于是内部异常被吞成"一次成功但空回复"，
    /// 那种轮次会往 chat_history 落一行空的 assistant 消息。
    #[test]
    fn agent_reply_rejects_reported_failure() {
        let body = json!({"reply": "", "success": false,
                          "error": "服务这边出了点问题，这一轮没能生成回复，请再说一次。"});
        let err = agent_reply_of(&body).unwrap_err();
        assert_eq!(err, "服务这边出了点问题，这一轮没能生成回复，请再说一次。");
    }

    /// `success: false` 但没给原因（旧版 agent / 字段为空串）⇒ 也要判失败，
    /// 用一句兜底说明，而不是回落成"成功"。
    #[test]
    fn agent_reply_reported_failure_without_reason() {
        assert!(agent_reply_of(&json!({"reply": "x", "success": false})).is_err());
        assert!(agent_reply_of(&json!({"reply": "x", "success": false, "error": "  "})).is_err());
    }

    /// **空回复不算成功**（哪怕 agent 说 success:true）：落库那一格前面必须有这道闸。
    #[test]
    fn agent_reply_rejects_empty_reply() {
        assert!(agent_reply_of(&json!({"reply": "", "success": true})).is_err());
        assert!(agent_reply_of(&json!({"reply": "   \n", "success": true})).is_err());
        assert!(agent_reply_of(&json!({"success": true})).is_err());
    }

    /// `success` 字段**缺失**时按"回复非空"判（兼容不带这个字段的旧版 agent）；
    /// 正常回复原样返回，并去掉首尾空白。
    #[test]
    fn agent_reply_accepts_plain_reply() {
        assert_eq!(agent_reply_of(&json!({"reply": "喵呜～"})).unwrap(), "喵呜～");
        assert_eq!(agent_reply_of(&json!({"reply": " 喵呜～ ", "success": true})).unwrap(), "喵呜～");
    }

    /// 措辞的**唯一实现** 20260928 搬到了 Python（回执顶层 `action`）⇒ 这一层的接线
    /// 判据只有一条：**认得 `action` 就用它**，并把它交给下面那四件排版（身份前缀 /
    /// 方括号归一 / 摘要拼接 / 列宽截断）。不接线的后果是"两边测试都绿、线上一个字
    /// 都没变"——Python 那半把措辞定稿了、这一半还在照老表渲染。
    #[test]
    fn exec_row_prefers_python_action() {
        let row = json!({
            "tool": "create_tag",
            "args": {"title": "大笨狗"},
            // 老表会把这条渲染成「新建一级标签「」」（level 缺失时按一级、tag_name 空）
            "op": "tag_create", "level": "1", "tag_name": "",
            "action": "新建一级标签「大笨狗」",
        });
        assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");

        // 空串 = Python 侧"这一件我没收敛"（无臂工具）⇒ 回落老表，**不许**拿空串去顶。
        let row = json!({
            "tool": "create_tag",
            "args": {"title": "大笨狗"},
            "op": "tag_create", "level": "1", "tag_name": "大笨狗", "action": "",
        });
        assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");
    }

    /// `action` 是**动作句**，排版四件仍在这一侧：身份前缀贴在它前面、方括号归一、
    /// 摘要拼接、列宽截断。若有人把这四件也搬去 Python，这条会红——那是刻意的：
    /// 前缀依赖回执行里的 `principal_role`（审计语义），列宽依赖 detail 列定义。
    #[test]
    fn exec_row_still_paginates_python_action() {
        let row = json!({
            "tool": "set_article_status",
            "args": {"article_id": "12"},
            "principal_role": "admin",
            "action": "修改文章 [12]：私密 → 公开",
            "digest": "共 3 篇",
        });
        assert_eq!(render_exec_row(&row),
                   "以管理员身份 · 修改文章 「12」：私密 → 公开 — 共 3 篇");
    }

    /// create_tag 回执的 `tag_name`/`op`/`level` 全在**顶层**（agent 侧 `_RCPT_META_KEYS`），
    /// args 里只有 title/parent_id/color。曾误读 `args["tag_name"]`（该键不存在）
    /// ⇒ 生产上每次新建标签都渲染成「新建一级标签「」」。
    #[test]
    fn exec_row_create_tag_reads_toplevel_name() {
        let row = json!({
            "tool": "create_tag",
            "args": {"title": "大笨狗"},
            "op": "tag_create", "level": "1", "tag_name": "大笨狗", "tag_id": "15"
        });
        assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");
    }

    #[test]
    fn exec_row_create_tag_reuse_level2() {
        let row = json!({
            "tool": "create_tag",
            "args": {"title": "泠月喵"},
            "op": "tag_reuse", "level": "2", "tag_name": "泠月喵"
        });
        assert_eq!(render_exec_row(&row), "复用已有二级标签「泠月喵」");
    }

    /// 名字缺失（旧回执 / 提取失败）时渲染空名，但**绝不**回落去读 args["title"]
    /// 或画上内部键名——args 的 title 是"请求参数"，与"实际建成的标签名"不是一回事。
    #[test]
    fn exec_row_create_tag_missing_name_stays_empty() {
        let row = json!({"tool": "create_tag", "args": {"title": "X"},
                         "op": "tag_create", "level": "1"});
        assert_eq!(render_exec_row(&row), "新建一级标签「」");
    }

    /// 标签改/删 + 分类增删改（20260921 第三轮）：与 create_tag 同族读顶层 meta。
    /// 漏了这些分支会落进默认分支，把 `操作记录(update_tag)` 这种内部工具名写进
    /// execution_log，narrator 跨轮读到会照抄给用户。
    #[test]
    fn exec_row_tag_update_and_delete() {
        let up = json!({"tool": "update_tag", "args": {"name": "Asyncio"},
                        "op": "update_tag", "tag_name": "编程 / Asyncio", "level": "2",
                        "change": "改名叫「异步」并移到「编程」下"});
        assert_eq!(
            render_exec_row(&up),
            "修改标签「编程 / Asyncio」：改名叫「异步」并移到「编程」下"
        );
        let del = json!({"tool": "delete_tag", "args": {"name": "小猫咪"},
                         "op": "delete_tag", "tag_name": "小猫咪", "level": "1",
                         "change": "连同 3 篇文章上的引用一起摘除"});
        assert_eq!(
            render_exec_row(&del),
            "删除一级标签「小猫咪」：连同 3 篇文章上的引用一起摘除"
        );
        // change 缺失（旧回执/生成失败）时退化成不带描述的动作行，不渲染空冒号
        let bare = json!({"tool": "delete_tag", "op": "delete_tag",
                          "tag_name": "X", "level": "2"});
        assert_eq!(render_exec_row(&bare), "删除二级标签「X」");
    }

    #[test]
    fn exec_row_category_ops() {
        let c = json!({"tool": "create_category", "args": {"categoryTitle": "随笔"},
                       "op": "create_category", "category_name": "随笔"});
        assert_eq!(render_exec_row(&c), "新建分类「随笔」");
        let u = json!({"tool": "update_category", "op": "update_category",
                       "category_name": "随笔", "change": "改名为「杂记」"});
        assert_eq!(render_exec_row(&u), "修改分类「随笔」：改名为「杂记」");
        let d = json!({"tool": "delete_category", "op": "delete_category",
                       "category_name": "随笔", "change": "它有 4 篇文章，会变成没有分类"});
        assert_eq!(
            render_exec_row(&d),
            "删除分类「随笔」：它有 4 篇文章，会变成没有分类"
        );
    }

    /// 站内公告代发/改/删（20260922 第五轮）：同族，读回执**顶层 meta**
    /// （announcement_title/change）。两条纪律：① 一律带标题，否则跨轮执行记忆里
    /// 只剩「发布公告「」」这种读不懂的行；② **绝不把正文写进 detail**——正文可能有
    /// 几百字，detail 列宽 300、读侧只取最近 8 行，塞进去会把窗口占满，还会让
    /// narrator 跨轮把正文当"我说过的话"复述。
    #[test]
    fn exec_row_announcement_ops() {
        let c = json!({"tool": "create_announcement",
                       "args": {"title": "维护通知", "content": "今晚 23 点维护"},
                       "op": "announcement_create", "announcement_id": "7",
                       "announcement_title": "维护通知"});
        assert_eq!(render_exec_row(&c), "发布公告「维护通知」");
        // 改名：主语用**新**名字，change 里写的是"原「旧名」"——两边都写新名会读不出
        // 改之前叫什么（见 agent 侧 tools/base._announce_change 的注释）
        let u = json!({"tool": "update_announcement", "args": {"title": "维护通知"},
                       "op": "announcement_update", "announcement_title": "维护改期",
                       "change": "改名（原「维护通知」）"});
        assert_eq!(
            render_exec_row(&u),
            "修改公告「维护改期」：改名（原「维护通知」）"
        );
        let body = json!({"tool": "update_announcement", "args": {"title": "维护通知"},
                          "op": "announcement_update", "announcement_title": "维护通知",
                          "change": "正文已更新"});
        assert_eq!(render_exec_row(&body), "修改公告「维护通知」：正文已更新");
        // change 缺失（旧回执 / 生成失败）退化成不带描述的动作行，不渲染空冒号
        let bare = json!({"tool": "update_announcement", "op": "announcement_update",
                          "announcement_title": "维护通知"});
        assert_eq!(render_exec_row(&bare), "修改公告「维护通知」");
        let d = json!({"tool": "delete_announcement", "op": "announcement_delete",
                       "announcement_title": "维护通知"});
        assert_eq!(render_exec_row(&d), "删除公告「维护通知」");
    }

    /// 河灯留言人工复核（20260922 第六轮）：同族，读回执**顶层 meta**
    /// （board_id/board_author/change）。两条纪律与公告那条同向：
    /// ① 指认留言只能靠 #id + 作者（留言没有标题）；② **绝不把正文写进 detail**——
    /// 正文是访客写的、可能很长，进了跨轮执行记忆会被 narrator 当成"我读过这条留言"的
    /// 证据复述。change 缺失时退化成不带描述的动作行，不渲染空冒号。
    #[test]
    fn exec_row_board_moderation_ops() {
        let a = json!({"tool": "audit_board_comment",
                       "args": {"quote": "今天天气真好呀", "verdict": "reject"},
                       "op": "board_audit", "board_id": "12", "board_author": "路人甲",
                       "change": "待审 → 驳回"});
        assert_eq!(
            render_exec_row(&a),
            "人工复核留言 #12（路人甲 的留言）：待审 → 驳回"
        );
        let bare = json!({"tool": "audit_board_comment", "op": "board_audit",
                          "board_id": "12", "board_author": "路人甲"});
        assert_eq!(render_exec_row(&bare), "人工复核留言 #12（路人甲 的留言）");
        // 作者缺失（访客没填昵称）→ 只留 #id，不渲染空括号
        let anon = json!({"tool": "audit_board_comment", "op": "board_audit",
                          "board_id": "12", "change": "待审 → 通过"});
        assert_eq!(render_exec_row(&anon), "人工复核留言 #12：待审 → 通过");
        let d = json!({"tool": "delete_board_comment", "op": "board_delete",
                       "board_id": "12", "board_author": "路人甲", "change": "已删除"});
        assert_eq!(render_exec_row(&d), "删除留言 #12（路人甲 的留言）");
    }

    /// 用户自己的收藏与通知（20260923，agent 批 6/7 的父仓那一半）。回执 args 一律是
    /// **字符串**（agent 侧 `str(v)`）：列表到 Rust 是 Python 的 repr `"[7, 8]"`、布尔
    /// 是 `"True"`——这正是跨语言最容易错的地方（认不出就会静默渲染成空）。本测试锁
    /// 两件事：① 三个读臂 + 三个写臂都不落默认分支（落了就把 `操作记录(add_favorite)`
    /// 这种内部工具名写进 execution_log，narrator 跨轮读到会照抄给用户）；② 编号认不出
    /// 时宁可少说一条，也**绝不**猜一个 id 进去。
    /// 20260926 补第三件：这四个写臂在**工具短路**（目标状态本来就已经是它要的样子）
    /// 时带上 `change` ⇒ 动作词整个不出现、只留对象与现状——见本函数末尾那一组断言。
    #[test]
    fn exec_row_userdata_reads_and_writes() {
        for (tool, want) in [
            ("list_my_favorites", "查看我的收藏"),
            ("get_unread_summary", "查看未读汇总"),
            ("list_notifications", "查看站内通知"),
            // 站内信（20260923 批 8 补）：与「站内通知」是两种物件，措辞刻意不同字
            ("list_my_messages", "查看站内信"),
        ] {
            let row = json!({"tool": tool, "args": {}});
            assert_eq!(render_exec_row(&row), want);
        }
        // 写三件（scope=write.own，回执不带 meta，只能从 args 渲染）；收藏行刻意
        // 不带《标题》——带了会被下一轮读成"我读过这篇"的跨轮指代证据。
        let add = json!({"tool": "add_favorite", "args": {"article_id": "12"}});
        assert_eq!(render_exec_row(&add), "收藏文章 12");
        let del = json!({"tool": "remove_favorite", "args": {"article_id": "12"}});
        assert_eq!(render_exec_row(&del), "取消收藏文章 12");
        // 全标记：Python repr 的 "True"、JSON 的 true、字符串 "1" 都认
        for raw in ["True", "true", "1"] {
            let all = json!({"tool": "read_notifications", "args": {"all": raw}});
            assert_eq!(render_exec_row(&all), "标记站内通知已读（全部未读）");
        }
        // 按 id：>3 条折叠成「前 3 等 N 条」；认不出的串不猜编号
        let three = json!({"tool": "read_notifications",
                           "args": {"all": "False", "ids": "[7, 8, 9]"}});
        assert_eq!(render_exec_row(&three), "标记站内通知已读（7、8、9）");
        let many = json!({"tool": "read_notifications",
                          "args": {"all": "False", "ids": "[7, 8, 9, 10, 11]"}});
        assert_eq!(render_exec_row(&many), "标记站内通知已读（7、8、9 等 5 条）");
        let junk = json!({"tool": "read_notifications",
                          "args": {"all": "False", "ids": "['a', -3, '']"}});
        assert_eq!(render_exec_row(&junk), "标记站内通知已读");

        // 站内信（20260923 批 8）：同一套渲染，但名词换成「站内信」——两个词的
        // 渲染臂互为镜像，谁被删了/写错了都可从这一对断言看出来（跨轮记忆里
        // "标记了通知"与"标记了信"是两件事，混了 planner 就会拿错 id）。
        let m_all = json!({"tool": "read_messages", "args": {"all": "True"}});
        assert_eq!(render_exec_row(&m_all), "标记站内信已读（全部未读）");
        let m_ids = json!({"tool": "read_messages", "args": {"all": "False", "ids": "[3]"}});
        assert_eq!(render_exec_row(&m_ids), "标记站内信已读（3）");
        let m_many = json!({"tool": "read_messages",
                            "args": {"all": "False", "ids": "[3, 4, 5, 6]"}});
        assert_eq!(render_exec_row(&m_many), "标记站内信已读（3、4、5 等 4 条）");
        let m_empty = json!({"tool": "read_messages", "args": {"all": "False", "ids": "[]"}});
        assert_eq!(render_exec_row(&m_empty), "标记站内信已读");
        // 与通知那三行不同字（防"复制粘贴改一半"：两臂逐字相同=有一臂漏改）
        let n_all = render_exec_row(&json!({"tool": "read_notifications",
                                            "args": {"all": "True"}}));
        assert_ne!(render_exec_row(&m_all), n_all);

        // 工具短路那次（20260926）：回执带 `noop: True` + `change` ⇒ **动作词整个不
        // 出现**（这一行会经 recent_executions 注回下一轮，「收藏文章 12」在那里就是
        // "我动过你的收藏"），但**对象要留着**——否则主人问"哪一篇"时对不上号。
        let add_noop = json!({"tool": "add_favorite", "args": {"article_id": "12"},
                              "change": "本来已收藏"});
        assert_eq!(render_exec_row(&add_noop), "文章 12 本来已收藏（未改动）");
        let del_noop = json!({"tool": "remove_favorite", "args": {"article_id": "12"},
                              "change": "本来就没收藏"});
        assert_eq!(render_exec_row(&del_noop), "文章 12 本来就没收藏（未改动）");
        let n_read = json!({"tool": "read_notifications",
                            "args": {"all": "False", "ids": "[7]"}, "change": "本来就读过"});
        assert_eq!(render_exec_row(&n_read), "站内通知本来就读过（未改动）");
        let m_read = json!({"tool": "read_messages", "args": {"all": "True"},
                            "change": "本来就没有未读的"});
        assert_eq!(render_exec_row(&m_read), "站内信本来就没有未读的（未改动）");
        // 镜像的另一半：`change` 缺席或空串（旧回执、真写路径）⇒ 照旧从 args 渲染
        // 动作词——那一行的写**真的发生了**，动作词是对的。两条分支互为镜像，谁被
        // 写反了（比如把判据写成 `contains`）都能从这一对断言看出来。
        for blank in [json!({"tool": "add_favorite", "args": {"article_id": "12"},
                             "change": ""}),
                      json!({"tool": "add_favorite", "args": {"article_id": "12"}})] {
            assert_eq!(render_exec_row(&blank), "收藏文章 12");
        }
    }

    #[test]
    fn py_int_list_parses_python_repr_only() {
        assert_eq!(py_int_list("[7, 8]"), vec!["7", "8"]);
        assert_eq!(py_int_list("[ 7 ,8 ]"), vec!["7", "8"]);
        assert_eq!(py_int_list("['7', \"8\"]"), vec!["7", "8"]);
        // 空 / 非数字 / 负数一律丢掉（`-3` 里的 3 也不能混进来）
        assert_eq!(py_int_list("[]"), Vec::<String>::new());
        assert_eq!(py_int_list("['a', -3]"), Vec::<String>::new());
        assert_eq!(py_int_list(""), Vec::<String>::new());
    }

    /// 待办行的构造器（测试用：只填被测字段，其余给"空档"）。
    fn pa_model(target: &str, tool: &str, skill: &str, args: Option<&str>) -> pending_action::Model {
        pending_action::Model {
            id: 1,
            task_id: "pa_20260923_000000001".to_string(),
            conversation_id: 42,
            user_id: 7,
            skill: skill.to_string(),
            tool: tool.to_string(),
            args: args.map(|a| a.to_string()),
            target: target.to_string(),
            question: "".to_string(),
            options: "".to_string(),
            jti: "".to_string(),
            expires_at: None,
            claimed_at: None,
            requested_by: "user".to_string(),
            source_event: "confirm_popup".to_string(),
            confirmation_required: true,
            confirmation_status: "awaiting".to_string(),
            status: "pending".to_string(),
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 9, 23)
                .unwrap()
                .and_hms_opt(13, 19, 0)
                .unwrap(),
            updated_at: chrono::NaiveDate::from_ymd_opt(2026, 9, 23)
                .unwrap()
                .and_hms_opt(13, 19, 0)
                .unwrap(),
        }
    }

    /// 令牌 `jti` 的解析（20260924）：核销的键必须来自**令牌原文**——客户端另传一个
    /// 字段当认领键，就等于让调用方自己指定"我要兑现哪张令牌"。
    ///
    /// 下面那条长令牌是**合成的**（20260930）：载荷按 agent 侧 `confirm.sign` 的形状
    /// 现造（`v/uid/conv/exp/jti/skill/specs`，base64url 无填充），**签名段是假的**
    /// （`FAKE-SIG`）——它不参与解码，而这条断言要锁的只是跨语言那一层：Python 的
    /// base64url 无填充编码与这里的解码器必须对上，哪天 agent 换了编码（或加了填充）
    /// 这里会红。
    ///
    /// 原先这里贴的是**一枚真令牌**（现签的，带真实 uid/conv/jti）。它当时就已过期，
    /// 但仓库要公开 ⇒ 不该留真实签名的产物：真凭据一个字节都不进版本库。
    /// 换掉它不影响这条断言要证的事——**值与锁无关，形状才有关**。
    #[test]
    fn token_jti_reads_payload_without_verifying() {
        const SYNTHETIC: &str = "eyJ2IjoyLCJ1aWQiOjEsImNvbnYiOjEsImV4cCI6MTkwMDAwMDAwMCwianRpIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJza2lsbCI6ImZhdm9yaXRlX2FkZCIsInNwZWNzIjpbeyJ0b29sIjoiYWRkX2Zhdm9yaXRlIiwiYXJncyI6eyJhcnRpY2xlX2lkIjoxMn19XX0.FAKE-SIG";
        assert_eq!(token_jti(SYNTHETIC), "00000000000000000000000000000001");
        // 形状不对一律空串（空串 = 不核销 = 放行，见 claim_confirm_token）：
        // 没有点号 / 多一段 / 非 base64url 字符 / payload 不是 JSON / 没有 jti 字段
        assert_eq!(token_jti(""), "");
        assert_eq!(token_jti("只有一段没有点号"), "");
        assert_eq!(token_jti("a.b.c"), "");
        assert_eq!(token_jti("!!**.sig"), "");
        assert_eq!(token_jti("bm90LWpzb24.sig"), "");      // "not-json"
        assert_eq!(token_jti("eyJ2IjoxfQ.sig"), "");        // {"v":1} 旧令牌没有 jti
        // 不验签是**故意**的（认领是自伤型的，真凭据在 agent 侧）：签名段随便换一个
        // 都照样解得出 jti——这条断言把"这是解码不是验证"写死，免得将来有人误以为
        // 这里已经有了一层校验
        let tampered = format!("{}.AAAA", SYNTHETIC.split('.').next().unwrap());
        assert_eq!(token_jti(&tampered), "00000000000000000000000000000001");
    }

    #[test]
    fn b64url_decode_handles_agent_encoding() {
        // 无填充、url-safe 字母表（`-`/`_`）；带 '=' 的变体也认（容忍，不改变结果）
        assert_eq!(b64url_decode("eyJ2IjoxfQ").unwrap(), br#"{"v":1}"#.to_vec());
        assert_eq!(b64url_decode("eyJ2IjoxfQ==").unwrap(), br#"{"v":1}"#.to_vec());
        assert_eq!(b64url_decode("").unwrap(), Vec::<u8>::new());
        assert!(b64url_decode("中文").is_none());
    }

    /// 待办注入行的**定性**：这一行是"已提出、还没办"，读它的 planner 是拿它去
    /// 重发、不是拿它当执行事实。一旦渲染里丢了 `awaiting`/`尚未执行` 这两句，
    /// 模型就能把"等主人点头"读成"已经办过"（20260923 13:19 事故的反面形态）。
    #[test]
    fn pending_action_render_marks_awaiting_not_done() {
        let row = pa_model("复核留言 #94（double9）为 驳回", "board_audit_talk",
                           "board_audit", Some("[{\"tool\": \"board_audit_talk\"}]"));
        let s = render_pending_action(&row);
        assert!(s.starts_with("复核留言 #94（double9）为 驳回"), "{s}");
        assert!(s.contains("；动作 board_audit_talk"), "{s}");
        assert!(s.contains("（技能 board_audit）"), "{s}");
        assert!(s.contains("；参数 [{\"tool\": \"board_audit_talk\"}]"), "{s}");
        assert!(s.contains("；提出于 09-23 13:19"), "{s}");
        assert!(s.contains("状态 awaiting（等主人点头，尚未执行）"), "{s}");
    }

    /// 缺字段不编：工具/技能/参数为空就没有那一段（待办是辅助事实，宁可少说），
    /// 而**时效与状态**是判据本身、任何情况下都在。
    #[test]
    fn pending_action_render_omits_empty_segments() {
        let s = render_pending_action(&pa_model("把文章 12 设为私密", "", "", None));
        assert_eq!(s, "把文章 12 设为私密；提出于 09-23 13:19；状态 awaiting（等主人点头，尚未执行）");
        // 空串的 args 与 None 同待遇（DEFAULT '' 落库的行不该多出一截「；参数 」）
        let e = render_pending_action(&pa_model("x", "", "", Some("")));
        assert!(!e.contains("；参数"), "{e}");
    }

    /// 两级截断：参数在行内只留 PENDING_ARGS_INLINE_MAX 个字符（审计线索在库里是全的），
    /// 整行再夹到 PENDING_INLINE_MAX（注入进 planner 的上下文，不能撑爆）。
    #[test]
    fn pending_action_render_caps_args_and_total() {
        let long = "参".repeat(500);
        let s = render_pending_action(&pa_model(&"标".repeat(900), "t", "s", Some(&long)));
        assert!(s.chars().count() <= PENDING_INLINE_MAX, "{}", s.chars().count());
        let row = pa_model("短", "t", "s", Some(&long));
        let s2 = render_pending_action(&row);
        assert!(s2.contains(&"参".repeat(PENDING_ARGS_INLINE_MAX)), "{}", s2.chars().count());
        assert!(!s2.contains(&"参".repeat(PENDING_ARGS_INLINE_MAX + 1)));
        // 截断按**字符**不按字节（中文参数名截成半个字会落进 planner 的上下文）
        assert!(s2.contains(&format!("；参数 {}", "参".repeat(PENDING_ARGS_INLINE_MAX))));
    }

    /// `__PENDING__:` 帧的字段读取：缺字段/类型不对一律空串，绝不 panic
    /// （帧由 agent 拼、字段名是跨语言契约——认不出就少说，不能整轮报错）。
    #[test]
    fn pending_frame_json_capped_is_str_only() {
        let v = json!({"task_id": "pa_20260923_000000001", "skill": "board_audit",
                       "n": 7, "nil": null, "arr": [1, 2]});
        assert_eq!(json_capped(&v, "task_id", 64), "pa_20260923_000000001");
        assert_eq!(json_capped(&v, "skill", 4), "boar");
        assert_eq!(json_capped(&v, "missing", 64), "");
        assert_eq!(json_capped(&v, "n", 64), "");
        assert_eq!(json_capped(&v, "nil", 64), "");
        assert_eq!(json_capped(&v, "arr", 64), "");
        // 截断按字符（`chars().take()`），不是字节切片
        assert_eq!(json_capped(&json!({"t": "标签名"}), "t", 2), "标签");
    }

    async fn body_of(r: Response) -> String {
        let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn early(status: StatusCode, reply: &str, success: bool, error: Option<&str>) -> Response {
        early_exit_response(
            status,
            ChatResponse { reply: reply.into(), success, error: error.map(Into::into) },
            "test",
        )
    }

    #[tokio::test]
    async fn early_exit_is_sse_not_json() {
        let r = early(StatusCode::OK, "", false, Some("服务这边暂时联系不上"));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "text/event-stream");
        // 与正常路径同口径：不告知 nginx 就会把这唯一一帧也攒着
        assert_eq!(r.headers().get("x-accel-buffering").unwrap(), "no");
        assert_eq!(body_of(r).await, "event: error\ndata: \"服务这边暂时联系不上\"\n\n");
    }

    /// 有正文的早退（访客合规告知）：**当一条普通回复发出去**再正常终止，
    /// 而不是丢掉正文只喊一声错了——那段文案是写给访客看的全部内容。
    #[tokio::test]
    async fn early_exit_with_reply_becomes_a_normal_answer() {
        let r = early(StatusCode::OK, "尊敬的访客：…", true, None);
        let body = body_of(r).await;
        assert_eq!(body, "event: text\ndata: \"尊敬的访客：…\"\n\nevent: done\ndata: {}\n\n");
    }

    /// 没有原因（旧版/空串）也不能发出一个空载荷的 `__ERROR__` 帧——
    /// 前端会把它原样当作用户可见的一句话。
    #[tokio::test]
    async fn early_exit_never_sends_an_empty_error_frame() {
        let body = body_of(early(StatusCode::OK, "", false, Some("   "))).await;
        assert!(body.starts_with("event: error\ndata: \""), "{body}");
        assert!(body.len() > "event: error\ndata: \"\"\n\n".len(), "兜底话术不得为空：{body}");
    }

    /// **两条例外必须原地不动**：前端按状态码特判它们（还原输入 / 结算确认卡），
    /// 改成 SSE 帧等于把那两段打成死代码。
    #[tokio::test]
    async fn early_exit_keeps_status_code_exceptions_as_json() {
        for (st, code) in [
            (StatusCode::NOT_FOUND, "conversation_not_found"),
            (StatusCode::CONFLICT, "confirm_already_used"),
        ] {
            let r = early(st, "", false, Some(code));
            assert_eq!(r.status(), st);
            assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "application/json");
            assert!(body_of(r).await.contains(code));
        }
    }

    /// 载荷形态守卫：每一帧都以 `data: ` 开头、以空行分隔——**这正是前端切帧的判据**
    /// （`buf.indexOf('\n\n')`）。JSON body 一个 `\n\n` 都没有，所以旧形态必然零帧。
    #[tokio::test]
    async fn early_exit_body_is_splittable_into_sse_frames() {
        let body = body_of(early(StatusCode::OK, "半句话", true, None)).await;
        let frames: Vec<&str> = body.trim_end_matches("\n\n").split("\n\n").collect();
        assert!(!frames.is_empty());
        for f in &frames {
            assert!(f.starts_with("event: "), "帧不以 data: 开头：{f:?}");
        }
        assert_eq!(frames.last(), Some(&"event: done\ndata: {}"), "最后一帧必须是终止帧");
    }



    /// 结构那份：`payload` 原样解析成对象，`at`/`n` 照搬，顺序与 `executions` 一致
    /// （输入是新→旧，输出是旧→新）。这三格是 agent 侧取文档锚点的全部依据。
    #[test]
    fn exec_rows_json_keeps_structure_and_order() {
        let p_new = r#"{"tool":"get_article_detail","args":{"article_id":19}}"#.to_string();
        let p_old = r#"{"tool":"rag_search","args":{"query":"x"}}"#.to_string();
        let rows: Vec<ExecRow> = vec![
            ("10-20 11:03".to_string(), "读取文章 19《架构文档》", 2, Some(p_new.as_str())),
            ("10-20 10:00".to_string(), "站内检索「x」", 1, Some(p_old.as_str())),
        ];
        let out: serde_json::Value = serde_json::from_str(&exec_rows_json(&rows)).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["at"], "10-20 10:00", "输出是旧→新（与 executions 同序）");
        assert_eq!(arr[1]["n"], 2, "重复次数照搬");
        assert_eq!(arr[1]["payload"]["tool"], "get_article_detail", "payload 解析成对象");
        assert_eq!(arr[1]["payload"]["args"]["article_id"], 19);
    }

    /// 存量行（`payload` 为 NULL）与坏 payload 都是 `null` —— **不回落去解析 detail**，
    /// 也不 panic。agent 侧按"拿不到结构就不进锚点"处理（老行口径，主人拍板）。
    #[test]
    fn exec_rows_json_null_payload_stays_null() {
        let broken = "{not json".to_string();
        let rows: Vec<ExecRow> = vec![
            ("10-20 11:03".to_string(), "读取文章 19《架构文档》", 1, None),
            ("10-20 10:00".to_string(), "读取文章 20《另一篇》", 1, Some(broken.as_str())),
        ];
        let out: serde_json::Value = serde_json::from_str(&exec_rows_json(&rows)).unwrap();
        for r in out.as_array().unwrap() {
            assert!(r["payload"].is_null(), "NULL / 坏 payload ⇒ null：{r}");
        }
    }

    /// 超预算时**从最旧的一行**开始把 payload 降成 null，且结果真的回到预算内。
    /// 这条判据护的是"字段超限 = 每轮 422"那个硬边界（agent 侧 `max_length` 同值）。
    #[test]
    fn exec_rows_json_stays_within_budget_by_dropping_oldest_payloads() {
        // 每行约 3 KB（UTF-8 下 1000 个汉字 = 3000 字节）：三行超预算、降掉最旧那一行
        // 就回到预算内。**别把单行做成超过预算**——那会把最近那行也一起降掉，见下一条。
        let big = |k: char| format!(r#"{{"digest":"{}"}}"#, k.to_string().repeat(1000));
        let (p_new, p_mid, p_old) = (big('新'), big('中'), big('旧'));
        let rows: Vec<ExecRow> = vec![
            ("10-20 11:03".to_string(), "读取文章 19《架构文档》", 1, Some(p_new.as_str())),
            ("10-20 10:30".to_string(), "读取文章 18《旧文》", 1, Some(p_mid.as_str())),
            ("10-20 10:00".to_string(), "读取文章 17《更旧》", 1, Some(p_old.as_str())),
        ];
        let text = exec_rows_json(&rows);
        assert!(text.len() <= EXEC_ROWS_MAX_CHARS, "超预算就是每轮 422：{}", text.len());
        let out: serde_json::Value = serde_json::from_str(&text).unwrap();
        let arr = out.as_array().unwrap();
        assert!(arr[0]["payload"].is_null(), "最旧那行的 payload 先降");
        assert!(!arr[1]["payload"].is_null(), "只降最旧那一行就够，别多降");
        assert!(!arr[2]["payload"].is_null(), "最近那行必须保住（判据用的就是它）");
        assert_eq!(arr.len(), 3, "降的是 payload，不是整行——at/n 一条不少");
    }

    /// 预算**硬**于"保住最近那行"：单行自己就超预算时，只能把它也降成 null
    /// （否则每次对话 422，代价比丢一份结构大得多）。这条把取舍钉住。
    #[test]
    fn exec_rows_json_budget_beats_keeping_newest_payload() {
        let huge = format!(r#"{{"digest":"{}"}}"#, "大".repeat(4000)); // ≈ 12 KB
        let rows: Vec<ExecRow> = vec![
            ("10-20 11:03".to_string(), "读取文章 19《架构文档》", 1, Some(huge.as_str())),
        ];
        let text = exec_rows_json(&rows);
        assert!(text.len() <= EXEC_ROWS_MAX_CHARS, "单行超预算也必须回到预算内：{}", text.len());
        let out: serde_json::Value = serde_json::from_str(&text).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 1, "行还在（at/n 不丢）");
        assert!(arr[0]["payload"].is_null(), "payload 降成 null 是唯一能保住预算的做法");
    }
}
