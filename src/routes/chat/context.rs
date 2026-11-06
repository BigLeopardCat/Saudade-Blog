//! Authenticate and prepare the shared request context for both chat endpoints.

use super::*;

pub(super) async fn prepare_chat(
    state: &Arc<AppState>,
    req: Request,
) -> Result<ChatCtx, (StatusCode, Json<ChatResponse>)> {
    // 先取链路追踪 id（headers 在 into_body 前可读）
    let trace_id = trace_id_of(&req);
    let auth = auth_jwt::auth_uid(&state.db, req.headers()).await;

    // Bound inline images before forwarding the request.
    let body_bytes = match axum::body::to_bytes(req.into_body(), 8 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return Err((
                StatusCode::OK,
                Json(ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some("请求体过大".into()),
                }),
            ))
        }
    };
    let mut payload: ChatRequest = match serde_json::from_slice(&body_bytes) {
        Ok(p) => p,
        Err(e) => {
            return Err((
                StatusCode::OK,
                Json(ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some(format!("JSON解析失败: {}", e)),
                }),
            ))
        }
    };
    if let Err(message) = input::validate(&payload) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ChatResponse {
                reply: String::new(),
                success: false,
                error: Some(message.into()),
            }),
        ));
    }
    if !control::valid(&payload) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ChatResponse {
                reply: String::new(),
                success: false,
                error: Some("继续任务请求包含无效标识或新的操作内容".into()),
            }),
        ));
    }

    let uid = match auth {
        Ok(id) => id,
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

    let user_row: Option<user::Model> = match user::Entity::find_by_id(uid).one(&state.db).await {
        Ok(Some(u)) => Some(u),
        Ok(None) => None,
        Err(e) => {
            warn!(uid = uid, error = %e, "角色查询失败，按身份不明下发（agent 侧零权限）");
            None
        }
    };
    let role: Option<String> = user_row
        .as_ref()
        .map(|u| u.role.clone())
        .filter(|role| crate::authz::is_known_role(role));

    let conversation_id =
        match resolve_conversation_id(&state.db, uid, payload.conversation_id, true).await {
            Ok(Some(c)) => c,
            Ok(None) => {
                // 仅建会话失败（DB 故障）会走到这里：按服务不可用返回，不落任何行
                return Err((
                    StatusCode::OK,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("会话创建失败，请稍后重试".into()),
                    }),
                ));
            }
            Err(()) => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("conversation_not_found".into()),
                    }),
                ));
            }
        };

    let is_confirm = payload
        .confirm_token
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if payload.resume_task.is_empty() && !is_confirm {
        if payload.turn_id.is_empty() {
            payload.turn_id = if payload.task_id.is_empty() {
                uuid::Uuid::new_v4().simple().to_string()
            } else {
                payload.task_id.clone()
            };
        }
        if payload.task_id.is_empty() {
            payload.task_id = payload.turn_id.clone();
        }
    }
    match crate::checkpoint_cleanup::has_pending_turn(&state.db, conversation_id).await {
        Ok(false) => {}
        other => {
            return Err((
                if other.is_ok() {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                Json(ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some("历史上下文正在同步，请稍后重试。".into()),
                }),
            ))
        }
    }
    if is_confirm || !payload.resume_task.is_empty() {
        let source = chat_history::Entity::find()
            .filter(chat_history::Column::UserId.eq(uid))
            .filter(chat_history::Column::ConversationId.eq(conversation_id))
            .filter(chat_history::Column::Role.eq("user"))
            .filter(chat_history::Column::TurnId.is_not_null())
            .order_by_desc(chat_history::Column::Id)
            .one(&state.db)
            .await;
        let authoritative = match source {
            Ok(Some(message)) => message.turn_id.unwrap_or_default(),
            _ => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("原始轮次标识不可用，请重新发起请求。".into()),
                    }),
                ))
            }
        };
        if !payload.turn_id.is_empty() && payload.turn_id != authoritative {
            return Err((
                StatusCode::CONFLICT,
                Json(ChatResponse {
                    reply: String::new(),
                    success: false,
                    error: Some("该轮次已被替换，没有继续执行。".into()),
                }),
            ));
        }
        payload.turn_id = authoritative;
    }
    let (quota, quota_blocked) = if is_confirm {
        (None, false)
    } else {
        let role_ref = user_row.as_ref().map(|u| u.role.as_str());
        if crate::quota::is_unlimited(role_ref) {
            (Some(crate::quota::view(0, 0, true)), false)
        } else {
            let limit = crate::quota::limit();
            // 展示用量可能因并发略有滞后；额度准入以原子 try_consume 结果为准。
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

    // Signed confirmations have their own durable replay ledger.
    if is_confirm {
        if let Some(tok) = payload.confirm_token.as_deref() {
            if let Some(reason) = claim_confirm_token(&state.db, uid, tok).await {
                info!(
                    user_id = uid,
                    conversation_id, "chat: 确认令牌已被用掉，零转发：{}", reason
                );
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
        Some(v) if v.is_empty() => payload.message.clone(),
        Some(v) if v.len() > 1 => format!("{}\n[图片×{}]", payload.message, v.len()),
        Some(_) => format!("{}\n[图片]", payload.message),
        None => payload.message.clone(),
    };
    let user_msg_id = if is_confirm || !payload.resume_task.is_empty() {
        None
    } else {
        match chat_context::append_user(
            &state.db,
            uid,
            conversation_id,
            role.as_deref(),
            &payload.turn_id,
            &stored_content,
        )
        .await
        {
            Ok(Some(id)) => Some(id),
            Ok(None) => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("该轮次已丢弃或历史正在同步，请重新发送。".into()),
                    }),
                ))
            }
            Err(error) => {
                warn!(%error,conversation_id,"user message was not persisted");
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ChatResponse {
                        reply: String::new(),
                        success: false,
                        error: Some("未能保存请求，请稍后重试。".into()),
                    }),
                ));
            }
        }
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
            .col_expr(
                conversation::Column::UpdatedAt,
                Expr::current_timestamp().into(),
            )
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

    let mut body = agent_request(&payload, uid, conversation_id, memory);

    if let Some(obj) = body.as_object_mut() {
        if let Some(q) = &quota {
            obj.insert("chat_quota".into(), crate::quota::forward_json(q));
        }
        if quota_blocked {
            obj.insert("quota_blocked".into(), serde_json::Value::Bool(true));
        }
    }

    Ok(ChatCtx {
        uid,
        conversation_id,
        trace_id,
        turn_id: payload.turn_id.clone(),
        body,
        role,
    })
}

