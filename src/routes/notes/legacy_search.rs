//! Compatibility array search, with finite work and explicit broad-query rejection.
use super::*;
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;
pub(super) const CANDIDATE_LIMIT: u64 = 1000;

pub(super) fn too_broad() -> Json<ApiResponse<Vec<NoteDto>>> {
    Json(ApiResponse::error(
        "匹配文章过多，请缩小筛选范围或使用分页搜索",
    ))
}
fn valid(payload: &SearchRequest) -> bool {
    [
        &payload.keyword,
        &payload.title,
        &payload.categories,
        &payload.status,
        &payload.start_date,
        &payload.end_date,
    ]
    .iter()
    .all(|s| {
        s.as_deref()
            .is_none_or(|s| s.len() <= 512 && s.chars().count() <= 128)
    })
}
pub async fn search_notes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    if !valid(&payload) {
        return Json(ApiResponse::error("搜索条件最多 128 个字符"));
    }
    static LIMITER: OnceLock<crate::rate_limiter::LoginRateLimiter> = OnceLock::new();
    let ip = crate::routes::auth::get_client_ip(&headers);
    if ip.len() > 128
        || LIMITER
            .get_or_init(|| crate::rate_limiter::LoginRateLimiter::new(60, 60, 30))
            .hit(&ip, "legacy-note-search")
            .is_err()
    {
        return Json(ApiResponse::error("搜索过于频繁，请稍后再试"));
    }
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let Ok(permit) = SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
    else {
        return Json(ApiResponse::error("搜索繁忙，请稍后重试"));
    };
    let permit = Arc::new(permit);
    let task = async {
        let keyword = payload.keyword.clone().unwrap_or_default();
        let cpu_permit = permit.clone();
        let terms = tokio::task::spawn_blocking(move || {
            let _permit = cpu_permit;
            split_terms(&keyword)
        })
        .await;
        let Ok(terms) = terms else {
            return Json(ApiResponse::error("搜索暂时不可用"));
        };
        search_notes_query(state, payload, terms).await
    };
    match tokio::time::timeout(Duration::from_secs(5), task).await {
        Ok(response) => response,
        Err(_) => Json(ApiResponse::error("搜索超时，请缩小范围后重试")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_every_filter_and_keeps_unicode_queries() {
        for field in [
            "keyword",
            "title",
            "categories",
            "status",
            "start_date",
            "end_date",
        ] {
            let request: SearchRequest =
                serde_json::from_value(serde_json::json!({field: "字".repeat(129)})).unwrap();
            assert!(!valid(&request));
        }
        let request =
            serde_json::from_value(serde_json::json!({"keyword": "字".repeat(128)})).unwrap();
        assert!(valid(&request));
        assert_ne!(
            too_broad().0.code,
            200,
            "超限必须显式失败，不能静默截断结果"
        );
    }
}
