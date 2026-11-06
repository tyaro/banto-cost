//! `/api/authz/*`, `/api/users/{id}/capabilities` and
//! `/api/projects/{id}/members` (banto-cost P2, ADR-0028): the REST side of
//! capability × project-scope authorization. The Tauri twins are the
//! `authz_*` / `project_members_*` commands in `src-tauri`; both call the
//! same `AuthzService` methods and the same `authorize_audited` guard
//! (conventions §1).
//!
//! Role floors: granting capabilities and assigning project members is
//! system administration (`admin`, design §2.3). Reading one's own grants
//! needs a session only. Reading a project's members needs a session plus
//! either the `admin` role (who maintains the assignment) or
//! `Operation::ViewProject` on that project.

use super::*;
use axum::Extension;
use banto_admin_services::authz::{
    Actor, AuthzService, Capability, MemberKind, Operation, Policy, ProjectMember,
};
use banto_core::BantoError;
use banto_server::AuthenticatedSession;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// The `users.id` of the caller in this database, or `None` when the
/// session has no user row here (a grant session, ADR-0017). Never derived
/// from the username alone when the session carries its account stamp, so a
/// reused username cannot inherit another account's grants.
async fn caller_user_id(
    session: &AuthenticatedSession,
    users: &UsersService,
) -> Result<Option<i64>, BantoError> {
    if session.grant.is_some() {
        return Ok(None);
    }
    if let Some(stamp) = session.stamp {
        return Ok(Some(stamp.account_id));
    }
    Ok(users
        .get_by_username(&session.identity.id)
        .await?
        .map(|user| user.id))
}

#[derive(Clone)]
struct AuthzState {
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
}

/// `GET /api/authz/me`: the caller's own capabilities and memberships.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MyAuthz {
    capabilities: Vec<Capability>,
    memberships: Vec<ProjectMember>,
}

async fn authz_me(
    State(state): State<AuthzState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<MyAuthz>, ApiError> {
    let user_id = caller_user_id(&session, &state.users).await?;
    let subject = state.authz.subject(user_id).await?;
    let memberships = subject
        .memberships
        .iter()
        .flat_map(|(project_id, kinds)| {
            kinds.iter().map(move |kind| ProjectMember {
                project_id: *project_id,
                user_id: user_id.unwrap_or_default(),
                kind: *kind,
            })
        })
        .collect();
    Ok(Json(MyAuthz {
        capabilities: subject.capabilities.into_iter().collect(),
        memberships,
    }))
}

/// `/api/authz/me` (session only, no role floor).
pub(super) fn authz_me_router(
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/authz/me", get(authz_me))
        .with_state(AuthzState {
            authz,
            users,
            audit,
            auth: auth.clone(),
        })
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesBody {
    capabilities: Vec<Capability>,
}

async fn capabilities_get(
    State(state): State<AuthzState>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<Capability>>, ApiError> {
    Ok(Json(state.authz.capabilities(id).await?))
}

async fn capabilities_set(
    State(state): State<AuthzState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<CapabilitiesBody>,
) -> Result<Json<Vec<Capability>>, ApiError> {
    let capabilities = state.authz.set_capabilities(id, &body.capabilities).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "update",
        "capabilities",
        Some(&id.to_string()),
        Some(json!({ "capabilities": capabilities })),
    )
    .await;
    Ok(Json(capabilities))
}

/// `/api/users/{id}/capabilities` (admin).
pub(super) fn capabilities_router(
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route(
            "/api/users/{id}/capabilities",
            get(capabilities_get).put(capabilities_set),
        )
        .with_state(AuthzState {
            authz,
            users,
            audit: audit.clone(),
            auth: auth.clone(),
        })
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "capabilities",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

async fn project_members_list(
    State(state): State<AuthzState>,
    Extension(session): Extension<AuthenticatedSession>,
    Path(project_id): Path<i64>,
) -> Result<Json<Vec<ProjectMember>>, ApiError> {
    let is_admin = Role::from_str(&session.identity.role).is_ok_and(|role| role.is_admin());
    if !is_admin {
        let user_id = caller_user_id(&session, &state.users).await?;
        state
            .authz
            .authorize_audited(
                &state.audit,
                Actor {
                    user_id,
                    username: &session.identity.id,
                    role: &session.identity.role,
                },
                Operation::ViewProject { project_id },
                Policy::default(),
                "project_members",
                "rest",
            )
            .await?;
    }
    Ok(Json(state.authz.project_members(project_id).await?))
}

/// `/api/projects/{id}/members` read (session; admin or project scope).
pub(super) fn project_members_read_router(
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route("/api/projects/{id}/members", get(project_members_list))
        .with_state(AuthzState {
            authz,
            users,
            audit,
            auth: auth.clone(),
        })
        .layer(middleware::from_fn_with_state(auth, require_auth))
}

fn member_from_path(
    project_id: i64,
    user_id: i64,
    kind: &str,
) -> Result<ProjectMember, BantoError> {
    let kind = MemberKind::from_str(kind)
        .map_err(|_| BantoError::BadRequest(format!("unknown member kind: {kind}")))?;
    Ok(ProjectMember {
        project_id,
        user_id,
        kind,
    })
}

/// `PUT /api/projects/{id}/members/{userId}/{kind}`: idempotent add.
async fn project_members_add(
    State(state): State<AuthzState>,
    headers: HeaderMap,
    Path((project_id, user_id, kind)): Path<(i64, i64, String)>,
) -> Result<Json<Vec<ProjectMember>>, ApiError> {
    let member = member_from_path(project_id, user_id, &kind)?;
    state.authz.add_project_member(&member).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "create",
        "project_members",
        Some(&project_id.to_string()),
        Some(json!({ "userId": member.user_id, "kind": member.kind })),
    )
    .await;
    Ok(Json(state.authz.project_members(project_id).await?))
}

async fn project_members_remove(
    State(state): State<AuthzState>,
    headers: HeaderMap,
    Path((project_id, user_id, kind)): Path<(i64, i64, String)>,
) -> Result<StatusCode, ApiError> {
    let member = member_from_path(project_id, user_id, &kind)?;
    state.authz.remove_project_member(&member).await?;
    record_write(
        &state.audit,
        &state.auth,
        &headers,
        "delete",
        "project_members",
        Some(&project_id.to_string()),
        Some(json!({ "userId": member.user_id, "kind": member.kind })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `/api/projects/{id}/members` write (admin).
pub(super) fn project_members_write_router(
    authz: AuthzService,
    users: UsersService,
    audit: AuditLogService,
    auth: AuthState,
) -> Router {
    Router::new()
        .route(
            "/api/projects/{id}/members/{userId}/{kind}",
            axum::routing::put(project_members_add).delete(project_members_remove),
        )
        .with_state(AuthzState {
            authz,
            users,
            audit: audit.clone(),
            auth: auth.clone(),
        })
        .layer(middleware::from_fn_with_state(
            RoleGuard {
                auth: auth.clone(),
                min: Role::Admin,
                resource: "project_members",
                audit,
            },
            require_role_at_least,
        ))
        .layer(middleware::from_fn_with_state(auth, require_auth))
}
