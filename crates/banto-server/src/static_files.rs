//! Static asset serving / SPA fallback (spec §11.1).
//!
//! The embedded SvelteKit build is injected via the [`UiAssets`] trait so
//! this crate never depends on `rust-embed` (or the `embed-ui` feature)
//! directly - the concrete embedding lives in `admin-template-core::assets`,
//! which is the only crate that knows the frontend build's location on
//! disk. This keeps `banto-server` resource/app-agnostic.

use std::borrow::Cow;

use axum::body::Body;
use axum::http::{header, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use banto_core::ErrorBody;

/// Injection point for embedded frontend assets. Implementors are
/// zero-sized types (the data lives in a `rust-embed`-generated `static`, or
/// a hardcoded placeholder) so `get` is an associated function, not a
/// method - no instance needs to be constructed or stored in router state.
pub trait UiAssets {
    /// Look up `path` (no leading slash, e.g. `"index.html"`,
    /// `"_app/immutable/chunks/foo.js"`). Returns the MIME type and file
    /// bytes if present.
    fn get(path: &str) -> Option<(String, Cow<'static, [u8]>)>;
}

/// Basic MIME mapping by file extension (spec §11.1). Kept intentionally
/// small: only the extensions a SvelteKit static build produces.
pub fn guess_mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" => "application/json",
        // PWA manifest (M-review 2026-08 §2.8): without this arm the embedded
        // LAN server would serve `manifest.webmanifest` as octet-stream and the
        // browser would ignore it, so the install prompt never appears.
        "webmanifest" => "application/manifest+json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn respond(mime: String, bytes: Cow<'static, [u8]>) -> Response {
    (
        [(header::CONTENT_TYPE, mime)],
        Body::from(bytes.into_owned()),
    )
        .into_response()
}

/// `/api` itself or anything under `/api/`. `/apiary` and the like are SPA
/// routes, not API paths.
fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// HEAD needs no handling here: axum's router strips the body of a HEAD
/// response itself (for any handler, `fallback` included) and sets
/// `Content-Length` from the would-be body - pinned by
/// `head_matches_get_headers_with_empty_body`.
async fn serve_asset<A: UiAssets>(method: Method, uri: Uri) -> Response {
    // An `/api` request that no API route matched must not fall through to the
    // SPA fallback: that answered 200 with `index.html`, so a caller with a
    // mistyped or stale endpoint got HTML instead of an error (banto-industrial
    // #547). Answer a JSON 404 in the same `ErrorBody` shape as every other
    // REST error, for any method.
    if is_api_path(uri.path()) {
        let body = ErrorBody::NotFound {
            resource: "api".to_string(),
            id: uri.path().to_string(),
        };
        return (StatusCode::NOT_FOUND, Json(body)).into_response();
    }

    // The assets/SPA fallback is read-only (the router used `get`, which also
    // serves HEAD): keep answering other methods with 405.
    if method != Method::GET && method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET,HEAD")],
        )
            .into_response();
    }

    let path = uri.path().trim_start_matches('/');
    let lookup = if path.is_empty() { "index.html" } else { path };

    if let Some((mime, bytes)) = A::get(lookup) {
        return respond(mime, bytes);
    }

    // SPA fallback: any unknown non-`/api` path (e.g. `/items/42`, a
    // client-side route) serves `index.html` so SvelteKit's router can take
    // over client-side.
    if let Some((mime, bytes)) = A::get("index.html") {
        return respond(mime, bytes);
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Build a fallback router serving embedded assets (or, with `A` being the
/// placeholder impl, a single built-in page) for any path not otherwise
/// routed. Mount this *after* the `/api/*` routes so those take priority.
///
/// Unmatched `/api` requests (`/api` or `/api/...`) get a JSON `404`
/// ([`ErrorBody::NotFound`]) instead of the SPA's `index.html`. It lives here
/// rather than in each app's `api_router` so every consumer that merges this
/// router gets it with no extra wiring.
pub fn static_router<A: UiAssets + Send + Sync + 'static>() -> Router {
    Router::new().fallback(serve_asset::<A>)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeAssets;

    impl UiAssets for FakeAssets {
        fn get(path: &str) -> Option<(String, Cow<'static, [u8]>)> {
            match path {
                "index.html" => Some((
                    "text/html; charset=utf-8".to_string(),
                    Cow::Borrowed(b"<html>index</html>"),
                )),
                "app.js" => Some((
                    guess_mime("app.js").to_string(),
                    Cow::Borrowed(b"console.log(1)"),
                )),
                _ => None,
            }
        }
    }

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    #[tokio::test]
    async fn unknown_spa_route_serves_index_html() {
        let router = static_router::<FakeAssets>();
        let response = router
            .oneshot(HttpRequest::get("/items/42").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("index"));
    }

    #[tokio::test]
    async fn head_matches_get_headers_with_empty_body() {
        let router = static_router::<FakeAssets>();
        for uri in ["/app.js", "/settings/foo", "/api/x"] {
            let get = router
                .clone()
                .oneshot(HttpRequest::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let head = router
                .clone()
                .oneshot(HttpRequest::head(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(head.status(), get.status(), "{uri}");
            assert_eq!(
                head.headers().get(header::CONTENT_TYPE),
                get.headers().get(header::CONTENT_TYPE),
                "{uri}"
            );
            let get_body = axum::body::to_bytes(get.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                head.headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok()),
                Some(get_body.len().to_string().as_str()),
                "{uri}"
            );
            let head_body = axum::body::to_bytes(head.into_body(), usize::MAX)
                .await
                .unwrap();
            assert!(head_body.is_empty(), "{uri}");
        }
    }

    async fn status_and_type(
        router: Router,
        method: &str,
        uri: &str,
    ) -> (StatusCode, String, Vec<u8>) {
        let response = router
            .oneshot(
                HttpRequest::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let ct = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, ct, bytes.to_vec())
    }

    #[tokio::test]
    async fn unknown_api_path_is_json_404_not_index_html() {
        for uri in ["/api/x", "/api/collect/status", "/api", "/api/"] {
            let (status, ct, bytes) =
                status_and_type(static_router::<FakeAssets>(), "GET", uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert!(ct.starts_with("application/json"), "{uri}: {ct}");
            let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(v["kind"], "not_found", "{uri}");
        }
    }

    #[tokio::test]
    async fn unknown_api_path_is_404_for_other_methods() {
        for method in ["POST", "PUT", "DELETE", "HEAD"] {
            let (status, _, _) =
                status_and_type(static_router::<FakeAssets>(), method, "/api/x").await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        }
    }

    #[tokio::test]
    async fn api_like_prefix_and_nested_spa_route_still_serve_index_html() {
        for uri in ["/apiary", "/settings/foo", "/settings/api/x"] {
            let (status, ct, bytes) =
                status_and_type(static_router::<FakeAssets>(), "GET", uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert!(ct.starts_with("text/html"), "{uri}");
            assert!(String::from_utf8_lossy(&bytes).contains("index"));
        }
    }

    #[tokio::test]
    async fn real_api_route_wins_over_the_404_fallback() {
        let router = Router::new()
            .route("/api/ping", axum::routing::get(|| async { "pong" }))
            .merge(static_router::<FakeAssets>());
        let (status, _, bytes) = status_and_type(router.clone(), "GET", "/api/ping").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"pong");
        let (status, ct, _) = status_and_type(router, "GET", "/api/pong").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(ct.starts_with("application/json"));
    }

    #[tokio::test]
    async fn non_read_method_on_spa_path_is_405() {
        let (status, _, _) =
            status_and_type(static_router::<FakeAssets>(), "POST", "/settings/foo").await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn known_asset_gets_correct_mime() {
        let router = static_router::<FakeAssets>();
        let response = router
            .oneshot(HttpRequest::get("/app.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/javascript; charset=utf-8")
        );
    }

    #[test]
    fn mime_mapping_covers_expected_extensions() {
        assert_eq!(guess_mime("index.html"), "text/html; charset=utf-8");
        assert_eq!(guess_mime("app.js"), "text/javascript; charset=utf-8");
        assert_eq!(guess_mime("style.css"), "text/css; charset=utf-8");
        assert_eq!(guess_mime("logo.svg"), "image/svg+xml");
        assert_eq!(guess_mime("logo.png"), "image/png");
        assert_eq!(guess_mime("favicon.ico"), "image/x-icon");
        assert_eq!(guess_mime("manifest.json"), "application/json");
        assert_eq!(
            guess_mime("manifest.webmanifest"),
            "application/manifest+json"
        );
        assert_eq!(guess_mime("font.woff2"), "font/woff2");
        assert_eq!(guess_mime("unknown.bin"), "application/octet-stream");
    }
}
