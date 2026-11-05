use super::Claims;
use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Tools,
    Background,
}

#[derive(Serialize, Deserialize)]
pub struct Grant {
    pub sub: i32,
    pub exp: usize,
    pub role: String,
    pub ver: i32,
    aud: String,
    pub scope: Scope,
}

pub fn issue(uid: i32, role: &str, version: i32, scope: Scope, now: usize) -> Option<String> {
    let secret = std::env::var("BLOG_DELEGATION_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)?;
    let grant = Grant {
        sub: uid,
        role: role.into(),
        ver: version,
        exp: now
            + if scope == Scope::Background {
                30 * 86400
            } else {
                300
            },
        aud: "blog-tools".into(),
        scope,
    };
    encode(
        &Header::default(),
        &grant,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()
}

pub fn verify(token: &str) -> Option<Grant> {
    let secret = std::env::var("BLOG_DELEGATION_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)?;
    let mut validation = Validation::default();
    validation.leeway = 0;
    validation.set_audience(&["blog-tools"]);
    validation.set_required_spec_claims(&["exp", "aud", "sub"]);
    let grant = decode::<Grant>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    (grant.sub > 0).then_some(grant)
}

impl Grant {
    pub fn claims(self) -> Claims {
        Claims {
            sub: self.sub,
            exp: self.exp,
            role: self.role,
            ver: Some(self.ver),
            aud: Some(self.aud),
        }
    }
}

pub fn allows(scope: Scope, method: &Method, path: &str) -> bool {
    if !(path.starts_with("/api/protected/")
        || path.starts_with("/api/protect/")
        || path.starts_with("/api/knowledge")
        || path.starts_with("/api/temp-users")
        || path.starts_with("/api/device-gateway/"))
    {
        return false;
    }
    if path.starts_with("/api/protected/auth/")
        || path.starts_with("/api/protected/draft/")
        || path.contains("password")
        || path.contains("/chat")
        || path.contains("/conversation")
        || path.starts_with("/api/protected/graph/")
        || path.starts_with("/api/protected/agent/")
    {
        return false;
    }
    if scope == Scope::Background {
        if path.starts_with("/api/device-gateway/") {
            return false;
        }
        return method == Method::GET
            || (method == Method::POST
                && matches!(
                    path,
                    "/api/protected/automation-results" | "/api/protected/catalog/search"
                ));
    }
    // Authentication, proxy transport and credential issuance are never tool APIs.
    !path.starts_with("/api/protected/automations")
}

pub async fn boundary(request: Request, next: Next) -> Result<Response, StatusCode> {
    if let Some(token) = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
    {
        if let Some(grant) = verify(token.strip_prefix("Bearer ").unwrap_or(token)) {
            if !allows(grant.scope, request.method(), request.uri().path()) {
                return Err(StatusCode::FORBIDDEN);
            }
        }
    }
    Ok(next.run(request).await)
}

pub async fn exchange(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::routes::AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<axum::Json<crate::utils::ApiResponse<serde_json::Value>>, StatusCode> {
    use sea_orm::EntityTrait;
    let claims = super::claims_from_headers(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let actor = crate::entity::user::Entity::find_by_id(claims.sub)
        .one(&state.db)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    crate::authz::check_token(actor.status, actor.token_version, claims.ver)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let token = issue(
        actor.id,
        &actor.role,
        actor.token_version,
        Scope::Tools,
        chrono::Utc::now().timestamp() as usize,
    )
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(axum::Json(crate::utils::ApiResponse::success(
        serde_json::json!({"uid": actor.id, "token": token, "expiresIn": 300}),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_is_read_only_except_owner_result_delivery() {
        assert!(allows(
            Scope::Background,
            &Method::GET,
            "/api/protected/automation-actor"
        ));
        assert!(allows(
            Scope::Background,
            &Method::POST,
            "/api/protected/automation-results"
        ));
        assert!(!allows(
            Scope::Background,
            &Method::DELETE,
            "/api/protect/delImg"
        ));
        assert!(!allows(
            Scope::Background,
            &Method::POST,
            "/api/chat/stream"
        ));
        assert!(!allows(Scope::Tools, &Method::POST, "/api/login"));
        assert!(!allows(
            Scope::Tools,
            &Method::POST,
            "/api/protected/auth/password"
        ));
    }
}
