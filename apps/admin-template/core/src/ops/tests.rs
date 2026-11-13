//! The authorized operations decide and audit the same way for either path
//! (review §8-13, F-1): these call them as Tauri does (`origin: "tauri"`),
//! the path that has no integration tests of its own; `rest/tests.rs`
//! covers the same functions through the routes.

use banto_admin_services::audit::{AuditLogEntry, AuditLogService};
use banto_admin_services::authz::{AuthzService, Capability};
use banto_core::{BantoError, ListParams};
use banto_storage::Db;

use super::{
    budgets, calc_basis, closeouts, closing, fixed_costs, forecasts, orders, pipeline, projects,
    recurring_revenue, reports, Caller, Gate,
};
use crate::budgets::BudgetsService;
use crate::calc_basis::tests::value as calc_value;
use crate::calc_basis::CalcBasisService;
use crate::customers::{CustomerInput, CustomersService};
use crate::forecasts::ForecastsService;
use crate::orders::tests::{conversion, line, ordered_project, pipeline_project, row_version};
use crate::orders::OrdersService;
use crate::pipeline::tests::version as pipeline_version;
use crate::pipeline::PipelineService;
use crate::projects::tests::{fixture, input as project_input};
use crate::projects::ProjectsService;
use crate::users::UsersService;

const ADMIN: i64 = 1;
const PM: i64 = 2;

struct Env {
    db: Db,
    authz: AuthzService,
    audit: AuditLogService,
    forecasts: ForecastsService,
    budgets: BudgetsService,
    customers: CustomersService,
    projects: ProjectsService,
    pipeline: PipelineService,
    calc_basis: CalcBasisService,
    orders: OrdersService,
    users: UsersService,
}

