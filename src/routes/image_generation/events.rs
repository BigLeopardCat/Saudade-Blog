//! Standard SSE observes durable job state; dropping a reader never cancels paid generation.
use super::{errors::JobError, *};
use axum::response::{
    sse::{Event, KeepAlive},
    Sse,
};
use futures::stream;
use std::{convert::Infallible, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WatchQuery {
    pub wait_seconds: Option<u64>,
}

struct Watch {
    state: Arc<AppState>,
    uid: i32,
    id: String,
    first: Option<Job>,
    deadline: tokio::time::Instant,
    previous: Option<(String, Option<String>, Option<String>, Option<i32>)>,
}

fn terminal(status: &str) -> bool {
    matches!(
        status,
        "review" | "accepted" | "rejected" | "failed" | "unknown" | "expired"
    )
}

pub async fn observe(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<WatchQuery>,
) -> Result<impl IntoResponse, JobError> {
    let seconds = query.wait_seconds.unwrap_or(240);
    if !(1..=240).contains(&seconds) {
        return Err(JobError::Invalid("等待时间须为 1 至 240 秒"));
    }
    let uid = crate::routes::gallery::actor(&state, &headers)
        .await
        .map_err(|_| JobError::Unauthorized)?;
    let first = jobs::read(&state, uid, &id).await?;
    let watch = Watch {
        state,
        uid,
        id,
        first: Some(first),
        deadline: tokio::time::Instant::now() + Duration::from_secs(seconds),
        previous: None,
    };
    let events = stream::unfold(Some(watch), next);
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (
                axum::http::HeaderName::from_static("x-accel-buffering"),
                "no",
            ),
        ],
        Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(2))),
    ))
}

async fn next(current: Option<Watch>) -> Option<(Result<Event, Infallible>, Option<Watch>)> {
    let mut watch = current?;
    loop {
        let result = match watch.first.take() {
            Some(job) => Ok(job),
            None => tokio::time::timeout(
                Duration::from_secs(3),
                jobs::read(&watch.state, watch.uid, &watch.id),
            )
            .await
            .unwrap_or_else(|_| Err(error("image job observation timed out"))),
        };
        let job = match result {
            Ok(job) => job,
            Err(_) => {
                return Some((
                    Ok(Event::default()
                        .event("image_job_error")
                        .json_data(serde_json::json!({"code":"unavailable"}))
                        .expect("fixed event")),
                    None,
                ))
            }
        };
        let revision = (
            job.status.clone(),
            job.error.clone(),
            job.output_hash.clone(),
            job.image_id,
        );
        if watch.previous.as_ref() != Some(&revision) {
            let done = terminal(&job.status);
            watch.previous = Some(revision);
            return Some((
                Ok(Event::default()
                    .event("image_job")
                    .json_data(&job)
                    .expect("job JSON")),
                if done { None } else { Some(watch) },
            ));
        }
        if tokio::time::Instant::now() >= watch.deadline {
            return Some((
                Ok(Event::default()
                    .event("image_job_timeout")
                    .json_data(&job)
                    .expect("job JSON")),
                None,
            ));
        }
        tokio::time::sleep_until(std::cmp::min(
            watch.deadline,
            tokio::time::Instant::now() + Duration::from_secs(2),
        ))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Arc<AppState> {
        use crate::rate_limiter::LoginRateLimiter;
        Arc::new(AppState {
            db: sea_orm::MockDatabase::new(DatabaseBackend::Postgres).into_connection(),
            rate_limiter: LoginRateLimiter::new(1, 60, 60),
            post_limiter: crate::risk::PostRateLimiter::default(),
            report_limiter: LoginRateLimiter::new(1, 60, 60),
        })
    }

    #[tokio::test]
    async fn invalid_deadlines_and_missing_identity_fail_before_opening_a_stream() {
        for seconds in [0, 241] {
            let result = observe(
                State(state()),
                HeaderMap::new(),
                Path("private-job".into()),
                Query(WatchQuery {
                    wait_seconds: Some(seconds),
                }),
            )
            .await;
            let error = result.err().expect("Out-of-range deadline accepted");
            assert!(matches!(error, JobError::Invalid(_)));
            assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        }
        for seconds in [Some(1), Some(240), None] {
            let result = observe(
                State(state()),
                HeaderMap::new(),
                Path("private-job".into()),
                Query(WatchQuery {
                    wait_seconds: seconds,
                }),
            )
            .await;
            let error = result.err().expect("Anonymous observation accepted");
            assert!(matches!(error, JobError::Unauthorized));
            assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[test]
    fn waiting_and_storage_are_not_completed_results() {
        for status in ["pending", "generating", "saving"] {
            assert!(!terminal(status));
        }
        for status in [
            "review", "accepted", "rejected", "failed", "unknown", "expired",
        ] {
            assert!(terminal(status));
        }
    }
}
