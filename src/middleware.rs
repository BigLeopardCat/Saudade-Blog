use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::Response,
};
use sea_orm::EntityTrait;
use std::sync::Arc;
use crate::routes::AppState;
use crate::entity::user;

pub async fn download_headers(req: Request, next: Next) -> Response {
    let is_image = crate::utils::is_image_path(req.uri().path());
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    if !is_image {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    resp
}

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
                let user_db = user::Entity::find_by_id(claims.sub)
                    .one(&state.db)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                match user_db {
                    Some(u) => {
                        if crate::authz::check_token(u.status, u.token_version, claims.ver).is_err() {
                            return Err(StatusCode::UNAUTHORIZED);
                        }
                        if crate::authz::can_access_console(&u.role) {
                            Ok(next.run(req).await)
                        } else {
                            Err(StatusCode::FORBIDDEN)
                        }
                    }
                    None => Err(StatusCode::UNAUTHORIZED),
                }
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
