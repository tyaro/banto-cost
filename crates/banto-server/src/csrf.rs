//! Custom-header CSRF mitigation (spec §11.2).
//!
//! Browsers only let JS set arbitrary request headers for same-origin or
//! CORS-preflighted requests; a bare cross-site `<form>` POST cannot add
//! `X-Banto-Client`, so requiring it on every `/api` call blocks the classic
//! CSRF vector. This is *belt-and-suspenders* here: every `/api` route also
//! requires a bearer token (`auth::require_auth`), and bearer tokens read
//! from a JS-managed header/storage are not sent automatically by the
//! browser the way cookies are, so CSRF is not really exploitable against
//! this API even without this header. We keep the header check anyway
//! because it is cheap, matches spec §11.2 literally, and guards against
//! any future switch to cookie-based auth forgetting to re-add CSRF
//! protection.

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use banto_core::ErrorBody;

const HEADER_NAME: &str = "x-banto-client";
const HEADER_VALUE: &str = "banto";

fn forbidden_response() -> Response {
    let body = ErrorBody::Other {
        message: "CSRFヘッダがありません".to_string(),
    };
    (StatusCode::FORBIDDEN, Json(body)).into_response()
}

/// Axum middleware: require the `X-Banto-Client: banto` header on every
/// request, otherwise respond `403` with banto-core's [`ErrorBody::Other`].
pub async fn require_banto_client_header(req: Request, next: Next) -> Response {
    let has_header = req
        .headers()
        .get(HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == HEADER_VALUE)
        .unwrap_or(false);

    if has_header {
        next.run(req).await
    } else {
        forbidden_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::middleware;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn router() -> Router {
        Router::new()
            .route("/api/ping", get(|| async { "pong" }))
            .layer(middleware::from_fn(require_banto_client_header))
    }

    #[tokio::test]
    async fn missing_header_is_forbidden() {
        let response = router()
            .oneshot(HttpRequest::get("/api/ping").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn present_header_passes_through() {
        let response = router()
            .oneshot(
                HttpRequest::get("/api/ping")
                    .header("X-Banto-Client", "banto")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
