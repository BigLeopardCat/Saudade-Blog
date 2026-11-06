//! Explicit delegated API surface. New console routes require a deliberate grant.
use super::Scope;
use axum::http::Method;

pub(super) fn allows(scope: Scope, method: &Method, path: &str) -> bool {
    if method == Method::GET && READS.iter().any(|p| matches(p, path)) {
        return scope == Scope::Tools || !path.starts_with("/api/chat/");
    }
    if scope == Scope::Background {
        return method == Method::POST
            && matches!(
                path,
                "/api/protected/automation-results"
                    | "/api/protected/automation-announcements"
                    | "/api/protected/automation-changes"
                    | "/api/protected/catalog/search"
            );
    }
    let paths = match method.as_str() {
        "POST" => POSTS,
        "PUT" => PUTS,
        "DELETE" => DELETES,
        _ => &[],
    };
    if paths.iter().any(|p| matches(p, path)) {
        return true;
    }
    // Device tools can read owned devices and display text, never enroll devices or deploy firmware.
    match path.strip_prefix("/api/device-gateway/api/devices") {
        Some("") => method == Method::GET,
        Some(tail) => {
            let parts: Vec<_> = tail.split('/').collect();
            match parts.as_slice() {
                ["", id, "cmd"] => identifier(id) && method == Method::PUT,
                ["", id, "cmd", request] => {
                    identifier(id) && identifier(request) && method == Method::GET
                }
                _ => false,
            }
        }
        None => false,
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn matches(pattern: &str, path: &str) -> bool {
    let mut parts = path.split('/');
    for expected in pattern.split('/') {
        let Some(actual) = parts.next() else {
            return false;
        };
        let valid = match expected {
            ":id" => {
                actual.parse::<i32>().is_ok_and(|n| n > 0)
                    && actual.bytes().all(|b| b.is_ascii_digit())
            }
            ":job" => {
                actual.len() == 36 && actual.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            }
            _ => actual == expected,
        };
        if !valid {
            return false;
        }
    }
    parts.next().is_none()
}
const READS: &[&str] = &[
    "/api/protected/profile",
    "/api/category",
    "/api/tagone",
    "/api/tagtwo",
    "/api/chat/history",
    "/api/chat/history/text",
    "/api/temp-users",
    "/api/protect/board",
    "/api/protect/board/mine",
    "/api/protect/comments",
    "/api/protect/images/r2",
    "/api/protect/gallery/images",
    "/api/protect/gallery/images/:id",
    "/api/protect/gallery/folders",
    "/api/protect/gallery/articles/:id/cover",
    "/api/protect/image-generation/options",
    "/api/protect/image-generation/articles/:id",
    "/api/protect/image-generation/jobs/:job",
    "/api/protected/articles",
    "/api/protected/accounts",
    "/api/protected/notes/list",
    "/api/protected/talk-actions",
    "/api/protected/todos",
    "/api/protected/todos/item/:id",
    "/api/protected/favorites",
    "/api/protected/notifications",
    "/api/protected/notifications/summary",
    "/api/protected/notifications/announcement",
    "/api/protected/inbox/overview",
    "/api/protected/messages",
    "/api/protected/messages/recent",
    "/api/protected/messages/:id",
    "/api/protected/my/board/page",
    "/api/protected/my/talks",
    "/api/protected/quota",
    "/api/protected/quota/requests",
    "/api/protected/stats/users",
    "/api/protected/stats/notes",
    "/api/protected/stats/notes/periods",
    "/api/protected/moderation/summary",
    "/api/protected/moderation/boards/:id/target",
    "/api/protected/moderation/comments/:id/target",
    "/api/protected/quota/actions/requests/:id",
    "/api/protected/quota/actions/accounts/:id",
    "/api/protected/article-actions/:id",
    "/api/protected/automation-actor",
];
const POSTS: &[&str] = &[
    "/api/protected/notes/search",
    "/api/protected/catalog/search",
    "/api/protected/favorites",
    "/api/protected/messages/read",
    "/api/protected/notifications/read",
    "/api/protected/todos/item",
    "/api/protected/todos/done",
    "/api/protected/todos/date",
    "/api/protected/todos/batch/prepare",
    "/api/protected/quota/actions/requests/:id/review",
    "/api/protected/quota/actions/accounts/:id/reset",
    "/api/protected/moderation/boards/:id/action",
    "/api/protected/moderation/comments/:id/action",
    "/api/protected/article-actions/:id",
    "/api/protected/article-actions/batch",
    "/api/protected/article-actions/batch/prepare",
    "/api/protected/article-tag-actions/:id",
    "/api/protected/article-tag-actions/:id/prepare",
    "/api/protected/article-tag-actions/batch",
    "/api/protected/article-tag-actions/batch/prepare",
    "/api/protected/account-actions",
    "/api/protected/account-actions/prepare",
    "/api/protected/announcement-actions",
    "/api/protected/announcement-actions/prepare",
    "/api/protected/announcement-deletions",
    "/api/protected/announcement-deletions/prepare",
    "/api/protected/article-deletions",
    "/api/protected/article-deletions/prepare",
    "/api/protected/category-actions",
    "/api/protected/category-actions/prepare",
    "/api/protected/tag-actions",
    "/api/protected/tag-actions/prepare",
    "/api/protected/notice-actions",
    "/api/protected/notice-actions/prepare",
    "/api/protected/talk-actions",
    "/api/protected/talk-actions/prepare",
    "/api/protected/notification-deletions",
    "/api/protected/notification-deletions/prepare",
    "/api/protect/gallery/folder-actions",
    "/api/protect/gallery/folder-actions/prepare",
    "/api/protect/image-generation/jobs",
    "/api/protect/image-generation/jobs/:job/approve",
    "/api/protect/image-generation/jobs/:job/accept",
];
const PUTS: &[&str] = &[
    "/api/protect/gallery/images/:id",
    "/api/protect/gallery/articles/:id/cover",
];
const DELETES: &[&str] = &[
    "/api/protected/favorites/:id",
    "/api/protected/todos/item/:id",
    "/api/protected/todos/batch",
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_console_and_unknown_routes_are_denied() {
        for (method, path) in [
            (Method::DELETE, "/api/temp-users/42"),
            (Method::POST, "/api/temp-users/42/status"),
            (Method::POST, "/api/protected/websetting"),
            (Method::DELETE, "/api/protected/notes"),
            (Method::POST, "/api/protect/upload"),
            (Method::PUT, "/api/protected/todos"),
            (Method::GET, "/api/protected/future-secret"),
            (Method::GET, "/api/protected/agent/delegation"),
            (Method::POST, "/api/chat/stream"),
            (Method::PUT, "/api/device-gateway/api/ota/firmware"),
        ] {
            assert!(!allows(Scope::Tools, &method, path), "{method} {path}");
            assert!(!allows(Scope::Background, &method, path));
        }
    }
    #[test]
    fn existing_tools_keep_reads_preparation_and_bound_writes() {
        for (method, path) in [
            (Method::GET, "/api/protected/accounts"),
            (Method::GET, "/api/category"),
            (Method::GET, "/api/chat/history/text"),
            (Method::POST, "/api/protected/account-actions/prepare"),
            (Method::POST, "/api/protected/account-actions"),
            (Method::POST, "/api/protected/article-actions/42"),
            (Method::PUT, "/api/protect/gallery/images/7"),
            (Method::DELETE, "/api/protected/favorites/7"),
            (Method::PUT, "/api/device-gateway/api/devices/desk_1/cmd"),
        ] {
            assert!(allows(Scope::Tools, &method, path), "{method} {path}");
        }
        for path in [
            "/api/protected/article-actions/-1",
            "/api/protected/article-actions/42/anything",
            "/api/protected/article-actions/%34%32",
        ] {
            assert!(!allows(Scope::Tools, &Method::POST, path));
        }
        assert!(!allows(
            Scope::Background,
            &Method::POST,
            "/api/protected/account-actions"
        ));
    }
}