impl Env {
    async fn new() -> Self {
        let db = fixture().await;
        Self {
            authz: AuthzService::new(db.clone()),
            audit: AuditLogService::new(db.clone()),
            forecasts: ForecastsService::new(db.clone()),
            budgets: BudgetsService::new(db.clone()),
            customers: CustomersService::new(db.clone()),
            projects: ProjectsService::new(db.clone()),
            pipeline: PipelineService::new(db.clone()),
            calc_basis: CalcBasisService::new(db.clone()),
            orders: OrdersService::new(db.clone()),
            users: UsersService::new(db.clone()),
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

#[tokio::test]
async fn t09_t06_budget_and_forecast_drafts_are_the_managers_and_audited_with_the_callers_origin() {
    let env = Env::new().await;
    let p = ordered_project(&env.db, "P-F02", vec![line(Some("2026-11"), 1_000_000)]).await;

    // Without capabilities: neither the budget nor the forecast, nor drafts.
    let gate = env.gate(PM);
    assert!(forbidden(budgets::overview(&gate, &env.budgets, p).await));
    assert!(forbidden(
        budgets::create_draft(&gate, &env.budgets, p).await
    ));
    assert!(forbidden(
        forecasts::overview(&gate, &env.forecasts, p).await
    ));
    assert!(forbidden(
        forecasts::summary(&gate, &env.forecasts, p).await
    ));
    assert!(forbidden(
        forecasts::create_draft(&gate, &env.forecasts, p).await
    ));

    // The manager with project.manage and amount.view: a replayed create is
    // audited once, the delete once.
    env.grant(PM, &[Capability::ProjectManage, Capability::AmountView])
        .await;
    assert!(budgets::overview(&gate, &env.budgets, p).await.is_ok());
    assert!(forecasts::overview(&gate, &env.forecasts, p).await.is_ok());
    assert!(forecasts::summary(&gate, &env.forecasts, p).await.is_ok());
    let budget = budgets::create_draft(&gate, &env.budgets, p).await.unwrap();
    assert!(
        budgets::create_draft(&gate, &env.budgets, p)
            .await
            .unwrap()
            .replayed
    );
    let forecast = forecasts::create_draft(&gate, &env.forecasts, p)
        .await
        .unwrap();
    assert!(
        forecasts::create_draft(&gate, &env.forecasts, p)
            .await
            .unwrap()
            .replayed
    );

    // project.manage counts on the projects one manages, not as sales:
    // ADMIN may not edit, delete, approve or adopt the manager's drafts.
    env.grant(ADMIN, &[Capability::ProjectManage, Capability::AmountView])
        .await;
    let other = env.gate(ADMIN);
    assert!(forbidden(
        budgets::delete_draft(&other, &env.budgets, budget.draft.id, 1).await
    ));
    assert!(forbidden(
        budgets::approve(
            &other,
            &env.budgets,
            budget.draft.id,
            crate::budgets::BudgetVersionInput { row_version: 1 },
        )
        .await
    ));
    assert!(forbidden(
        forecasts::delete_draft(&other, &env.forecasts, forecast.draft.id, 1).await
    ));
    assert!(forbidden(
        forecasts::adopt(
            &other,
            &env.forecasts,
            forecast.draft.id,
            crate::forecasts::ForecastVersionInput { row_version: 1 },
        )
        .await
    ));

    budgets::delete_draft(
        &gate,
        &env.budgets,
        budget.draft.id,
        budget.draft.row_version,
    )
    .await
    .unwrap();
    forecasts::delete_draft(
        &gate,
        &env.forecasts,
        forecast.draft.id,
        forecast.draft.row_version,
    )
    .await
    .unwrap();

    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows
        .iter()
        .filter(|r| r.result == "ok")
        .map(|r| (r.resource.as_str(), r.action.as_str(), r.origin.as_str()))
        .collect();
    assert_eq!(writes.len(), 4, "{writes:?}");
    for resource in [crate::budgets::RESOURCE, crate::forecasts::RESOURCE] {
        for action in ["create", "delete"] {
            assert!(
                writes.contains(&(resource, action, "tauri")),
                "{resource} {action}: {writes:?}"
            );
        }
    }
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 9);
    assert!(denied.iter().all(|r| r.origin == "tauri"));
}

#[tokio::test]
async fn t12_t15_the_overall_list_and_reports_follow_the_callers_scopes() {
    let env = Env::new().await;
    let p = ordered_project(&env.db, "P-F03", vec![line(Some("2026-11"), 1_000_000)]).await;
    let row = |portfolio: &crate::portfolio::Portfolio| {
        portfolio
            .rows
            .iter()
            .find(|r| r.project_id == p)
            .map(|r| r.amounts_visible)
    };

    // The manager without amount.view (a company member through
    // time.entry) sees the row, not its amounts, and no monthly figures; the
    // overall list itself is never denied.
    env.grant(PM, &[Capability::TimeEntry]).await;
    let gate = env.gate(PM);
    let list = forecasts::portfolio(&gate, &env.forecasts).await.unwrap();
    assert_eq!(row(&list), Some(false));
    assert!(forbidden(
        reports::project_monthly(&gate, &env.forecasts, p).await
    ));
    assert!(forbidden(
        reports::project_monthly_csv(&gate, &env.forecasts, p).await
    ));

    env.grant(PM, &[Capability::AmountView]).await;
    let list = forecasts::portfolio(&gate, &env.forecasts).await.unwrap();
    assert_eq!(row(&list), Some(true));
    assert!(reports::project_monthly(&gate, &env.forecasts, p)
        .await
        .is_ok());
    reports::project_monthly_csv(&gate, &env.forecasts, p)
        .await
        .unwrap();
    reports::period_monthly_csv(&gate, &env.forecasts, 13)
        .await
        .unwrap();

    // The admin role sees every row without a capability, amounts hidden.
    let admin = env.gate(ADMIN);
    let list = forecasts::portfolio(&admin, &env.forecasts).await.unwrap();
    assert_eq!(row(&list), Some(false));
    let csv = reports::portfolio_csv(&admin, &env.forecasts)
        .await
        .unwrap();
    assert_eq!(csv.row_count, 1);
    reports::period_monthly_csv(&admin, &env.forecasts, 13)
        .await
        .unwrap();

    // Each export is audited once with the caller's origin; reads are not.
    let rows = env.audit_rows().await;
    let exports: Vec<_> = rows.iter().filter(|r| r.result == "ok").collect();
    assert_eq!(exports.len(), 4);
    for row in exports {
        assert_eq!(
            (
                row.action.as_str(),
                row.resource.as_str(),
                row.origin.as_str()
            ),
            ("export", crate::reports::RESOURCE, "tauri")
        );
        assert!(!row.detail.as_deref().unwrap().contains("1000000"));
    }
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 2);
    assert!(denied.iter().all(|r| r.origin == "tauri"));
}

#[tokio::test]
async fn t12_t20_customers_and_projects_follow_the_masters_and_project_scope() {
    let env = Env::new().await;
    let customer = || CustomerInput {
        name: "架空商事".into(),
        active: true,
        note: None,
        row_version: None,
    };

    // The admin role maintains masters and every project's basic
    // information without a capability (spec §4).
    let admin = env.gate(ADMIN);
    let created = projects::customers_create(&admin, &env.customers, customer())
        .await
        .unwrap();
    assert_eq!(
        projects::user_names_list(&admin, &env.users)
            .await
            .unwrap()
            .len(),
        2
    );
    // Not the admin's own: no capability for CreateProject, so a project
    // outside the PM's scope is made through the service.
    assert!(forbidden(
        projects::projects_create(&admin, &env.projects, project_input("P-X01")).await
    ));
    let mut other = project_input("P-X01");
    other.manager_user_id = ADMIN;
    let other = env.projects.create(other, None).await.unwrap();
    assert!(projects::projects_get(&admin, &env.projects, other.id)
        .await
        .is_ok());

    // Without a company membership a business user reads no masters.
    let pm = env.gate(PM);
    assert!(forbidden(
        projects::customers_list(&pm, &env.customers, ListParams::default()).await
    ));
    assert!(forbidden(projects::user_names_list(&pm, &env.users).await));

    // A sales registrant creates a project and becomes its sales owner; the
    // list shows only the caller's projects, and another project is refused.
    env.grant(PM, &[Capability::PipelineEdit]).await;
    let mine = projects::projects_create(&pm, &env.projects, project_input("P-X02"))
        .await
        .unwrap();
    let members = env.authz.project_members(mine.id).await.unwrap();
    assert!(members
        .iter()
        .any(|m| m.user_id == PM && m.kind == banto_admin_services::authz::MemberKind::Sales));
    let list = projects::projects_list(&pm, &env.projects, ListParams::default())
        .await
        .unwrap();
    assert_eq!(
        list.rows.iter().map(|p| p.id).collect::<Vec<_>>(),
        vec![mine.id]
    );
    assert!(forbidden(
        projects::projects_get(&pm, &env.projects, other.id).await
    ));
    let mut change = project_input("P-X01");
    change.manager_user_id = ADMIN;
    change.row_version = Some(other.row_version);
    assert!(forbidden(
        projects::projects_update(&pm, &env.projects, other.id, change).await
    ));
    let mut renamed = customer();
    renamed.row_version = Some(created.row_version);
    projects::customers_update(&pm, &env.customers, created.id, renamed)
        .await
        .unwrap();
    let admin_list = projects::projects_list(&admin, &env.projects, ListParams::default())
        .await
        .unwrap();
    assert_eq!(admin_list.rows.len(), 2);

    // Writes are audited once each with the caller's origin, naming no amounts.
    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows
        .iter()
        .filter(|r| r.result == "ok")
        .map(|r| (r.action.as_str(), r.resource.as_str(), r.origin.as_str()))
        .collect();
    assert_eq!(
        writes,
        vec![
            ("create", "customers", "tauri"),
            ("create", "projects", "tauri"),
            ("update", "customers", "tauri"),
        ]
    );
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 5);
    assert!(denied.iter().all(|r| r.origin == "tauri"));
}

