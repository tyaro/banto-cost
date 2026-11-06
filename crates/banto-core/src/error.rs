use serde::Serialize;

/// Unified error type crossing the Tauri/REST boundary.
///
/// `field_errors` carries per-field validation messages so the frontend
/// form store can map them back onto inputs (spec §7.3).
#[derive(Debug, thiserror::Error)]
pub enum BantoError {
    #[error("resource not found: {resource}/{id}")]
    NotFound { resource: String, id: String },

    #[error("validation failed")]
    Validation { field_errors: Vec<FieldError> },

    /// Client-caused malformed request that is not per-field validation:
    /// e.g. an unknown filter column, a non-array operand for an `in`
    /// filter, or an unsupported filter value type (see
    /// `banto-storage`'s `list_query`). Maps to HTTP 400, distinct from
    /// `Validation` (422, form field errors) and `Other` (500, a real
    /// server-side failure the client cannot fix by changing its request).
    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized")]
    Unauthorized,

    /// The caller is authenticated but their role does not permit this
    /// action (spec §10/M10 RBAC), e.g. a `viewer` calling a mutating
    /// endpoint or a non-`admin` calling user-management routes. Distinct
    /// from `Unauthorized` (no/invalid session at all), which is a 401.
    #[error("forbidden")]
    Forbidden,

    #[error("storage error: {0}")]
    Storage(String),

    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

/// Serialized form sent to the frontend. Tauri command handlers and REST
/// handlers must both produce this shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ErrorBody {
    NotFound { resource: String, id: String },
    Validation { field_errors: Vec<FieldError> },
    BadRequest { message: String },
    Unauthorized,
    Forbidden,
    Storage { message: String },
    Other { message: String },
}

impl From<&BantoError> for ErrorBody {
    fn from(err: &BantoError) -> Self {
        match err {
            BantoError::NotFound { resource, id } => ErrorBody::NotFound {
                resource: resource.clone(),
                id: id.clone(),
            },
            BantoError::Validation { field_errors } => ErrorBody::Validation {
                field_errors: field_errors.clone(),
            },
            BantoError::BadRequest(message) => ErrorBody::BadRequest {
                message: message.clone(),
            },
            BantoError::Unauthorized => ErrorBody::Unauthorized,
            BantoError::Forbidden => ErrorBody::Forbidden,
            BantoError::Storage(message) => ErrorBody::Storage {
                message: message.clone(),
            },
            BantoError::Other(message) => ErrorBody::Other {
                message: message.clone(),
            },
        }
    }
}

impl Serialize for BantoError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorBody::from(self).serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The wire shape (`tag = "kind"`, snake_case) is a contract with the
    /// frontend (`packages/admin-core/src/errors.ts` `ErrorBody`). A rename
    /// or a `rename_all` change here would silently break the provider layer;
    /// pin every variant so it fails loudly at test time instead.
    #[test]
    fn error_body_wire_shape_matches_frontend() {
        let cases = [
            (
                BantoError::NotFound {
                    resource: "items".into(),
                    id: "1".into(),
                },
                json!({ "kind": "not_found", "resource": "items", "id": "1" }),
            ),
            (
                BantoError::Validation {
                    field_errors: vec![FieldError {
                        field: "name".into(),
                        message: "required".into(),
                    }],
                },
                json!({
                    "kind": "validation",
                    "field_errors": [{ "field": "name", "message": "required" }],
                }),
            ),
            (
                BantoError::BadRequest("unknown filter field: x".into()),
                json!({ "kind": "bad_request", "message": "unknown filter field: x" }),
            ),
            (BantoError::Unauthorized, json!({ "kind": "unauthorized" })),
            (BantoError::Forbidden, json!({ "kind": "forbidden" })),
            (
                BantoError::Storage("boom".into()),
                json!({ "kind": "storage", "message": "boom" }),
            ),
            (
                BantoError::Other("boom".into()),
                json!({ "kind": "other", "message": "boom" }),
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(serde_json::to_value(&err).unwrap(), expected);
        }
    }
}
