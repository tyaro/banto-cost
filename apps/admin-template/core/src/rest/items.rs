use super::*;

/// Per-row byte budget backing `items_write_router`'s import
/// `DefaultBodyLimit` (spec M15 / M-review 2026-08 M-14). Same two-tier
/// reasoning as `ATTACHMENT_BODY_LIMIT_SLACK_BYTES`: the limit that actually
/// matters is the service-layer row-count check in `ItemsService::import`
/// (`crate::items::MAX_IMPORT_ROWS`, which returns a `422` `Validation`
/// error), NOT this transport cap. This only needs to sit comfortably above
/// the largest spec-valid `MAX_IMPORT_ROWS`-row JSON payload so a request AT
/// the row-count limit reaches the service layer (a `200`/`422`) instead of
/// being rejected by axum's 2MB transport default (a `413`) first. A single
/// spec-valid row is at most ~230 wire bytes (a 40-char name, three small
/// integers, a `null` id); 1KiB/row is a comfortable round budget over that.
const IMPORT_BODY_LIMIT_BYTES_PER_ROW: usize = 1024;

async fn items_list(
    State(items): State<ItemsService>,
    Json(params): Json<ListParams>,
) -> Result<Json<ListResult<Item>>, ApiError> {
    Ok(Json(items.list(params).await?))
}

async fn items_get(
    State(items): State<ItemsService>,
    Path(id): Path<i64>,
) -> Result<Json<Item>, ApiError> {
    Ok(Json(items.get(id).await?))
}

/// State for the `items` WRITE handlers (spec M14): `ItemsService` for the
/// mutation itself, plus `AuditLogService`/`AuthState` so each handler can
/// record a `create`/`update`/`delete` entry once the mutation has already
/// succeeded (read handlers - `items_list`/`items_get` above - stay on the
/// plain `State<ItemsService>` they always had; spec M14: "読み取り系は記録
/// しない"). `attachments` is M20 unit C's demo wiring (spec
/// `docs/design/attachments-plan.md` §3.8): `items_delete` uses it to clean up any
/// attachments left pointing at the now-gone record.
#[derive(Clone)]
struct ItemsWriteState {
    items: ItemsService,
    audit: AuditLogService,
    auth: AuthState,
}

async fn items_create(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let item = state.items.create(input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "items",
        Some(&item.id.to_string()),
        Some(json!({ "name": item.name })),
    )
    .await;
    Ok(Json(item))
}

async fn items_update(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<ItemInput>,
) -> Result<Json<Item>, ApiError> {
    let item = state.items.update(id, input).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "items",
        Some(&item.id.to_string()),
        Some(json!({ "name": item.name })),
    )
    .await;
    Ok(Json(item))
}

async fn items_delete(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    state.items.delete(id).await?;

    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "items",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/items/import` (spec M15): bulk create/update, `editor`+
/// (same `ItemsWriteState`/`RoleGuard` as `items_create`/`update`/`delete`
/// above). Unlike those, a single `action: "import"` audit entry is written
/// here directly (not via [`record_write`], which always writes
/// `result: "ok"` against a single concrete `entity_id`) - see this module's
/// doc comment ("Audit log" section) for why the result/detail depend on
/// whether [`ItemsService::import`] rolled the batch back.
async fn items_import(
    State(state): State<ItemsWriteState>,
    headers: HeaderMap,
    Json(rows): Json<Vec<ItemImportRow>>,
) -> Result<Json<ImportResult>, ApiError> {
    let result = state.items.import(rows).await?;
    let identity = actor_identity(&headers, &state.auth);
    let (result_tag, detail) = if result.errors.is_empty() {
        (
            "ok",
            json!({ "created": result.created, "updated": result.updated }),
        )
    } else {
        ("failed", json!({ "errorCount": result.errors.len() }))
    };
    state
        .audit
        .record(AuditEntry {
            actor_username: identity.as_ref().map(|i| i.id.as_str()),
            actor_role: identity.as_ref().map(|i| i.role.as_str()),
            action: "import",
            resource: "items",
            entity_id: None,
            detail: Some(detail),
            origin: "rest",
            result: result_tag,
        })
        .await;
    Ok(Json(result))
}

/// Read-only `items` routes (spec M10: `viewer` and up - i.e. any
/// authenticated role, `require_auth` alone is sufficient).
fn items_read_router(items: ItemsService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/items/list", post(items_list))
        .route("/api/items/{id}", get(items_get))
        .with_state(items)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// Mutating `items` routes (spec M10: `editor` and up). Layered
/// `require_role_at_least` first, `require_auth` second, so middleware
/// executes `require_auth` THEN `require_role_at_least` (axum layers run
/// outside-in from the last one added) - a request must have a valid
/// session before its role is even considered.
///
/// `DefaultBodyLimit::max` also raises this router's body cap past axum's 2MB
/// default to `MAX_IMPORT_ROWS * IMPORT_BODY_LIMIT_BYTES_PER_ROW` (spec
/// M-review 2026-08 M-14), so a spec-valid `/api/items/import` payload AT the
/// row-count limit reaches the service layer (a `422` row-count error)
/// instead of being rejected by the transport cap (a `413`) first - same
/// two-tier reasoning as `attachments_write_router`/`backups_router`. The
/// create/update routes on this router carry only a small single-item JSON
/// body, so the raised cap is harmless for them.
fn items_write_router(items: ItemsService, audit: AuditLogService, auth: AuthState) -> Router {
    let state = ItemsWriteState {
        items,
        audit: audit.clone(),
        auth: auth.clone(),
    };
    Router::new()
        .route("/api/items", post(items_create))
        .route(
            "/api/items/{id}",
            axum::routing::put(items_update).delete(items_delete),
        )
        .route("/api/items/import", post(items_import))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(
            crate::items::MAX_IMPORT_ROWS * IMPORT_BODY_LIMIT_BYTES_PER_ROW,
        ))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "items",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// `/api/items/*` (spec M10): merges the read (any role) and write
/// (`editor`+) sub-routers, which share the same `/api/items/{id}` path
/// split across HTTP methods.
pub(super) fn items_router(items: ItemsService, audit: AuditLogService, auth: AuthState) -> Router {
    items_read_router(items.clone(), auth.clone()).merge(items_write_router(items, audit, auth))
}
