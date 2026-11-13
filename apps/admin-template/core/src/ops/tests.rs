//! The authorized operations decide and audit the same way for either path
//! (review §8-13, F-1): these call them as Tauri does (`origin: "tauri"`),
//! the path that has no integration tests of its own; `rest/tests.rs`
//! covers the same functions through the routes.

use banto_admin_services::audit::{AuditLogEntry, AuditLogService};
use banto_admin_services::authz::{AuthzService, Capability};
use banto_core::{BantoError, ListParams};
use banto_storage::Db;

use super::{closeouts, closing, fixed_costs, recurring_revenue, Caller, Gate};
use crate::forecasts::ForecastsService;
use crate::orders::tests::{line, ordered_project};
use crate::projects::tests::fixture;

const ADMIN: i64 = 1;
const PM: i64 = 2;

struct Env {
    db: Db,
    authz: AuthzService,
    audit: AuditLogService,
    forecasts: ForecastsService,
}

impl Env {
    async fn new() -> Self {
        let db = fixture().await;
        Self {
            authz: AuthzService::new(db.clone()),
            audit: AuditLogService::new(db.clone()),
            forecasts: ForecastsService::new(db.clone()),
            db,
        }
    }

    fn gate(&self, user_id: i64) -> Gate<'_> {
        Gate {
            authz: &self.authz,
            audit: &self.audit,
            caller: Caller {
                user_id: Some(user_id),
                username: if user_id == ADMIN { "admin" } else { "pm" },
                role: if user_id == ADMIN { "admin" } else { "editor" },
                origin: "tauri",
            },
        }
    }

    async fn grant(&self, user_id: i64, caps: &[Capability]) {
        self.authz.set_capabilities(user_id, caps).await.unwrap();
    }

    async fn audit_rows(&self) -> Vec<AuditLogEntry> {
        self.audit.list(ListParams::default()).await.unwrap().rows
    }
}

fn forbidden<T: std::fmt::Debug>(result: Result<T, BantoError>) -> bool {
    matches!(result, Err(BantoError::Forbidden))
}

#[tokio::test]
async fn t11_closing_denials_and_writes_are_audited_with_the_callers_origin() {
    let env = Env::new().await;

    // No capability: refused, and the denial names the path.
    assert!(forbidden(
        closing::months(&env.gate(PM), &env.forecasts).await
    ));
    let rows = env.audit_rows().await;
    let denied = rows.iter().find(|r| r.action == "denied").unwrap();
    assert_eq!(
        (
            denied.resource.as_str(),
            denied.origin.as_str(),
            denied.actor_username.as_deref()
        ),
        ("closing_periods", "tauri", Some("pm"))
    );

    // Accounting closes and reopens: each write is audited once, with the
    // month and the action only (never the reason).
    env.grant(ADMIN, &[Capability::FinanceClose, Capability::AmountView])
        .await;
    let gate = env.gate(ADMIN);
    let closed = closing::close(
        &gate,
        &env.forecasts,
        "2026-10",
        crate::closing::CloseInput { row_version: 1 },
    )
    .await
    .unwrap();
    assert_eq!(closed.status, "closed");
    closing::reopen(
        &gate,
        &env.forecasts,
        "2026-10",
        crate::closing::ReopenInput {
            row_version: closed.row_version,
            reason: "架空の訂正理由".into(),
        },
    )
    .await
    .unwrap();
    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows
        .iter()
        .filter(|r| r.resource == "closing_periods" && r.result == "ok")
        .collect();
    assert_eq!(writes.len(), 2);
    for row in writes {
        assert_eq!(row.origin, "tauri");
        assert_eq!(row.entity_id.as_deref(), Some("2026-10"));
        assert!(!row.detail.as_deref().unwrap().contains("架空の訂正理由"));
    }
    // Reads are not audited.
    closing::months(&gate, &env.forecasts).await.unwrap();
    assert_eq!(
        env.audit_rows()
            .await
            .iter()
            .filter(|r| r.result == "ok")
            .count(),
        2
    );
}

