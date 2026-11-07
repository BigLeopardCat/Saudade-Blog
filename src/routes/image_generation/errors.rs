use super::*;

pub enum JobError {
    Invalid(&'static str),
    Conflict(&'static str),
    Missing,
    Unauthorized,
    Database(DbErr),
}

impl From<DbErr> for JobError {
    fn from(error: DbErr) -> Self {
        match error {
            DbErr::RecordNotFound(_) => Self::Missing,
            other => Self::Database(other),
        }
    }
}

impl std::fmt::Debug for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "InvalidImageJob",
            Self::Conflict(_) => "ImageJobConflict",
            Self::Missing => "ImageJobMissing",
            Self::Unauthorized => "UnauthorizedImageJob",
            Self::Database(_) => "ImageJobDatabaseUnavailable",
        })
    }
}

impl IntoResponse for JobError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            Self::Invalid(message) => (StatusCode::BAD_REQUEST, message),
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::Missing => (StatusCode::NOT_FOUND, "生图记录不存在"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "登录状态不可用，请重新登录"),
            Self::Database(error) => {
                tracing::warn!(error=%error, "image job database operation failed");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "生图任务服务暂不可用，请稍后核对",
                )
            }
        };
        (status, Json(ApiResponse::<()>::error(message))).into_response()
    }
}
