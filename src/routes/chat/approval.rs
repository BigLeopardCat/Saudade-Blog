//! Confirmation transport. Signed native operations use the Agent's durable ledger.

use super::pending;
use crate::{
    auth_jwt,
    entity::{pending_action, user},
    routes::AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

pub(super) const MAX_CONFIRM_TOKEN_CHARS: usize = 16_384;

// A transport hint, never authorization. Forged hints fail Agent signature checks.
fn agent_owned(token: &str) -> bool {
    token_payload(token)
        .and_then(|v| v["executor"].as_str().map(|s| !s.is_empty()))
        .unwrap_or(false)
}

#[derive(Deserialize)]
pub struct Cancellation {
    conversation_id: i32,
    token: String,
}

pub async fn cancel_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Cancellation>,
) -> Response {
    let uid = match auth_jwt::auth_uid(&state.db, &headers).await {
        Ok(uid) => uid,
        Err(_) => {
            return (StatusCode::UNAUTHORIZED, Json(json!({"cancelled": false}))).into_response()
        }
    };
    if !matches!(
        super::resolve_conversation_id(&state.db, uid, Some(req.conversation_id), false).await,
        Ok(Some(_))
    ) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"cancelled": false, "error": "conversation_not_found"})),
        )
            .into_response();
    }
    if req.token.is_empty() || req.token.len() > MAX_CONFIRM_TOKEN_CHARS {
        return (StatusCode::BAD_REQUEST, Json(json!({"cancelled": false}))).into_response();
    }
    let role = user::Entity::find_by_id(uid)
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .map(|u| u.role);
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(client) => client,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({"cancelled": false}))).into_response()
        }
    };
    let sent = client
        .post(format!(
            "{}/confirmation/cancel",
            crate::routes::graph::agent_base_url()
        ))
        .header(
            "X-Agent-Assertion",
            auth_jwt::create_agent_assertion(uid, role.as_deref()),
        )
        .json(&json!({"user_id": uid, "conversation_id": req.conversation_id, "token": req.token}))
        .timeout(Duration::from_secs(8))
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"cancelled": false, "error": "agent_unavailable"})),
            )
                .into_response()
        }
    };
    let status = response.status();
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({"cancelled": false}))).into_response()
        }
    };
    if status.is_success() && body["cancelled"] == true {
        let Some(event) = body
            .get("event")
            .filter(|event| event["jti"] == token_jti(&req.token))
        else {
            return (StatusCode::BAD_GATEWAY, Json(json!({"cancelled": false}))).into_response();
        };
        if !pending::cancel(&state.db, uid, req.conversation_id, event).await {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"cancelled": false, "error": "pending_sync_failed"})),
            )
                .into_response();
        }
    }
    (status, Json(body)).into_response()
}

pub(super) async fn claim_confirm_token(
    db: &sea_orm::DatabaseConnection,
    uid: i32,
    token: &str,
) -> Option<String> {
    if token.len() > MAX_CONFIRM_TOKEN_CHARS {
        return Some("确认令牌超出长度限制，请重新生成确认卡。".to_owned());
    }
    // The signed executor owns durable replay; the Agent verifies the token.
    if agent_owned(token) {
        return None;
    }
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
            // Missing legacy rows remain compatible with stateless cards.
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
pub(super) fn token_jti(token: &str) -> String {
    token_payload(token)
        .and_then(|value| value["jti"].as_str().map(|s| s.chars().take(64).collect()))
        .unwrap_or_default()
}

fn token_payload(token: &str) -> Option<Value> {
    if token.len() > MAX_CONFIRM_TOKEN_CHARS {
        return None;
    }
    let (body, signature) = token.split_once('.')?;
    if signature.contains('.') {
        return None;
    }
    serde_json::from_slice(&b64url_decode(body)?).ok()
}

/// Standard Base64 decoding for transport hints; this does not verify signatures.
pub(super) fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s)
        .or_else(|_| URL_SAFE.decode(s))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DatabaseBackend, MockDatabase, MockExecResult};

    #[test]
    fn transport_decoder_rejects_noncanonical_base64() {
        assert_eq!(b64url_decode("Zg"), Some(b"f".to_vec()));
        assert_eq!(b64url_decode("Zg=="), Some(b"f".to_vec()));
        assert!(b64url_decode("Zh").is_none());
        assert!(b64url_decode("Zg===").is_none());
        assert!(token_payload("body.signature.extra").is_none());
    }

    #[tokio::test]
    async fn native_retries_never_consume_host_claims() {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let token = "eyJleGVjdXRvciI6ImZhdm9yaXRlcyIsImp0aSI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIn0.signature";
        for _ in 0..3 {
            assert!(claim_confirm_token(&db, 7, token).await.is_none());
        }
        assert!(db.into_transaction_log().is_empty());
    }

    #[tokio::test]
    async fn legacy_cards_keep_atomic_host_claim() {
        let db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_exec_results([MockExecResult {
                last_insert_id: 0,
                rows_affected: 1,
            }])
            .into_connection();
        assert!(claim_confirm_token(
            &db,
            7,
            "eyJqdGkiOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSJ9.signature"
        )
        .await
        .is_none());
        let log = db.into_transaction_log();
        assert_eq!(log.len(), 1);
        let sql = format!("{:?}", log[0]);
        assert!(sql.contains("claimed_at") && sql.contains("IS NULL"));
        assert!(sql.contains("user_id") && sql.contains("jti"));
    }

    #[tokio::test]
    async fn host_cancellation_failure_is_not_acknowledged() {
        let db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let event = json!({"event": "cancelled", "jti": "a".repeat(32), "task_id": format!("pa_{}", "a".repeat(32))});
        assert!(!pending::cancel(&db, 7, 42, &event).await);
    }
}
