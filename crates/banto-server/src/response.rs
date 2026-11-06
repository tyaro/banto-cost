//! `BantoError` -> HTTP response mapping (spec §10, §11.1).
//!
//! Generic and app-agnostic: any resource's service layer returns
//! `Result<T, BantoError>`, and REST handlers (defined in app crates such as
//! `admin-template-core::rest`) can `?`-propagate straight into an
//! `ApiError`, matching the pattern already used by Tauri command handlers.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use banto_core::{BantoError, ErrorBody};

/// Wraps a [`BantoError`] so it can be returned directly from an axum
/// handler (`Result<Json<T>, ApiError>`); the `?` operator on a
/// `Result<_, BantoError>` converts automatically via [`From`].
pub struct ApiError(pub BantoError);

impl From<BantoError> for ApiError {
    fn from(err: BantoError) -> Self {
        ApiError(err)
    }
}

fn status_for(err: &BantoError) -> StatusCode {
    match err {
        BantoError::NotFound { .. } => StatusCode::NOT_FOUND,
        BantoError::Validation { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        BantoError::BadRequest(_) => StatusCode::BAD_REQUEST,
        BantoError::Unauthorized => StatusCode::UNAUTHORIZED,
        BantoError::Forbidden => StatusCode::FORBIDDEN,
        BantoError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
        BantoError::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = status_for(&self.0);
        let body = ErrorBody::from(&self.0);
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_core::FieldError;

    #[test]
    fn status_codes_match_error_kinds() {
        assert_eq!(
            status_for(&BantoError::NotFound {
                resource: "items".to_string(),
                id: "1".to_string()
            }),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status_for(&BantoError::Validation {
                field_errors: vec![FieldError {
                    field: "name".to_string(),
                    message: "required".to_string()
                }]
            }),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            status_for(&BantoError::BadRequest("unknown filter field".to_string())),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status_for(&BantoError::Unauthorized),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(status_for(&BantoError::Forbidden), StatusCode::FORBIDDEN);
        assert_eq!(
            status_for(&BantoError::Storage("boom".to_string())),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            status_for(&BantoError::Other("boom".to_string())),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
