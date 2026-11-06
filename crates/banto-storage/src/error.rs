//! Maps `sqlx::Error` onto `banto_core::BantoError` so the service layer
//! (app domain crates, Tauri commands, REST handlers) only ever has to deal
//! with the one unified error type crossing the Tauri/REST boundary
//! (spec §10).

use banto_core::BantoError;

/// Map a generic `sqlx::Error` to `BantoError::Storage`.
///
/// Use [`not_found`] instead when the error is a `sqlx::Error::RowNotFound`
/// for a specific resource/id, so the caller gets a proper
/// `BantoError::NotFound` (with resource/id context) instead of an opaque
/// storage error.
pub fn storage_error(err: sqlx::Error) -> BantoError {
    BantoError::Storage(err.to_string())
}

/// Map a `sqlx::Error` that occurred while looking up a specific
/// `resource`/`id` pair. `sqlx::Error::RowNotFound` becomes
/// `BantoError::NotFound { resource, id }`; anything else becomes
/// `BantoError::Storage`.
pub fn not_found(
    err: sqlx::Error,
    resource: impl Into<String>,
    id: impl Into<String>,
) -> BantoError {
    match err {
        sqlx::Error::RowNotFound => BantoError::NotFound {
            resource: resource.into(),
            id: id.into(),
        },
        other => storage_error(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_not_found_maps_to_banto_not_found_with_context() {
        let err = not_found(sqlx::Error::RowNotFound, "items", "42");
        match err {
            BantoError::NotFound { resource, id } => {
                assert_eq!(resource, "items");
                assert_eq!(id, "42");
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn other_sqlx_errors_map_to_storage() {
        let err = storage_error(sqlx::Error::PoolClosed);
        match err {
            BantoError::Storage(message) => assert!(!message.is_empty()),
            other => panic!("expected Storage, got {other:?}"),
        }
    }

    #[test]
    fn non_row_not_found_via_not_found_helper_maps_to_storage() {
        let err = not_found(sqlx::Error::PoolClosed, "items", "1");
        assert!(matches!(err, BantoError::Storage(_)));
    }
}