#[tokio::test]
async fn t37_t38_fixed_costs_and_recurring_revenue_ask_for_their_own_capability() {
    let env = Env::new().await;
    let gate = env.gate(PM);

    // finance.rate opens 月額固定原価 only.
    env.grant(PM, &[Capability::FinanceRate, Capability::AmountView])
        .await;
    assert!(fixed_costs::contracts(&gate, &env.forecasts).await.is_ok());
    assert!(fixed_costs::month(&gate, &env.forecasts, "2026-06")
        .await
        .is_ok());
    assert!(forbidden(
        recurring_revenue::agreements(&gate, &env.forecasts).await
    ));
    assert!(forbidden(
        recurring_revenue::recognize_month(&gate, &env.forecasts, "2026-06").await
    ));
    assert!(forbidden(closing::months(&gate, &env.forecasts).await));

    // finance.close opens 定期売上 and 月次締め, not 月額固定原価.
    env.grant(PM, &[Capability::FinanceClose, Capability::AmountView])
        .await;
    assert!(recurring_revenue::agreements(&gate, &env.forecasts)
        .await
        .is_ok());
    assert!(recurring_revenue::month(&gate, &env.forecasts, "2026-06")
        .await
        .is_ok());
    assert!(closing::months(&gate, &env.forecasts).await.is_ok());
    assert!(forbidden(
        fixed_costs::contracts(&gate, &env.forecasts).await
    ));
    assert!(forbidden(
        fixed_costs::post_month(&gate, &env.forecasts, "2026-06").await
    ));

    // Neither without amount.view.
    env.grant(PM, &[Capability::FinanceClose, Capability::FinanceRate])
        .await;
    assert!(forbidden(
        fixed_costs::contracts(&gate, &env.forecasts).await
    ));
    assert!(forbidden(
        recurring_revenue::agreements(&gate, &env.forecasts).await
    ));

    let rows = env.audit_rows().await;
    assert!(rows
        .iter()
        .filter(|r| r.action == "denied")
        .all(|r| r.origin == "tauri"));
    assert!(rows.iter().any(|r| r.resource == "fixed_costs"));
    assert!(rows.iter().any(|r| r.resource == "recurring_revenues"));
}

#[tokio::test]
async fn t17_closeout_check_is_project_scoped_and_settling_needs_the_manager_right() {
    let env = Env::new().await;
    // Managed by PM (projects::tests::input); ADMIN registered it, so it is
    // the project's sales member.
    let p = ordered_project(&env.db, "P-F01", vec![line(Some("2026-11"), 1_000_000)]).await;
    let settle = || -> crate::closeouts::SettleInput {
        serde_json::from_value(serde_json::json!({ "rowVersion": 1 })).unwrap()
    };
    let reopen = || -> crate::closeouts::ReopenInput {
        serde_json::from_value(serde_json::json!({ "rowVersion": 1, "reason": "x" })).unwrap()
    };

    // Without amount.view: no check.
    assert!(forbidden(
        closeouts::get(&env.gate(PM), &env.forecasts, p).await
    ));

    // The manager with amount.view sees the check, but settling and
    // reopening also need project.manage (or finance.close).
    env.grant(PM, &[Capability::AmountView]).await;
    let gate = env.gate(PM);
    let check = closeouts::get(&gate, &env.forecasts, p).await.unwrap();
    assert!(check.closeout.is_none());
    assert!(forbidden(
        closeouts::settle(&gate, &env.forecasts, p, settle()).await
    ));
    assert!(forbidden(
        closeouts::reopen(&gate, &env.forecasts, p, reopen()).await
    ));

    // project.manage counts on the projects one manages, not as sales.
    env.grant(ADMIN, &[Capability::AmountView, Capability::ProjectManage])
        .await;
    let gate = env.gate(ADMIN);
    assert!(closeouts::get(&gate, &env.forecasts, p).await.is_ok());
    assert!(forbidden(
        closeouts::settle(&gate, &env.forecasts, p, settle()).await
    ));

    let rows = env.audit_rows().await;
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 4);
    for row in denied {
        assert_eq!(row.resource, "project_closeouts");
        assert_eq!(row.origin, "tauri");
        assert_eq!(row.entity_id.as_deref(), Some(p.to_string().as_str()));
    }
    assert!(rows.iter().all(|r| r.result != "ok"));
}
