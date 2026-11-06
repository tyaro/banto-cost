use super::*;

// --- M20: attachments -------------------------------------------------------

/// `POST /api/attachments/list` request body (attachments-plan §3.5): `{resource,
/// resourceId}` - deliberately its own tiny struct rather than two loose
/// `Query`/`Path` extractors, mirroring why `items_list` takes a JSON body
/// too (a record's `(resource, resourceId)` pair is conceptually one
/// value, not two independent path segments).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentsListRequest {
    resource: String,
    resource_id: String,
}

async fn attachments_list(
    State(attachments): State<AttachmentsService>,
    Json(params): Json<AttachmentsListRequest>,
) -> Result<Json<Vec<AttachmentMeta>>, ApiError> {
    Ok(Json(
        attachments
            .list_for_record(&params.resource, &params.resource_id)
            .await?,
    ))
}

/// RFC 5987 `attr-char` set: the characters `filename*=UTF-8''...` may carry
/// unescaped. Everything else (including every non-ASCII byte) is
/// percent-encoded. No dependency added for this - the alphabet is small
/// and fixed, spec convention (this workspace does not add a dependency for
/// something a dozen lines of code can do, see `banto_attachments`'s own
/// `image`-dependency doc comment for the contrasting case where it does).
fn is_rfc5987_attr_char(byte: u8) -> bool {
    matches!(byte,
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
        | b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
}

fn rfc5987_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if is_rfc5987_attr_char(*byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Build a `Content-Disposition: attachment` header value carrying BOTH an
/// ASCII-safe `filename=` (for clients that only understand the legacy
/// form) and an RFC 5987 `filename*=UTF-8''...` (for everything else,
/// including any non-ASCII original name - attachments-plan §3.3: `file_name` is
/// user-supplied display text, never a filesystem path, but it still needs
/// to survive round-tripping through an HTTP header safely). The ASCII
/// fallback replaces anything non-ASCII, a quote, a backslash, or a control
/// character with `_` - it only has to be SOME safe placeholder, since a
/// `filename*`-aware client (which is effectively all of them) prefers the
/// RFC 5987 form anyway.
fn content_disposition_header_value(file_name: &str) -> String {
    let ascii_fallback: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' && !c.is_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ascii_fallback = if ascii_fallback.is_empty() {
        "attachment".to_string()
    } else {
        ascii_fallback
    };
    format!(
        "attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{}",
        rfc5987_encode(file_name)
    )
}

/// `GET /api/attachments/{id}/download` (attachments-plan §3.5): full attachment body.
/// `mime` is always the server-detected value from `AttachmentsService::upload`
/// (attachments-plan §3.4), never client-supplied. Not audited - "read routes are never
/// audited" (see this module's doc comment).
async fn attachments_download(
    State(attachments): State<AttachmentsService>,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let (meta, bytes) = attachments.read_body(id).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, meta.mime)
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            content_disposition_header_value(&meta.file_name),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

/// `GET /api/attachments/{id}/thumbnail` (attachments-plan §3.5): JPEG thumbnail bytes,
/// or a `NotFound` (-> `404`) when the attachment has none -
/// `AttachmentsService::read_thumbnail`'s doc comment covers why "no such
/// attachment" and "attachment exists but has no thumbnail" are not
/// distinguished here.
async fn attachments_thumbnail(
    State(attachments): State<AttachmentsService>,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let bytes = attachments.read_thumbnail(id).await?;
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .body(axum::body::Body::from(bytes))
        .map_err(|err| ApiError(BantoError::Other(err.to_string())))?;
    Ok(response)
}

/// Read-only `attachments` routes (attachments-plan §3.5: `viewer` and up, same RBAC
/// floor as `items_read_router`).
fn attachments_read_router(attachments: AttachmentsService, auth: AuthState) -> Router {
    Router::new()
        .route("/api/attachments/list", post(attachments_list))
        .route("/api/attachments/{id}/download", get(attachments_download))
        .route(
            "/api/attachments/{id}/thumbnail",
            get(attachments_thumbnail),
        )
        .with_state(attachments)
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// State for the `attachments` WRITE handlers (attachments-plan §3.5): `AttachmentsService`
/// for the mutation itself, `AuditLogService`/`AuthState` for the same
/// once-the-mutation-succeeded audit-record pattern every other write
/// handler in this module uses, and `events` (spec: `banto_attachments` has
/// no `ServerEvent` awareness by design - see this module's doc comment) so
/// [`attachments_upload`]/[`attachments_delete`] can broadcast
/// `ResourceChanged` themselves.
#[derive(Clone)]
struct AttachmentsWriteState {
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
}

/// Broadcast `ServerEvent::ResourceChanged { resource: "attachments" }`
/// (spec §3.5 mirrors `ItemsService::notify_changed`'s "no receiver is not
/// an error" convention - `send` returning `Err` just means nobody is
/// currently subscribed).
fn notify_attachments_changed(events: &broadcast::Sender<ServerEvent>) {
    let _ = events.send(ServerEvent::ResourceChanged {
        resource: "attachments".to_string(),
    });
}

fn attachment_audit_detail(meta: &AttachmentMeta) -> serde_json::Value {
    json!({
        "fileName": meta.file_name,
        "sizeBytes": meta.size_bytes,
        "parentResource": meta.resource,
        "parentId": meta.resource_id,
    })
}

/// `POST /api/attachments?resource=&resourceId=&fileName=` query parameters
/// (attachments-plan §3.5). Metadata rides the query string, not the body, since the
/// body is the raw file bytes (same "no multipart dependency" shape as
/// `POST /api/backups/restore`'s `?fileName=`, see this module's doc
/// comment) - unlike that route, `fileName` here is load-bearing (it
/// becomes `AttachmentMeta.file_name`), not just an audit-detail string.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadQuery {
    resource: String,
    resource_id: String,
    file_name: String,
}

async fn attachments_upload(
    State(state): State<AttachmentsWriteState>,
    headers: HeaderMap,
    Query(query): Query<AttachmentUploadQuery>,
    body: Bytes,
) -> Result<Json<AttachmentMeta>, ApiError> {
    let created_by = actor_identity(&headers, &state.auth).map(|identity| identity.id);
    let meta = state
        .attachments
        .upload(NewAttachment {
            resource: query.resource,
            resource_id: query.resource_id,
            file_name: query.file_name,
            created_by,
            bytes: body.to_vec(),
        })
        .await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "attachments",
        Some(&meta.id.to_string()),
        Some(attachment_audit_detail(&meta)),
    )
    .await;
    notify_attachments_changed(&state.events);
    Ok(Json(meta))
}