#[tokio::test]
async fn t21_t29_pipeline_versions_are_the_sales_owners_and_audited_without_amounts() {
    let env = Env::new().await;
    env.grant(PM, &[Capability::PipelineEdit]).await;
    let pm = env.gate(PM);
    let project = projects::projects_create(&pm, &env.projects, project_input("P-X03"))
        .await
        .unwrap();

    // The sales owner needs amount.view as well.
    assert!(forbidden(
        pipeline::create_version(
            &pm,
            &env.pipeline,
            project.id,
            pipeline_version("quoting", Some(3_000_000), Some(60)),
        )
        .await
    ));
    env.grant(PM, &[Capability::PipelineEdit, Capability::AmountView])
        .await;
    let saved = pipeline::create_version(
        &pm,
        &env.pipeline,
        project.id,
        pipeline_version("quoting", Some(3_000_000), Some(60)),
    )
    .await
    .unwrap();
    assert_eq!(saved.kind, "adopted");
    let mut alternative = pipeline_version("quoting", Some(3_000_000), Some(60));
    alternative.adopt = false;
    let alternative = pipeline::create_version(&pm, &env.pipeline, project.id, alternative)
        .await
        .unwrap();
    pipeline::adopt(&pm, &env.pipeline, project.id, alternative.id)
        .await
        .unwrap();
    assert_eq!(
        pipeline::versions(&pm, &env.pipeline, project.id)
            .await
            .unwrap()
            .len(),
        2
    );
    let overview = pipeline::overview(&pm, &env.pipeline).await.unwrap();
    assert_eq!(overview.totals.total, 3_000_000);

    // The admin role sees no amounts: refused, and the overview is empty.
    let admin = env.gate(ADMIN);
    assert!(forbidden(
        pipeline::versions(&admin, &env.pipeline, project.id).await
    ));
    let overview = pipeline::overview(&admin, &env.pipeline).await.unwrap();
    assert_eq!(overview.totals.total, 0);

    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows
        .iter()
        .filter(|r| r.resource == "pipeline_versions" && r.result == "ok")
        .collect();
    assert_eq!(
        writes.iter().map(|r| r.action.as_str()).collect::<Vec<_>>(),
        vec!["create", "create", "adopt"]
    );
    for row in writes {
        assert_eq!(row.origin, "tauri");
        assert!(!row.detail.as_deref().unwrap().contains("3000000"));
    }
}

