use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use sea_orm::{ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use crate::routes::AppState;
use crate::auth_jwt;
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

/// MySQL LIKE 默认反斜杠转义：用户输入的字面 % _ \ 若不转义，% _ 会当通配符、
/// \ 会吞掉后续转义语义——内容搜索的用户输入注入面，须逐字符转义成 \% \_ \\
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '%' || ch == '_' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

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
    // order_by_desc(Id) 下每会话首见即最新命中（id 全局自增、会话内亦单调）——
    // hit_by_conv 既作列表过滤条件，也随行回传作定位锚点
    let mut hit_by_conv: HashMap<i32, i32> = HashMap::new();
    if let Some(q) = q {
        let pat = format!("%{}%", like_escape(q));
        let rows = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::Content.like(&pat))
            .order_by_desc(chat_history::Column::Id)
            .all(&state.db)
            .await
            .unwrap_or_default();
        for r in rows {
            hit_by_conv.entry(r.conversation_id).or_insert(r.id);
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
            Condition::any().add(conversation::Column::Title.like(&pat))
        } else {
            Condition::any()
                .add(conversation::Column::Title.like(&pat))
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
    // 级联删除（应用层四条 delete，无 DB 外键——与全项目"实体零关系"惯例一致），
    // 事务保证四步一致性（失败回滚，不出现孤儿消息/摘要/执行回执）
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
    let _ = chat_history::Entity::delete_many()
        .filter(chat_history::Column::ConversationId.eq(id))
        .exec(&txn)
        .await;
    let _ = chat_summary::Entity::delete_many()
        .filter(chat_summary::Column::ConversationId.eq(id))
        .exec(&txn)
        .await;
    // 跨轮执行记忆（20260904 C5）：执行回执随会话删除级联清理——会话删了，
    // 其 execution_log 行无任何读取路径（prepare_chat 按 conversation_id 注入），
    // 不清理会永久占表
    let _ = execution_log::Entity::delete_many()
        .filter(execution_log::Column::ConversationId.eq(id))
        .exec(&txn)
        .await;
    // 跨轮待办（20260923）：同上——待办按会话读取，会话没了就无读取路径，
    // 留着只会永久占表（待办不跨会话生效：确认令牌也绑会话）
    let _ = pending_action::Entity::delete_many()
        .filter(pending_action::Column::ConversationId.eq(id))
        .exec(&txn)
        .await;
    // 会话级任务状态（20260927）：同上——任务按会话读写（prepare_chat 注入 + agent
    // 只发本会话的 task_id），会话没了就没有任何读取路径；与待办的区别只是它活得更久
    // （分钟级 vs 最长 72 小时），**不清理会永久占表**这一条完全一样
    let _ = agent_task::Entity::delete_many()
        .filter(agent_task::Column::ConversationId.eq(id))
        .exec(&txn)
        .await;
    let _ = conversation::Entity::delete_by_id(id).exec(&txn).await;
    match txn.commit().await {
        Ok(_) => (StatusCode::OK, Json(json!({"success": true}))).into_response(),
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
        .filter(chat_history::Column::Content.like(&pat))
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