async fn attachments_delete(
    State(state): State<AttachmentsWriteState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let meta = state.attachments.delete(id).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "attachments",
        Some(&id.to_string()),
        Some(attachment_audit_detail(&meta)),
    )
    .await;
    notify_attachments_changed(&state.events);
    Ok(StatusCode::NO_CONTENT)
}

/// Mutating `attachments` routes (attachments-plan §3.5: `editor` and up, same RBAC
/// floor as `items_write_router`). `DefaultBodyLimit::max` caps the upload
/// route at `MAX_ATTACHMENT_BYTES` (+ [`ATTACHMENT_BODY_LIMIT_SLACK_BYTES`]);
/// the other route here (`DELETE`) has no meaningful request body, so this
/// is harmless for it (same reasoning as [`backups_router`]'s limit layer).
fn attachments_write_router(
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    let state = AttachmentsWriteState {
        attachments,
        audit: audit.clone(),
        auth: auth.clone(),
        events,
    };
    Router::new()
        .route("/api/attachments", post(attachments_upload))
        .route(
            "/api/attachments/{id}",
            axum::routing::delete(attachments_delete),
        )
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_ATTACHMENT_BYTES + ATTACHMENT_BODY_LIMIT_SLACK_BYTES,
        ))
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Editor,
                resource: "attachments",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

/// `/api/attachments/*` (attachments-plan §3.5): merges the read (any role) and write
/// (`editor`+) sub-routers, mirroring [`items_router`].
pub(super) fn attachments_router(
    attachments: AttachmentsService,
    audit: AuditLogService,
    auth: AuthState,
    events: broadcast::Sender<ServerEvent>,
) -> Router {
    attachments_read_router(attachments.clone(), auth.clone()).merge(attachments_write_router(
        attachments,
        audit,
        auth,
        events,
    ))
}