#[tokio::test]
async fn t03_calc_basis_rows_need_the_items_right_and_overrides_the_managers() {
    let env = Env::new().await;
    let project = env
        .projects
        .create(project_input("P-X04"), None)
        .await
        .unwrap();

    // A manager reads the company basis but may not change it.
    env.grant(PM, &[Capability::ProjectManage, Capability::AmountView])
        .await;
    let pm = env.gate(PM);
    calc_basis::company(&pm, &env.calc_basis, "2026-11-01")
        .await
        .unwrap();
    assert!(forbidden(
        calc_basis::company_preview(
            &pm,
            &env.calc_basis,
            calc_value("forecast_rate", "2026-06-01", Some(5_000), "標準"),
        )
        .await
    ));

    // On the managed project the manager overrides an item that allows it,
    // not one that does not (emp_rate).
    let row = calc_basis::project_add(
        &pm,
        &env.calc_basis,
        project.id,
        calc_value("forecast_rate", "2026-12-01", Some(5_500), "外注比率が高い"),
    )
    .await
    .unwrap();
    assert_eq!(row.scope, "project");
    assert!(forbidden(
        calc_basis::project_preview(
            &pm,
            &env.calc_basis,
            project.id,
            calc_value("emp_rate", "2026-12-01", Some(5_500), "個別"),
        )
        .await
    ));
    calc_basis::project(&pm, &env.calc_basis, project.id, "2026-12-01")
        .await
        .unwrap();

    // finance.rate adds the company row.
    env.grant(ADMIN, &[Capability::FinanceRate, Capability::AmountView])
        .await;
    let admin = env.gate(ADMIN);
    calc_basis::company_add(
        &admin,
        &env.calc_basis,
        calc_value("emp_rate", "2026-06-01", Some(5_000), "第13期の単価"),
    )
    .await
    .unwrap();

    // The audit leaves the value out.
    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows
        .iter()
        .filter(|r| r.resource == "calc_basis" && r.result == "ok")
        .collect();
    assert_eq!(
        writes.iter().map(|r| r.action.as_str()).collect::<Vec<_>>(),
        vec!["override", "create"]
    );
    for row in writes {
        assert_eq!(row.origin, "tauri");
        let detail = row.detail.as_deref().unwrap();
        assert!(!detail.contains("5000") && !detail.contains("5500"));
    }
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 2);
}