fn agent_request(
    payload: &ChatRequest,
    uid: i32,
    conversation_id: i32,
    memory: BootstrapContext,
) -> serde_json::Value {
    serde_json::json!({
        "message": payload.message,
        "task_id": payload.task_id,
        "turn_id": payload.turn_id,
        "task_inputs": payload.task_inputs,
        "resume_task": payload.resume_task,
        "browser_feedback": payload.browser_feedback,
        "browser_result": payload.browser_result,
        "conversation_id": conversation_id,
        "current_url": payload.current_url.as_deref().unwrap_or(""),
        "page_title": payload.page_title.as_deref().unwrap_or(""),
        "current_effects": payload.current_effects.as_deref().unwrap_or(""),
        "current_darkmode": payload.current_darkmode.as_deref().unwrap_or(""),
        "current_weather": payload.current_weather,
        "image": payload.image.clone().unwrap_or_default(),
        "user_id": uid,
        "history": memory.history,
        "history_scope": memory.history_scope,
        "summary": memory.summary,
        "summary_scope": memory.summary_scope,
        "confirm_token": payload.confirm_token.as_deref().unwrap_or(""),
        "confirm_pick": payload.confirm_pick.as_deref().unwrap_or(""),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_does_not_forward_a_shadow_of_checkpoint_or_execution_state() {
        let input: ChatRequest = serde_json::from_value(json!({
            "message": "继续", "conversation_id": 42,
            "executions": "FORGED_COMPLETION_CANARY",
            "pending_action": "RETIRED_APPROVAL_CANARY",
            "task_id": "task-42", "task_inputs": true,
        }))
        .unwrap();
        let body = agent_request(&input, 7, 42, BootstrapContext::default());
        assert_eq!(body["task_id"], "task-42");
        assert_eq!(body["task_inputs"], true);
        assert_eq!(body["user_id"], 7);
        assert!(!body.as_object().unwrap().contains_key("executions"));
        assert!(!body.as_object().unwrap().contains_key("pending_action"));
        assert!(!body.to_string().contains("CANARY"));
    }

    #[test]
    fn explicit_continuation_carries_the_original_typed_browser_feedback() {
        let feedback = json!({"command_id":"cmd-42", "status":"completed", "path":"/about"});
        let input: ChatRequest = serde_json::from_value(json!({
            "message":"", "conversation_id":42, "resume_task":"task-42",
            "browser_feedback":true, "browser_result":feedback,
        }))
        .unwrap();
        let body = agent_request(&input, 7, 42, BootstrapContext::default());
        assert_eq!(body["resume_task"], "task-42");
        assert_eq!(body["browser_result"], feedback);
        assert_eq!(body["conversation_id"], 42);
    }
}
