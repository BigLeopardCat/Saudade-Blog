use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    middleware::Next,
    response::Response,
};

pub async fn auth_guard(req: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|header| header.to_str().ok());

    match auth_header {
        Some(token) => {
            let clean_token = token.strip_prefix("Bearer ").unwrap_or(token);
            if let Some(claims) = crate::auth_jwt::verify_token(clean_token) {
                if claims.role == "admin" {
                    Ok(next.run(req).await)
                } else {
                    Err(StatusCode::FORBIDDEN)
                }
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