#[tokio::test]
async fn t23_t24_orders_are_the_owners_recognition_accountings_and_audited_without_reasons() {
    let env = Env::new().await;
    let project = pipeline_project(&env.db, "P-X05", 3_000_000, 60, "2026-12").await;
    let plan = || vec![line(Some("2026-12"), 3_000_000)];

    // The manager needs amount.view as well to convert.
    env.grant(PM, &[Capability::ProjectManage]).await;
    let pm = env.gate(PM);
    let rv = row_version(&env.db, project).await;
    assert!(forbidden(
        orders::convert(&pm, &env.orders, project, conversion(rv, 3_000_000, plan())).await
    ));
    env.grant(PM, &[Capability::ProjectManage, Capability::AmountView])
        .await;
    let converted = orders::convert(&pm, &env.orders, project, conversion(rv, 3_000_000, plan()))
        .await
        .unwrap();
    assert_eq!(converted.confirmed_amount, Some(3_000_000));

    // The manager requests a change and approves it: self-approval is
    // allowed and recorded.
    let requested = orders::request_change(
        &pm,
        &env.orders,
        project,
        crate::orders::ChangeRequest {
            delta_amount: 200_000,
            plan_month: Some("2026-12".into()),
            basis: Some("架空の追加注文".into()),
        },
    )
    .await
    .unwrap();
    let change_id = requested.changes[0].id;
    let decided = orders::decide_change(
        &pm,
        &env.orders,
        project,
        change_id,
        crate::orders::ChangeDecision {
            approve: true,
            note: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(decided.confirmed_amount, Some(3_200_000));
    assert_eq!(
        orders::get(&pm, &env.orders, project)
            .await
            .unwrap()
            .changes[0]
            .status,
        "approved"
    );

    // The outlook is narrowed to the projects whose amounts the caller
    // sees (none for the admin role without amount.view); saving a snapshot
    // needs report.all.
    let outlook = orders::outlook(&pm, &env.orders, Default::default())
        .await
        .unwrap();
    assert_eq!(outlook.totals.ordered_plan, 3_200_000);
    let outlook = orders::outlook(&env.gate(ADMIN), &env.orders, Default::default())
        .await
        .unwrap();
    assert_eq!(outlook.totals.ordered_plan, 0);
    assert!(forbidden(
        orders::save_snapshot(&pm, &env.orders, Some("架空の見通し".into())).await
    ));

    // Recognizing revenue is accounting's, not the manager's.
    let recognition = || crate::orders::RecognitionInput {
        recognized_on: "2026-12-15".into(),
        amount: 1_000_000,
        basis: Some("架空の検収書".into()),
        clears: None,
    };
    assert!(forbidden(
        orders::recognize(&pm, &env.orders, project, recognition()).await
    ));
    env.grant(ADMIN, &[Capability::FinanceClose, Capability::AmountView])
        .await;
    let admin = env.gate(ADMIN);
    let recognized = orders::recognize(&admin, &env.orders, project, recognition())
        .await
        .unwrap();
    let recognition_id = recognized.recognitions[0].id;
    orders::cancel_recognition(
        &admin,
        &env.orders,
        project,
        recognition_id,
        crate::orders::CancelInput {
            reason: Some("架空の取消理由".into()),
        },
    )
    .await
    .unwrap();

    // Writes are audited once each with the caller's origin; no reason or
    // basis reaches the audit.
    let rows = env.audit_rows().await;
    let writes: Vec<_> = rows.iter().filter(|r| r.result == "ok").collect();
    assert_eq!(
        writes
            .iter()
            .map(|r| (r.action.as_str(), r.resource.as_str(), r.origin.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("convert", "orders", "tauri"),
            ("request_change", "orders", "tauri"),
            ("approve_change", "orders", "tauri"),
            ("create", "revenue_recognitions", "tauri"),
            ("cancel", "revenue_recognitions", "tauri"),
        ]
    );
    assert!(writes[2]
        .detail
        .as_deref()
        .unwrap()
        .contains("\"selfApproval\":true"));
    for row in &writes {
        let detail = row.detail.as_deref().unwrap();
        assert!(!detail.contains("架空の"));
    }
    let denied: Vec<_> = rows.iter().filter(|r| r.action == "denied").collect();
    assert_eq!(denied.len(), 3);
    assert!(denied.iter().all(|r| r.origin == "tauri"));
}
