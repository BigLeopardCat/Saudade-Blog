use axum::{routing::post, Router};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::{
    net::TcpListener,
    sync::oneshot,
    time::{timeout, Duration},
};
use tokio_util::task::TaskTracker;

#[tokio::test]
async fn shutdown_waits_for_accepted_job_after_http_response() {
    let tasks = TaskTracker::new();
    let (finish, wait) = oneshot::channel::<()>();
    let wait = Arc::new(Mutex::new(Some(wait)));
    let persisted = Arc::new(AtomicBool::new(false));
    let worker_tasks = tasks.clone();
    let worker_persisted = persisted.clone();
    let app = Router::new().route(
        "/approve",
        post(move || {
            let rx = wait.lock().unwrap().take().unwrap();
            let written = worker_persisted.clone();
            worker_tasks.spawn(async move {
                rx.await.unwrap();
                written.store(true, Ordering::SeqCst);
            });
            async { axum::http::StatusCode::ACCEPTED }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(saudade_blog::lifecycle::serve(
        listener,
        app,
        tasks.clone(),
        async {
            stopped.await.unwrap();
        },
    ));
    assert_eq!(
        reqwest::Client::new()
            .post(format!("http://{address}/approve"))
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    stop.send(()).unwrap();
    assert!(timeout(Duration::from_millis(50), tasks.wait())
        .await
        .is_err());
    assert!(!server.is_finished() && !persisted.load(Ordering::SeqCst));
    finish.send(()).unwrap();
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(persisted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn shutdown_waits_for_an_inflight_http_handler_before_closing_tracker() {
    let tasks = TaskTracker::new();
    let handler_tasks = tasks.clone();
    let (entered, entry) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered)));
    let (finish, wait) = oneshot::channel::<()>();
    let wait = Arc::new(Mutex::new(Some(wait)));
    let persisted = Arc::new(AtomicBool::new(false));
    let recorded = persisted.clone();
    let app = Router::new().route(
        "/approve",
        post(move || {
            let rx = wait.lock().unwrap().take().unwrap();
            entered.lock().unwrap().take().unwrap().send(()).unwrap();
            let t = handler_tasks.clone();
            let recorded = recorded.clone();
            async move {
                rx.await.unwrap();
                t.spawn(async move {
                    recorded.store(true, Ordering::SeqCst);
                });
                "accepted"
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(saudade_blog::lifecycle::serve(
        listener,
        app,
        tasks.clone(),
        async {
            stopped.await.unwrap();
        },
    ));
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("http://{address}/approve"))
            .send()
            .await
            .unwrap()
    });
    entry.await.unwrap();
    stop.send(()).unwrap();
    assert!(!server.is_finished());
    finish.send(()).unwrap();
    assert_eq!(request.await.unwrap().status(), 200);
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(persisted.load(Ordering::SeqCst));
}
