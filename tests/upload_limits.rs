use std::sync::Arc;
use axum::{body::{to_bytes, Body}, http::Request, Router};
use saudade_blog::{routes::{upload, AppState}, rate_limiter::LoginRateLimiter};
use sea_orm::{DatabaseBackend, MockDatabase};
use tower::ServiceExt;

async fn upload_body(bytes: usize) -> String {
    let state = Arc::new(AppState {
        db: MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
        rate_limiter: LoginRateLimiter::new(5, 60, 300),
        post_limiter: saudade_blog::risk::PostRateLimiter::new(),
        report_limiter: LoginRateLimiter::new(120, 60, 300),
    });
    let app = Router::new().route("/upload", upload::route()).with_state(state);
    let mut body = b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"original.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
    body.resize(body.len() + bytes, b'x');
    body.extend_from_slice(b"\r\n--boundary--\r\n");
    let response = app.oneshot(Request::post("/upload")
        .header("content-type", "multipart/form-data; boundary=boundary")
        .body(Body::from(body)).unwrap()).await.unwrap();
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn gallery_original_larger_than_default_axum_limit_reaches_content_validation() {
    let response = upload_body(3 * 1024 * 1024).await;
    assert!(response.contains("内容不是图片"), "{response}");
    assert!(!response.contains("文件读取失败"), "{response}");
}

#[tokio::test]
async fn gallery_rejects_a_file_above_twenty_mib_without_writing() {
    let response = upload_body(upload::IMAGE_MAX_BYTES + 1).await;
    assert!(response.contains("20 MiB"), "{response}");
}
