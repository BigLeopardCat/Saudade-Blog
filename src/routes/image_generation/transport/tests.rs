use super::*;
use crate::routes::image_generation::{provider, settings::Settings, Request};
use axum::{extract::State, routing::get, Json, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn explicit_proxy_configuration_is_validated_without_exposing_credentials() {
    assert!(proxy_url("  ").unwrap().is_none());
    for value in [
        "http://127.0.0.1:17891",
        "https://user:secret@proxy.invalid:443",
    ] {
        assert!(proxy_url(value).unwrap().is_some());
    }
    for value in [
        "socks5://user:PRIVATE@proxy.invalid",
        "PRIVATE",
        "http://proxy.invalid/path",
        "http://proxy.invalid?key=PRIVATE",
        "http://proxy.invalid#PRIVATE",
    ] {
        let message = proxy_url(value).unwrap_err();
        assert!(!message.contains("PRIVATE") && !message.contains("user:"));
    }
}

#[tokio::test]
async fn https_generation_uses_connect_and_does_not_fall_back_or_expose_the_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = reqwest::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        requests.fetch_add(1, Ordering::SeqCst);
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
            headers.push(byte[0]);
            assert!(headers.len() < 8192);
        }
        socket
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
        String::from_utf8(headers).unwrap()
    });
    let request = Request {
        provider: "https://provider.invalid/v1".into(),
        prompt: "PRIVATE_PROMPT".into(),
        model: "fixture".into(),
        size: "1024x1024".into(),
        quality: "high".into(),
        references: vec![],
    };
    let config = Settings {
        key: "PRIVATE_API_KEY".into(),
        base: request.provider.clone(),
        models: vec!["fixture".into()],
        proxy: Some(proxy),
    };
    let error = provider::generate(config, &request, &[]).await.unwrap_err();
    let headers = server.await.unwrap();
    assert!(headers.starts_with("CONNECT provider.invalid:443 HTTP/1.1\r\n"));
    assert!(!headers.contains("PRIVATE") && !error.contains("PRIVATE"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn direct_reference_download_does_not_share_the_provider_proxy() {
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url =
        reqwest::Url::parse(&format!("http://{}", proxy.local_addr().unwrap())).unwrap();
    let proxied = client(Some(&proxy_url)).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route(
            "/reference",
            get(|State(count): State<Arc<AtomicUsize>>| async move {
                count.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({"source": "reference"}))
            }),
        )
        .with_state(count.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let result = client(None)
        .unwrap()
        .get(format!("http://{address}/reference"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(result["source"], "reference");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), proxy.accept())
            .await
            .is_err()
    );
    drop(proxied);
    server.abort();
}
