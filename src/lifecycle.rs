//! HTTP shutdown and completion of already accepted background work.
use axum::Router;
use std::{future::Future, io};
use tokio::net::TcpListener;
use tokio_util::task::TaskTracker;

pub async fn serve(
    listener: TcpListener,
    app: Router,
    tasks: TaskTracker,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;
    // HTTP handlers may register background work before their response completes.
    // Close registration only after those handlers have finished.
    tasks.close();
    tracing::info!(
        remaining = tasks.len(),
        "waiting for accepted background work"
    );
    tasks.wait().await;
    result
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("register SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    tracing::info!(
        event = "service_stopping",
        "draining HTTP requests and accepted jobs"
    );
}
