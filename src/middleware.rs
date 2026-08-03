use axum::{
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::Response,
};
use sea_orm::EntityTrait;
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::user;

pub async fn auth_guard(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok());

    match auth_header {
        Some(token) => {
            let clean_token = token.strip_prefix("Bearer ").unwrap_or(token);
            if let Some(claims) = crate::auth_jwt::verify_token(clean_token) {
                // 从数据库校验用户角色，而非信任 JWT 中的 role
                let user_db = user::Entity::find_by_id(claims.sub)
                    .one(&state.db)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                match user_db {
                    Some(u) if u.role == "admin" => Ok(next.run(req).await),
                    Some(_) => Err(StatusCode::FORBIDDEN),
                    None => Err(StatusCode::UNAUTHORIZED),
                }
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
