use axum::{
    Json,
    body::{Body, Bytes},
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

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
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
    //   ② Rust 侧**不验签**（两个 worker、无状态；令牌的 uid/会话绑定由 agent 校验，
    //      agent 拿到的 uid 是本端已鉴权的 uid）；
    //   ③ 回复与执行回执照常落库（那就是真发生过的执行）。
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

use sea_orm::{EntityTrait, Set, QueryOrder, QueryFilter, ColumnTrait, QuerySelect, ActiveModelTrait, PaginatorTrait};
use sea_orm::sea_query::Expr; // Expr 不在 sea-orm 根（0.12.15 仅 pub use sea_query 全名）
use crate::entity::{
    agent_task, chat_history, chat_summary, conversation, execution_log, pending_action,
};
use crate::routes::conversation::resolve_conversation_id;
use futures::StreamExt;
use async_stream::stream;

/// 对话上下文：由 prepare_chat 组装，/chat 与 /chat/stream 共用
struct ChatCtx {
    uid: i32,
    /// 本轮消息所属会话（prepare_chat 内解析，用户消息入库前确定）
    conversation_id: i32,
    total_count: i64,
    trace_id: String,
    body: serde_json::Value,
    /// 中断清理边界（DiscardAbortedExchange）：删 id 大于它的残缺 assistant 回复。
    /// 普通轮 = user_msg_id；**隐藏确认轮没有 user 消息**（user_msg_id 为 None），
    /// 取会话当前最大 id（= 弹窗那条 assistant 消息）——不设边界的话，确认轮被
    /// 中途停掉时半截回复会留在历史里（普通轮不会）。
    boundary_id: Option<i32>,
    /// 用户角色（20260920，查 DB 得到；None = 查不到）。只用于签进身份断言交给
    /// agent 做权限判据（agent/src/authz.py），Rust 侧不用它做任何放行判断
    /// ——后台准入走 middleware::auth_guard（那里的纪律是"不信 token 里的 role"）。
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
    let items: Vec<HistoryItem> = recent
        .iter()
        .rev() // 时间升序（聊天软件阅读序）
        .map(|h| HistoryItem {
            id: h.id,
            role: h.role.clone(),
            content: h.content.clone(),
            time: h.created_at.and_local_timezone(chrono::Local).single().map(|dt| dt.timestamp_millis()).unwrap_or(0),
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
/// 不想要这条进记忆，与连接中断清理（DiscardAbortedExchange 只删残缺、保留 user）互补。
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
    let _ = chat_history::Entity::delete_many()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conv_id))
        .filter(chat_history::Column::Id.gte(u.id))
        .exec(&state.db)
        .await;
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

    // 角色（20260920，秘书类功能地基）：查 DB 而非读登录 token 里的 role——token
    // 7 天有效，改过角色的用户会带着旧角色跑（与 middleware::auth_guard 同一条纪律）。
    // 查不到/查失败一律 None：身份断言里就带 null，agent 按"身份不明 = 零权限"处理。
    // **绝不因为读不到角色就默认授予任何一档**。DB 故障只降级（不阻断对话）。
    let role: Option<String> = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(u)) => Some(u.role),
        Ok(None) => None,
        Err(e) => {
            warn!(uid = uid, error = %e, "角色查询失败，按身份不明下发（agent 侧零权限）");
            None
        }
    };

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
    // 一次性核销（20260924）：**转发之前**认领这张令牌，认领不到就直接如实拒绝。
    // 位置是刻意的——核销必须发生在写操作可能发生**之前**，否则两个并发请求会双双
    // 通过（"先查、再执行、最后标记"之间的窗口就是第二次写）。这也是全链路唯一
    // 能拿到令牌原文的地方（agent 侧验签、Rust 侧核销，各管一段）。
    // 拒绝走 409 + 错误码：前端按它把卡片如实结算成"已经用过一次"，不当网络错误。
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
    let user_msg_id = if is_confirm {
        None
    } else {
        chat_history::ActiveModel {
            user_id: Set(uid),
            conversation_id: Set(conversation_id),
            role: Set("user".into()),
            content: Set(stored_content.clone()),
            ..Default::default()
        }.insert(&state.db).await.ok().map(|m| m.id)
    };

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
    // 最后活动时间：**确认轮也要 bump**（20260921）——点确认是一次真实交互，
    // 会话列表该按活动时间浮上来；它与"标题派生"是两件事，故不共用上面那个守卫
    if user_msg_id.is_some() || is_confirm {
        let _ = conversation::Entity::update_many()
            .col_expr(conversation::Column::UpdatedAt, Expr::current_timestamp().into())
            .filter(conversation::Column::Id.eq(conversation_id))
            .exec(&state.db)
            .await;
    }

    // 中断清理边界（见 ChatCtx::boundary_id）：确认轮没有本轮 user 消息，用会话
    // 当前最大 id（= 弹窗那条 assistant 回复）当边界——它是这一轮的起点，删 id
    // 大于它的 assistant 残缺回复即本轮半截话。查询走 idx(conversation_id) 倒序取一。
    let boundary_id = if is_confirm {
        chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(conversation_id))
            .order_by_desc(chat_history::Column::Id)
            .one(&state.db)
            .await
            .unwrap_or(None)
            .map(|r| r.id)
    } else {
        user_msg_id
    };

    // 读取最近历史（20260828 修复：排除刚插入的当前消息 user_msg_id——此前 history
    // 含当前消息、agent 端又追加 last_msg，同一条消息注入 2 次，模型注意力被重复
    // 文本分散并形成"自己提问自己回答"的假象。limit 21 保证排除后仍有 20 条历史）
    // 20260903 会话化：只取本会话（不再跨会话混拼——原上下文污染根因）；
    // 会话内 order_by_desc(Id) 即时间序（单会话串行写入，CreatedAt 排序退役）
    let history_items: Vec<serde_json::Value> = {
        let recent = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(conversation_id))
            .order_by_desc(chat_history::Column::Id)
            .limit(Some(21))
            .all(&state.db)
            .await.unwrap_or_default();
        recent.iter()
            .filter(|h| Some(h.id) != user_msg_id)
            .rev()
            .take(20)
            .map(|h| serde_json::json!({"role": h.role, "content": h.content}))
            .collect()
    };

    // 加载本会话压缩摘要（20260903 会话化后每会话独立；UserId 双保险，
    // 权威键是 conversation_id——DB 唯一约束已改到该列）
    let summary_row = chat_summary::Entity::find()
        .filter(chat_summary::Column::UserId.eq(uid))
        .filter(chat_summary::Column::ConversationId.eq(conversation_id))
        .one(&state.db)
        .await.unwrap_or_default();
    let summary_text = summary_row.as_ref().map(|s| s.summary.clone()).unwrap_or_default();

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
    let executions_text: String = {
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
        let mut rows: Vec<(String, &str, usize)> = Vec::new();
        for r in &recent {
            match seen.get(r.detail.as_str()) {
                Some(i) => rows[*i].2 += 1,
                None => {
                    seen.insert(r.detail.as_str(), rows.len());
                    rows.push((
                        r.created_at.format("%m-%d %H:%M").to_string(),
                        r.detail.as_str(),
                        1,
                    ));
                }
            }
        }
        rows.truncate(8);
        rows.iter()
            .rev() // 新→旧取回 → 旧→新拼串
            .map(|(at, detail, n)| {
                if *n > 1 {
                    format!("{at} {detail}（×{n}）")
                } else {
                    format!("{at} {detail}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n· ")
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

    // 统计本会话消息数，决定是否触发压缩。needs_summary 补懒生成条款：会话 >20 条
    // 且尚无摘要行（存量旧会话回访）也触发一次——摘要落库后条件自然关闭；
    // %10∈{0,1} 为历史双触发节奏（summary 与回复并行生成，不阻塞对话）
    let total_count: i64 = chat_history::Entity::find()
        .filter(chat_history::Column::UserId.eq(uid))
        .filter(chat_history::Column::ConversationId.eq(conversation_id))
        .count(&state.db)
        .await.unwrap_or(0) as i64;
    let needs_summary = total_count > 20
        && (total_count % 10 == 0 || total_count % 10 == 1 || summary_row.is_none());

    // 保留策略（20260903 会话化后按会话）：单个会话最多保留 CHAT_HISTORY_LIMIT
    // （默认 500）条，超出删除该会话最旧的多余记录——清理不再跨会话删行；
    // 提示词窗口只看本会话最近 20 条 + 摘要，删头不影响连续性
    let history_limit: i64 = std::env::var("CHAT_HISTORY_LIMIT")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let excess = total_count - history_limit;
    if excess > 0 {
        let oldest = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(conversation_id))
            .order_by_asc(chat_history::Column::Id)
            .limit(excess as u64)
            .all(&state.db)
            .await.unwrap_or_default();
        if let Some(max_id) = oldest.last().map(|r| r.id) {
            let _ = chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::ConversationId.eq(conversation_id))
                .filter(chat_history::Column::Id.lte(max_id))
                .exec(&state.db)
                .await;
        }
    }

    let body = serde_json::json!({
        "message": payload.message,
        // 20260921：会话 id 下发 agent——确认令牌里签了 conv_id，验签要拿它对账
        // （令牌只对发起它的那个会话有效，避免用户切了会话后确认写到别处）
        "conversation_id": conversation_id,
        "current_url": payload.current_url.as_deref().unwrap_or(""),
        "page_title": payload.page_title.as_deref().unwrap_or(""),
        "current_effects": payload.current_effects.as_deref().unwrap_or(""),
        "current_darkmode": payload.current_darkmode.as_deref().unwrap_or(""),
        "image": payload.image.clone().unwrap_or_default(),
        "user_id": uid,
        "history": history_items,
        "summary": summary_text,
        "needs_summary": needs_summary,
        "executions": executions_text,  // 20260904 C5：跨轮执行记忆（最近 8 条回执，"· " 拼串）
        // 20260923 跨轮待办：上一轮提出、等主人点头的那件事（已执行的已由回执关闭）。
        // 空串 = 没有待办；agent 侧注入 system 上下文，短应答/授权式轮次据此定目标
        "pending_action": pending_text,
        // 20260927 会话级任务状态：本会话未完结的任务（**JSON 数组串**，`[]` = 没有；
        // 不是渲染好的文本行，理由见 load_agent_tasks 的注）。agent 侧渲染进 system
        // 上下文——planner 见它才知道"主人要的这件事还剩哪几步/我上次问了他什么"
        "agent_tasks": agent_tasks,
        // 20260921 确认弹窗：透传待办令牌（空串 = 普通轮）。agent 侧验签失败 →
        // 零执行 + 如实告知"确认已过期"；验签通过 → 跳过 planner 直接执行签名里的动作
        "confirm_token": payload.confirm_token.as_deref().unwrap_or(""),
    });

    if std::env::var("CHAT_DEBUG_BODY").is_ok() {
        eprintln!("[chat-debug] body={}", body);
    }
    Ok(ChatCtx { uid, conversation_id, total_count, trace_id, body, boundary_id, role })
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

/// 对话结束后保存 assistant 消息 + 摘要（/chat 与 /chat/stream 共用）。
/// 摘要由 agent 侧独立生成（needs_summary 轮的后端总结调用，与回复解耦），
/// 经 new_summary（非流式响应字段 / 流式 __SUMMARY__ 帧）传入；
/// None 表示本轮无摘要，不写入 chat_summary（旧摘要保留）。
/// 剥离命令帧行（AUTO_NAVIGATE:/NAVIGATE:/EFFECT:/DARKMODE: 前缀行）。
/// 帧是执行指令不是对话内容——前端已从流式帧/命令帧单独收到命令；存进
/// chat_history 的带帧文本会污染 few-shot：历史 AI 消息全是帧开头，模型学到
/// "回复要写帧"（自强化循环，12:30 轮最终回复即带 AUTO_NAVIGATE: 前缀）。
/// 存库只留干净正文。
fn strip_command_lines(reply: &str) -> String {
    reply
        .lines()
        .filter(|l| {
            !(l.starts_with("AUTO_NAVIGATE:")
                || l.starts_with("NAVIGATE:")
                || l.starts_with("EFFECT:")
                || l.starts_with("DARKMODE:"))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

async fn save_assistant_reply(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    conversation_id: i32,
    reply: String,
    new_summary: Option<String>,
    total_count: i64,
) {
    let _ = chat_history::ActiveModel {
        user_id: Set(uid),
        conversation_id: Set(conversation_id),
        role: Set("assistant".into()),
        content: Set(strip_command_lines(&reply)),
        ..Default::default()
    }.save(db).await;

    if let Some(new_summary) = new_summary {
        if !new_summary.is_empty() {
            // 20260903 会话化：摘要按会话独立存取（权威键 conversation_id）
            let existing = chat_summary::Entity::find()
                .filter(chat_summary::Column::UserId.eq(uid))
                .filter(chat_summary::Column::ConversationId.eq(conversation_id))
                .one(db)
                .await.unwrap_or_default();
            if let Some(rec) = existing {
                let mut am: chat_summary::ActiveModel = rec.into();
                am.summary = Set(new_summary);
                am.message_count = Set(total_count as i32);
                let _ = am.update(db).await;
            } else {
                let _ = chat_summary::ActiveModel {
                    user_id: Set(uid),
                    conversation_id: Set(conversation_id),
                    summary: Set(new_summary),
                    message_count: Set(total_count as i32),
                    ..Default::default()
                }.save(db).await;
            }
        }
    }
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
        "secretary" => "以秘书身份 · ".to_string(),
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
fn render_exec_row(row: &serde_json::Value) -> String {
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
        "get_article_detail" => match row["title"].as_str().unwrap_or("") {
            "" => format!("读取文章 {}", arg("article_id")),
            t => format!("读取文章 {}《{}》", arg("article_id"), t),
        },
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

/// 跨轮执行记忆落库（20260904）：批量插入 checker 验收回执（渲染后存储）。
/// 流式在 save_assistant_reply 后、同步在响应解析后调用；`let _ =` 吞错——
/// 执行记忆是辅助事实，落库失败不影响回复主链路。断连/discard 刻意不清
/// execution_log（执行是已发生事实，中断只弃残缺叙述不否定已验收执行）。
async fn save_execution_log(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    conversation_id: i32,
    rows: &[serde_json::Value],
) {
    for row in rows {
        let _ = execution_log::ActiveModel {
            user_id: Set(uid),
            conversation_id: Set(conversation_id),
            skill: Set(row["skill"].as_str().unwrap_or("").chars().take(32).collect()),
            detail: Set(render_exec_row(row)),
            ..Default::default()
        }.save(db).await;
    }
    // 跨轮待办收口（20260923）：回执命中待办的工具体 ⇒ 那件事真被执行了 ⇒ 关闭它。
    // "系统事实优先于结构化状态"落在这一行里：不靠模型回报、不靠叙述。确认轮的
    // 隐藏请求也走同一条路（写成功 → checker PASS → 回执 ⇒ 待办关闭）。
    close_pending_actions(db, conversation_id, rows).await;
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
/// `args` 列上限：它是**审计线索**不是执行依据（真正的执行参数在签名的确认令牌
/// 里），超限只存前缀，绝不为了"看起来是合法 JSON"去改写内容。
const PENDING_ARGS_COL_MAX: usize = 4000;
/// 卡片问句列上限（= 迁移里 `question` varchar(500)）。超限只存前缀：问句是给人读的，
/// 截断顶多少看几个字，而**丢掉整张卡片**（下面那条"空串=不可重建"的规则）更坏。
const PENDING_QUESTION_COL_MAX: usize = 500;
/// 选项 JSON 列上限（= 迁移里 `options` varchar(600)）。当前固定两项，余量很大。
const PENDING_OPTIONS_COL_MAX: usize = 600;

/// 待办落库（20260923）：agent 在弹确认框那一轮随 `__CONFIRM__` 发来的结构化提议。
/// 先删本会话仍 pending 的旧行——**新的顶掉旧的**（"最新那次提议"才是主人心里那
/// 件事），顺带让同一条待办的重发天然幂等。`let _ =` 吞错，与 execution_log 同
/// 口径：辅助事实，落库失败不阻断对话主链路（确认本身走无状态令牌，不依赖本表）。
async fn save_pending_action(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    conversation_id: i32,
    v: &serde_json::Value,
) {
    let tools: Vec<String> = v["specs"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s["tool"].as_str())
                .map(|t| t.to_string())
                .collect()
        })
        .unwrap_or_default();
    let args = v["specs"].to_string();
    // 卡片素材（20260924）：问句是字符串、按钮是 JSON **数组**（`json_capped` 只认
    // 字符串，数组走 to_string——类型不对一律空串，宁可卡片重建不出来，也不编一个
    // 按钮出来）。两件都写时定稿：重建出来的卡片必须与主人当时看到的那张逐字一致。
    let options = if v["options"].is_array() {
        v["options"].to_string()
    } else {
        String::new()
    };
    // 到期时刻：agent 给的是令牌自身的 `exp`（UTC 秒）→ 库里的 +08:00 本地钟面
    // （CLAUDE.md 时区约定：显式时间一律本地钟面，读侧不再二次偏移）。缺字段/非数字
    // → NULL（"未知"，读侧如实不留卡片）。
    let expires_at: Option<chrono::NaiveDateTime> = v["expires_at"].as_i64().and_then(|s| {
        chrono::DateTime::from_timestamp(s, 0).map(|t| t.with_timezone(&chrono::Local).naive_local())
    });
    let _ = pending_action::Entity::delete_many()
        .filter(pending_action::Column::ConversationId.eq(conversation_id))
        .filter(pending_action::Column::Status.eq("pending"))
        .exec(db)
        .await;
    let _ = pending_action::ActiveModel {
        task_id: Set(json_capped(v, "task_id", 64)),
        conversation_id: Set(conversation_id),
        user_id: Set(uid),
        skill: Set(json_capped(v, "skill", 32)),
        tool: Set(tools.join(",").chars().take(255).collect()),
        args: Set(Some(args.chars().take(PENDING_ARGS_COL_MAX).collect())),
        target: Set(json_capped(v, "target", 300)),
        // 卡片四件（20260924）：问句/按钮供重建，jti/到期时刻供一次性核销与时效过滤
        question: Set(json_capped(v, "question", PENDING_QUESTION_COL_MAX)),
        options: Set(options.chars().take(PENDING_OPTIONS_COL_MAX).collect()),
        jti: Set(json_capped(v, "jti", 64)),
        expires_at: Set(expires_at),
        requested_by: Set(match json_capped(v, "requested_by", 32) {
            s if s.is_empty() => "user".to_string(),
            s => s,
        }),
        source_event: Set(json_capped(v, "source_event", 64)),
        confirmation_required: Set(true),
        confirmation_status: Set("awaiting".to_string()),
        status: Set("pending".to_string()),
        ..Default::default()
    }
    .save(db)
    .await;
}

/// 令牌的一次性核销（20260924）：把 `jti` 对应的那一行置为"已被用掉"。
///
/// 返回 `Some(理由)` = **这张令牌已经兑现过一次**，调用方零转发（如实拒绝）；
/// `None` = 放行。判据只有一条 SQL 的 `rows_affected`：只有第一个把
/// `claimed_at` 从 NULL 改成值的人拿到 1，重放/两个标签页同点都拿到 0。
///
/// **为什么是"尽力而为"**：认领表里没有这张令牌（老客户端、落库失败、签发那一轮
/// DB 抖动、20260924 之前签发的 v1 令牌根本没有 jti）时一律放行——**验签始终是
/// 唯一凭据**，本函数只负责"同一张令牌不兑现两次"。反过来把"查不到"当成拒绝，
/// 会打死所有无状态确认（那正是 20260921 上线时唯一的通道）。同理，DB 出错也放行：
/// 可用性优先，且失去的只是"重复提交的护栏"，不是授权判据。
///
/// **认领键取自令牌原文**（Rust 侧只解 payload，不验签）：认领是**自伤型**的——
/// `WHERE jti=? AND user_id=?` 只动本人那一行，伪造者最多烧掉自己的一次机会；
/// 真凭据仍在 agent 侧的验签（Rust 没有那把密钥，也不该有）。
async fn claim_confirm_token(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    token: &str,
) -> Option<String> {
    let jti = token_jti(token);
    if jti.is_empty() {
        return None;
    }
    let claimed = pending_action::Entity::update_many()
        .col_expr(
            pending_action::Column::ClaimedAt,
            Expr::value(Some(chrono::Local::now().naive_local())),
        )
        .filter(pending_action::Column::Jti.eq(jti.as_str()))
        .filter(pending_action::Column::UserId.eq(uid))
        .filter(pending_action::Column::ClaimedAt.is_null())
        .exec(db)
        .await;
    match claimed {
        Ok(r) if r.rows_affected == 1 => None,
        Ok(_) => {
            // 没抢到：**必须区分**"已经被用掉"与"表里根本没有这一行"——前者如实
            // 拒绝，后者照常放行（无状态路径）。少了这一步，所有查不到的令牌都会
            // 被当成重放而拒绝。
            let exists = pending_action::Entity::find()
                .filter(pending_action::Column::Jti.eq(jti.as_str()))
                .filter(pending_action::Column::UserId.eq(uid))
                .one(db)
                .await
                .ok()
                .flatten()
                .is_some();
            if exists {
                Some("这次确认已经用过了（同一张确认卡片只兑现一次），没有重复执行。".to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

/// 解出确认令牌 payload 里的 `jti`（**不验签**，理由见 `claim_confirm_token`）。
/// 解不出（格式坏 / 没有点号 / 早期无 jti 的令牌）→ 空串，调用方据此不核销。
fn token_jti(token: &str) -> String {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return String::new();
    }
    let Some(raw) = b64url_decode(parts[0]) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return String::new();
    };
    v["jti"].as_str().unwrap_or("").chars().take(64).collect()
}

/// base64url（无填充）解码——只为解令牌 payload 的 `jti`（见 `token_jti`）。
/// 不引新依赖：本仓库没有 base64 crate，而这段是二十行以内、可单测的纯函数，
/// 为了一个字段拉一个依赖（连带 Cargo.lock 与 CI 全量重编）不划算。
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            // agent 侧签发的令牌不带填充；容忍带 '=' 的变体（不改变结果）
            b'=' => continue,
            _ => return None,
        } as u32;
        acc = ((acc << 6) | v) & 0x3FFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// 关闭已执行的待办：回执里出现的工具名 ∈ 待办行 `tool`（逗号分隔）⇒ done/confirmed。
async fn close_pending_actions(
    db: &sea_orm::DatabaseConnection,
    conversation_id: i32,
    receipts: &[serde_json::Value],
) {
    let done: Vec<&str> = receipts.iter().filter_map(|r| r["tool"].as_str()).collect();
    if done.is_empty() {
        return;
    }
    let pending = pending_action::Entity::find()
        .filter(pending_action::Column::ConversationId.eq(conversation_id))
        .filter(pending_action::Column::Status.eq("pending"))
        .all(db)
        .await
        .unwrap_or_default();
    for row in pending {
        if row.tool.split(',').any(|t| !t.is_empty() && done.contains(&t)) {
            let mut am: pending_action::ActiveModel = row.into();
            am.status = Set("done".to_string());
            am.confirmation_status = Set("confirmed".to_string());
            am.updated_at = Set(chrono::Local::now().naive_local());
            let _ = am.update(db).await;
        }
    }
}

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
/// 同一会话最多注入几条未完结任务（最新优先）。与 execution_log 的读侧去重同一条
/// 纪律：**限额与裁剪都在读侧**——存量行无需迁移，改上限不动数据。
const TASK_INLINE_MAX: usize = 3;
/// 读侧时效：超过这个时长的未完结任务不再注入（72 小时）。
/// 与 `pending_action` 的 60 分钟刻意不同：那件事的凭据（确认令牌）10 分钟就失效，
/// 而任务存在的理由正是"别把主人要的事忘了"——它必须比一轮对话活得久。但无限期挂着
/// 同样有害（三天前没做完的事突然被翻出来重问，比忘掉更糟），所以给一个宽但有限的口子。
const TASK_READ_TTL_HOURS: i64 = 72;
/// `goal` / `pending_question` 列上限（= 迁移里的 varchar(300)）
const TASK_TEXT_COL_MAX: usize = 300;
/// `steps` 列上限（审计线索，非执行依据；超出只存前缀，绝不为了"看起来是合法 JSON"
/// 去改写内容——解不出来时读侧会如实给 Null）
const TASK_STEPS_COL_MAX: usize = 4000;
/// 幂等键列上限（= 迁移里的 varchar(80)）
const TASK_IDEM_COL_MAX: usize = 80;

/// 任务落库（20260927）：agent 在 planner 认定"这一轮做不完"时随 `__TASK__` 发来的
/// 结构化声明。**按 `task_id` upsert，不做"新的顶掉旧的"**——这是与 `pending_action`
/// 最大的行为差异，也是分表的理由：那张表装"最新那次提议"（主人心里只有一件事），
/// 这张表装**可以同时存在的多件事**（跨技能排队正是靠这一点）。
/// `let _ =` 吞错，与 execution_log / pending_action 同口径：辅助事实，落库失败不阻断
/// 对话主链路（下一轮少一条线索，而不是这一轮报错）。
async fn save_agent_task(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    conversation_id: i32,
    v: &serde_json::Value,
) {
    // 没有 task_id 就没有可对齐的键（重发会变成新行、幂等键也就无从谈起）⇒ 宁可不落库
    let task_id = json_capped(v, "task_id", 64);
    if task_id.is_empty() {
        return;
    }
    let steps: String = if v["steps"].is_array() {
        v["steps"].to_string().chars().take(TASK_STEPS_COL_MAX).collect()
    } else {
        String::new()
    };
    let state = match json_capped(v, "state", 24) {
        s if s.is_empty() => "submitted".to_string(),
        s => s,
    };
    // 幂等键：空 ⇒ NULL。MySQL 唯一索引允许多个 NULL，而空串只能存在一行——
    // 列上那条 UNIQUE 靠这一点同时做到"挡得住重复"与"不把没有键的行互相顶掉"。
    let idem: Option<String> = match json_capped(v, "idempotency_key", TASK_IDEM_COL_MAX) {
        k if k.is_empty() => None,
        k => Some(k),
    };
    // 找行同时按**会话**过滤（不只是 uid）：`task_id` 是 agent 按"会话 + 目标指纹"
    // 派生的（见 agent/tasks.py），正常不会跨会话重复；万一重复，只按 uid 找会把
    // 另一个会话的行改掉（任务状态串到别的会话里——最坏的一种静默串台）。
    // 加了这道，跨会话撞 id 时是**插入撞唯一键**（`uk_at_task`）⇒ 记一行 WARNING，
    // 而不是悄悄改走别人的行。
    let existing = agent_task::Entity::find()
        .filter(agent_task::Column::TaskId.eq(task_id.as_str()))
        .filter(agent_task::Column::UserId.eq(uid))
        .filter(agent_task::Column::ConversationId.eq(conversation_id))
        .one(db)
        .await
        .ok()
        .flatten();
    match existing {
        // 已有行 = 同一件事的后续回合：只更新 agent 有权改的那几格。
        // `goal` 与 `total_steps` **写时定稿、后续回合不许改写**——否则进度会变成
        // "分母也在动"，1/2 与 3/5 说的是两件不同的事，事后对不上账。
        Some(row) => {
            let attempts = row.attempts + 1;
            let mut am: agent_task::ActiveModel = row.into();
            am.steps = Set(Some(steps));
            am.cursor = Set(v["cursor"].as_i64().unwrap_or(0) as i32);
            am.state = Set(state);
            am.pending_question = Set(json_capped(v, "pending_question", TASK_TEXT_COL_MAX));
            am.attempts = Set(attempts);
            am.updated_at = Set(chrono::Local::now().naive_local());
            let _ = am.update(db).await;
        }
        None => {
            let _ = agent_task::ActiveModel {
                task_id: Set(task_id),
                conversation_id: Set(conversation_id),
                user_id: Set(uid),
                goal: Set(json_capped(v, "goal", TASK_TEXT_COL_MAX)),
                steps: Set(Some(steps)),
                total_steps: Set(v["total_steps"].as_i64().unwrap_or(0) as i32),
                cursor: Set(v["cursor"].as_i64().unwrap_or(0) as i32),
                state: Set(state),
                pending_question: Set(json_capped(v, "pending_question", TASK_TEXT_COL_MAX)),
                idempotency_key: Set(idem),
                attempts: Set(1),
                ..Default::default()
            }
            .save(db)
            .await;
        }
    }
}

/// 读侧：本会话未完结任务 → 交给 agent 的 JSON 数组串（`[]` = 没有）。
///
/// **为什么交 JSON 而不是像 `pending_action` / `executions` 那样交一行渲染好的文本**
/// （刻意偏离既往两处先例）：`steps` 是 Python 产的结构（每步带 label/tool），
/// 要渲染成提示词就得看它内部，而它的形状正是本批次会继续演进的东西。让 Rust 只做
/// "取出来、限长、拼成合法 JSON"，形状演化就只动 Python 一侧——与 `execution_log.digest`
/// 的同一条纪律（键名与语义见 agent/tasks.py 头注，**改一侧必须同步另一侧** + 两侧各一条测试）。
///
/// 读失败（表未建 / DB 抖动）→ `[]`，agent 按"没有任务"如实处理，绝不阻断对话。
async fn load_agent_tasks(db: &sea_orm::DatabaseConnection, conversation_id: i32) -> String {
    let cutoff =
        chrono::Local::now().naive_local() - chrono::Duration::hours(TASK_READ_TTL_HOURS);
    let rows = agent_task::Entity::find()
        .filter(agent_task::Column::ConversationId.eq(conversation_id))
        .filter(agent_task::Column::CreatedAt.gte(cutoff))
        // 终态过滤**在查询里**（不是取回来再筛）：限额是"最新 3 条"，先取再筛会让
        // 几条已完结的任务把窗口占掉，注入的行数少于 3 且没人看得出来为什么
        .filter(agent_task::Column::State.is_in(TASK_OPEN_STATES))
        .order_by_desc(agent_task::Column::Id)
        .limit(TASK_INLINE_MAX as u64)
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
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, total_count = ctx.total_count, "chat: 转发 agent 非流式");
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
                let reply = data["reply"].as_str().unwrap_or("").to_string();
                // 非流式：agent 独立生成摘要并返回 new_summary（needs_summary 轮才有值）
                let agent_summary = data["new_summary"].as_str().map(|s| s.to_string());
                if ctx.uid > 0 {
                    save_assistant_reply(&state.db, ctx.uid, ctx.conversation_id, reply.clone(), agent_summary, ctx.total_count).await;
                    // 跨轮执行记忆（20260904 C5）：同步路径的回执在响应体 executions
                    // （agent ChatResponse 新字段；agent 无回执时为 Null → 空数组跳过）
                    let exec_rows: Vec<serde_json::Value> = data["executions"].as_array()
                        .cloned().unwrap_or_default();
                    if !exec_rows.is_empty() {
                        save_execution_log(&state.db, ctx.uid, ctx.conversation_id, &exec_rows).await;
                    }
                }
                Json(ChatResponse { reply, success: true, error: None }).into_response()
            } else {
                Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent error: {}", r.status())) }).into_response()
            }
        }
        None => {
            Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent unavailable: {}", last_err)) }).into_response()
        }
    }
}

/// 在帧缓冲中查找 SSE 帧结束位置（\n\n 之后），返回消费长度
fn find_frame_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n").map(|i| i + 2)
}

/// 流式对话中断清理（20260828b 语义修正）：客户端中途断开（页面转跳/关闭标签页/网络中断）时，
/// 删除本轮 user 消息之后的残缺 assistant 回复，**保留 user 消息本身**——
/// 用户"发完消息不等回复就转跳"是最常见使用模式，转跳导致连接中断后，
/// 新页面应从 DB 权威历史看到"消息已发出"（聊天软件形态）；只有残缺回复不入记忆
/// （history 上下文 / 摘要），避免半截命令/问答污染后续对话。
///
/// 与主动停止的区别：用户点击"停止生成"是明确不想要这条，前端会显式调用
/// POST /api/chat/discard 全删（user + 残缺）；这里的连接中断无法区分"跳走"与
/// "删除意图"，一律保守保留 user。
///
/// Drop 在 SSE 生成器（body_stream）被取消时同步执行；DB 删除是异步操作，用 tokio::spawn 异步完成。
/// 20260903 会话化：删除范围带 conversation_id 快照——drop 可能延迟到用户已切到新会话
/// 之后执行，不带会话过滤会误清新会话的残缺回复。
/// 仅当流未正常收尾（未收到终止标记即被取消）时才清理；正常结束由 done 标记关闭清理，
/// 保留既有行为（含上游异常时保存残缺回复的逻辑，见 chat_stream_handler 尾部）。
struct DiscardAbortedExchange {
    state: Arc<AppState>,
    uid: i32,
    /// 本轮消息所属会话快照（与 user_msg_id 同源于 prepare_chat）：
    /// 清理双限（会话 + id 区间），drop 延迟执行时绝不越界误删其他会话
    conversation_id: i32,
    /// 本轮起点快照（prepare_chat 计算，见 ChatCtx::boundary_id）。
    /// 只删 id 大于快照的 assistant 记录——即使清理延迟执行（期间新轮 user 已插入），
    /// role=user 的新记录也不会被误删。
    boundary_id: Option<i32>,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for DiscardAbortedExchange {
    fn drop(&mut self) {
        if self.done.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(boundary_id) = self.boundary_id else { return };
        let state = self.state.clone();
        let uid = self.uid;
        let conversation_id = self.conversation_id;
        // 只删本轮 user 消息之后的残缺 assistant 回复（id 单调递增 + role + 会话三重限定）。
        // 若 drop 延迟到新轮已插入：新轮 user（role=user）不受影响；新轮同会话尚未收尾，
        // 其 assistant 记录不可能先于旧轮清理存在，不会误删；跨会话（用户已切走）
        // 由 conversation_id 限定天然隔离
        tokio::spawn(async move {
            let _ = chat_history::Entity::delete_many()
                .filter(chat_history::Column::UserId.eq(uid))
                .filter(chat_history::Column::ConversationId.eq(conversation_id))
                .filter(chat_history::Column::Id.gt(boundary_id))
                .filter(chat_history::Column::Role.eq("assistant"))
                .exec(&state.db)
                .await;
        });
    }
}

/// 流式回合收尾的**分离式**落库（20260920 顺序契约）。
///
/// 两个要点：
/// ① **先落库、再转发终止帧**。此前顺序相反（先 yield `__END__`，流收尾才写库）：
///    客户端一见到 `__END__` 就断开时（流式探针实测；真实浏览器读连接关闭不受
///    影响，见 chat-stream.js），响应体 future 被丢弃 ⇒ 尾部 await 跑不完 ⇒ 本轮
///    回复与执行回执双双丢失。语义上"发出终止帧"就是本轮交换完成，落库不该依赖
///    客户端还开着连接。
/// ② 用 `tokio::spawn` 把写入从生成器生命周期里摘出来：即便这一行之后 future 被
///    丢弃（断开正好落在 DB 写入的那几毫秒里），任务照常跑完。
///
/// 调用方**先**置 `done`：`DiscardAbortedExchange` 以 done 判定本轮是否正常收尾，
/// 不先置位的话，紧接着的断开会让中断清理把刚写的正常回复当"残缺回复"删掉。
fn spawn_save_assistant_reply(
    state: Arc<AppState>,
    uid: i32,
    conversation_id: i32,
    reply: String,
    new_summary: Option<String>,
    total_count: i64,
) {
    if uid <= 0 || reply.is_empty() {
        return;
    }
    tokio::spawn(async move {
        save_assistant_reply(&state.db, uid, conversation_id, reply, new_summary, total_count).await;
    });
}

/// SSE 流式对话：转发 agent /chat/stream，边转发边累积文本，
/// 流结束后保存历史与摘要（agent 端 payload 为 JSON 编码，避免 \n\n 破坏帧边界）
pub async fn chat_stream_handler(
    State(state): State<Arc<AppState>>,
    req: Request,
) -> Response {
    let ctx = match prepare_chat(&state, req).await {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };

    let stream_url = agent_chat_url().strip_suffix("/chat").unwrap_or("").to_string() + "/chat/stream";
    info!(trace_id = %ctx.trace_id, user_id = ctx.uid, total_count = ctx.total_count, "chat: 转发 agent 流式");
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
            return Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent unavailable: {}", e)) }).into_response();
        }
    };
    if !upstream.status().is_success() {
        return Json(ChatResponse { reply: String::new(), success: false, error: Some(format!("Agent error: {}", upstream.status())) }).into_response();
    }

    let state = state.clone();
    let uid = ctx.uid;
    let conversation_id = ctx.conversation_id;
    let total_count = ctx.total_count;
    let boundary_id = ctx.boundary_id;
    // 帧循环里的告警要用（stream! 生成器闭包不能借用 ctx——它后面还要用 ctx 写响应头）
    let trace_id = ctx.trace_id.clone();

    let body_stream = stream! {
        let mut upstream_stream = upstream.bytes_stream();
        let mut frame_buf: Vec<u8> = Vec::new();
        let mut reply = String::new();
        let mut terminal = false;
        // 独立摘要（agent 侧 needs_summary 轮后端总结的返回值，随 __SUMMARY__ 帧到达）
        let mut summary_override: Option<String> = None;
        // 跨轮执行记忆（20260904 C5）：checker 验收回执（__EXEC__ 帧 → execution_log
        // 落库）在下方帧循环里收到即写，不留内存副本——断开也不丢

        // 客户端中断清理（见 DiscardAbortedExchange）：流被取消时删除本轮 user 消息
        // 之后的残缺回复（user 消息本体保留）；正常走完 while 循环后置位 done，关闭清理
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _guard = DiscardAbortedExchange { state: state.clone(), uid, conversation_id, boundary_id, done: done.clone() };

        while let Some(chunk) = upstream_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break, // 上游中断：以已累积文本收尾
            };
            frame_buf.extend_from_slice(&chunk);
            loop {
                let Some(end) = find_frame_end(&frame_buf) else { break };
                // drain 到分隔符之后，再把帧尾的 \n\n 去掉，避免转发时出现双分隔符
                let mut frame: Vec<u8> = frame_buf.drain(..end).collect();
                frame.truncate(frame.len().saturating_sub(2));
                let payload = frame.strip_prefix(b"data: ")
                    .map(|p| String::from_utf8_lossy(p).to_string())
                    .unwrap_or_default();
                if payload.is_empty() { continue; }
                // 终端/错误标记：**先落库（分离写入）、再原样转发给前端**
                // （20260920 顺序契约，见 spawn_save_assistant_reply：客户端见到
                // 终止帧即断开也不该丢回复；done 先置位防中断清理误删刚写的回复）
                if payload.starts_with("__END__") || payload.starts_with("__NAV_END__") {
                    terminal = true;
                    done.store(true, std::sync::atomic::Ordering::SeqCst);
                    spawn_save_assistant_reply(state.clone(), uid, conversation_id,
                                               std::mem::take(&mut reply),
                                               summary_override.take(), total_count);
                    yield Ok::<_, axum::Error>(Bytes::from(format!("data: {}\n\n", payload)));
                    break;
                } else if payload.starts_with("__ERROR__:") {
                    terminal = true;
                    done.store(true, std::sync::atomic::Ordering::SeqCst);
                    spawn_save_assistant_reply(state.clone(), uid, conversation_id,
                                               std::mem::take(&mut reply),
                                               summary_override.take(), total_count);
                    yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                    break;
                }
                // 独立摘要结果帧：不终止流、不进回复（agent 在 __END__ 之前发出），
                // 内容记入内存供流结束后写入 chat_summary
                if let Some(s) = payload.strip_prefix("__SUMMARY__:") {
                    if let Ok(s) = serde_json::from_str::<String>(s) {
                        summary_override = Some(s);
                    }
                    continue;
                }
                // 跨轮执行记忆（20260904 C5）：checker 验收回执帧。必须在下方 JSON 文本
                // 解析之前拦截——payload 不是合法 JSON 字符串（serde 解析会静默丢弃）。
                // 只收进落库、绝不 yield 转发——前端无此帧协议，透传会被当作正文渲染。
                // 20260920：**收到即写**（此前攒到流收尾），执行回执是执行事实的唯一
                // 载体，攒到尾部意味着"客户端在收尾前断开 ⇒ 执行记录丢"——而断连恰恰
                // 是执行后最常见的事（用户等不及关页面/转跳）。收到即写则之后任何时刻
                // 断开都已持久化；断连/discard 不清 execution_log（执行是已发生事实）
                if let Some(rows) = payload.strip_prefix("__EXEC__:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rows) {
                        if let Some(arr) = v.as_array() {
                            if uid > 0 && !arr.is_empty() {
                                let state = state.clone();
                                let rows = arr.clone();
                                tokio::spawn(async move {
                                    save_execution_log(&state.db, uid, conversation_id, &rows).await;
                                });
                            }
                        }
                    }
                    continue;
                }
                // 跨轮待办（20260923）：确认弹窗那一轮的结构化提议。与 __EXEC__ 同族
                // ——必须在下方 JSON 文本解析之前拦（payload 不是合法 JSON 字符串，
                // 会走 1193 那行静默丢弃）；只收进落库、**绝不 yield 转发**（前端无
                // 此帧协议，透传会被当正文渲染）。收到即写：弹窗那一轮主人可能立刻
                // 切走，晚写就等于没写。
                if let Some(body) = payload.strip_prefix("__PENDING__:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                        if uid > 0 && v.is_object() {
                            let state = state.clone();
                            let v = v.clone();
                            tokio::spawn(async move {
                                save_pending_action(&state.db, uid, conversation_id, &v).await;
                            });
                        }
                    }
                    continue;
                }
                // 会话级任务状态（20260927）：planner 认定"这一轮做不完"时的结构化声明
                // （还剩哪几步 / 缺哪个参数要问主人）。与 `__PENDING__` 同一族的三个
                // 理由逐条相同：必须在下面 JSON 文本解析之前拦（帧体不是合法 JSON
                // 字符串，晚拦会被静默丢弃）；只收进落库、**绝不 yield 转发**（前端无此
                // 帧协议，透传会被当正文渲染）；收到即写（这一轮说完话主人可能立刻切走）。
                // 与待办的差别只有一条：**同一 task_id 重复发是更新而非替换**
                // （`save_agent_task` 里的 upsert），并发任务因此能共存。
                if let Some(body) = payload.strip_prefix("__TASK__:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                        if uid > 0 && v.is_object() {
                            let state = state.clone();
                            let v = v.clone();
                            tokio::spawn(async move {
                                save_agent_task(&state.db, uid, conversation_id, &v).await;
                            });
                        }
                    }
                    continue;
                }
                // 连线命令帧（20260926 批 2）：命令从"工具返回的字符串"搬到了执行回执的
                // `cmd` 字段（见 agent/graph.py 的 _cmd_wire 与 execute_node），Python 侧
                // 用这一族帧单独发给浏览器。三件事缺一不可：
                //   ① **必须在下面 `serde_json::from_str::<String>` 之前拦**——帧体
                //      `__CMD__:{"kind":…}` 不是合法 JSON 字符串，晚拦了会落进 1193 那行
                //      **静默丢弃**（前端收不到命令，症状是"点了没反应"、三端都不留痕）；
                //   ② **绝不累积进 `reply`**（与 __PROCESS__/__CONFIRM__ 同族）：漏了这条，
                //      帧体会被拼进 assistant 回复并持久化（用户看到一坨 JSON，还会注入
                //      下一轮上下文）；
                //   ③ **原样转发**给前端执行。帧体只有 kind/url/effect/action/mode 这类
                //      **公开的执行动作**，不含任何确认凭据——这正是它与
                //      __CONFIRM__/__PENDING__（带令牌、只落库不转发）的区别所在，
                //      所以这里可以安全地原样 yield。
                // 旧的文本前缀分支（下方 AUTO_NAVIGATE:/… 那一支）**保留**：兼容期里
                // 老版 agent 仍在发它们，且删了会回归 20260903 那个 strip_command_lines
                // 整行剥空导致"转跳后回复丢失"的 bug。
                if payload.starts_with("__CMD__:") {
                    yield Ok::<_, axum::Error>(Bytes::from(format!("data: {}\n\n", payload)));
                    continue;
                }
                // 文本块：JSON 编码，解码后累积（用于历史保存），原样转发
                if let Ok(text) = serde_json::from_str::<String>(&payload) {
                    if text.starts_with("__RESET__") {
                        // 质检重置帧：原样转发给前端清空重绘，但已累积的回复作废——
                        // 被 REVISE 否定的轮次不入历史（否则 __RESET__ 标记与废轮文本
                        // 会污染 chat_history，进而注入后续对话上下文，形成坏 few-shot）
                        reply.clear();
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    if text.starts_with("__PROCESS__") {
                        // 过程步骤帧（计划/工具调用/质检打回，前端灰色过程行展示）：
                        // 属于"执行过程"而非最终回复，转发但不累积进历史
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    if text.starts_with("__CONFIRM__") {
                        // 确认弹窗帧（20260921）：前端据此弹「泠月喵」同款确认框。
                        // 与 __PROCESS__ 同族——**只转发、不累积进 reply 不落库**：
                        // 漏了这条分支，帧体（含待办令牌）会被拼进 assistant 回复
                        // 并持久化（用户看到一坨 JSON，令牌还会进下一轮上下文）
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    // 命令帧（NAVIGATE:/AUTO_NAVIGATE:/EFFECT:/DARKMODE:）：执行指令
                    // 不是对话内容，前端已单独收到命令并执行。不累积进 reply——
                    // 命令帧先于叙述帧到达且无换行分隔时，单行拼接会让保存时的
                    // strip_command_lines 整行剥空（20260903 实证 chat_history
                    // 空行 3465 → 转跳后回复丢失）。转发仍照常（前端执行命令用）
                    if text.starts_with("AUTO_NAVIGATE:")
                        || text.starts_with("NAVIGATE:")
                        || text.starts_with("EFFECT:")
                        || text.starts_with("DARKMODE:")
                    {
                        yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                        continue;
                    }
                    reply.push_str(&text);
                    yield Ok(Bytes::from(format!("data: {}\n\n", payload)));
                } else {
                    // 20260923：帧体既不是已知前缀帧、也不是 JSON 编码的文本 ⇒ 解码不了。
                    // 旧行为是静默丢弃：前端只是"少了一段回复"，Python/Rust/前端三端都
                    // 不留痕（三端语义漂移时最难查的那类）。**只记前 24 字符**——
                    // __CONFIRM__/__PENDING__ 族的帧体带确认令牌，整帧入日志等于把令牌
                    // 写进日志文件。
                    let head: String = payload.chars().take(24).collect();
                    warn!(trace_id = %trace_id, user_id = uid, len = payload.len(), head = %head,
                          "chat: 收到无法解析的 SSE 帧，已丢弃（既非已知前缀帧也不是 JSON 文本）");
                }
            }
            if terminal { break; }
        }

        // 正常收尾（无论是否收到终止标记）：不再触发中断清理
        done.store(true, std::sync::atomic::Ordering::SeqCst);

        // 上游中断且未收到终止标记：显式告知前端（否则静默截断无法区分）
        if !terminal {
            yield Ok::<_, axum::Error>(Bytes::from(
                "data: __ERROR__:\"与 Agent 的连接中断，回复可能不完整\"\n\n",
            ));
        }

        // 兜底落库：正常路径（收到终止帧）已在转发终止帧之前落库——reply/summary
        // 已被 take 空，这里自然跳过；剩下的只有"上游中断、没收到终止帧"的收尾
        // （保持既有行为：保存残缺回复 + 独立摘要）
        if !reply.is_empty() && uid > 0 {
            save_assistant_reply(&state.db, uid, conversation_id, reply, summary_override, total_count).await;
        }
        // 执行回执不在这里：收到 __EXEC__ 帧时就已落库（见上分支），
        // 因此客户端在任何时刻断开（哪怕收尾前）都不会丢执行记录
    };

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
        Body::from_stream(body_stream),
    ).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    /// 下面那条长令牌是**真的**：由 agent 侧 `confirm.sign` 现签（`jti=fb7899a7…`），
    /// 拷进来的。这条断言因此同时锁住跨语言那一层——Python 的 base64url 无填充编码
    /// 与这里的解码器必须对上，哪天 agent 换了编码（或加了填充）这里会红。
    #[test]
    fn token_jti_reads_payload_without_verifying() {
        const REAL: &str = "eyJ2IjoyLCJ1aWQiOjcsImNvbnYiOjQyLCJleHAiOjE3OTAxOTQ2MzcsImp0aSI6ImZiNzg5OWE3\
OTE2MTQ1OGYwM2E4YjEyMDg5ZjhjNTdmIiwic2tpbGwiOiJmYXZvcml0ZV9hZGQiLCJzcGVjcyI6W3sidG9v\
bCI6ImFkZF9mYXZvcml0ZSIsImFyZ3MiOnsiYXJ0aWNsZV9pZCI6MTJ9fV19.ec1JP-MBgyu3LitO422E7F9gVgotMQQXsiQDb2ZsEDw";
        assert_eq!(token_jti(REAL), "fb7899a79161458f03a8b12089f8c57f");
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
        let tampered = format!("{}.AAAA", REAL.split('.').next().unwrap());
        assert_eq!(token_jti(&tampered), "fb7899a79161458f03a8b12089f8c57f");
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
}
