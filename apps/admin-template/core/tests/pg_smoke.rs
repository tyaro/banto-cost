//! App-layer PostgreSQL smoke test (V2 "PostgreSQL アプリ全体対応", PR3).
//!
//! This is the first place the whole app service stack is exercised against a
//! real PostgreSQL server: `init_db_from_target` runs `migrations-postgres`,
//! then the core services (`users`/`settings`/`audit`) perform representative CRUD. It proves the strict-typed Postgres
//! DDL and the service layer's Postgres enum-dispatch arms actually work
//! end-to-end - not just that they compile (which PR2 already guaranteed).
//!
//! Gated two ways so it never breaks a PostgreSQL-less build:
//! - The whole file is `#![cfg(feature = "postgres")]`, so a default
//!   (SQLite-only) build does not even compile it.
//! - At runtime it early-returns unless `BANTO_TEST_PG_URL` is set, so a local
//!   `cargo test --features postgres` with no server still passes. CI's
//!   `app-postgres` job sets the env var against a `postgres:16` service
//!   container (mirroring the existing `storage-postgres` job).
#![cfg(feature = "postgres")]

use admin_template_core::audit::{AuditEntry, AuditLogService};
use admin_template_core::backup::BackupService;
use admin_template_core::db::init_db_from_target;
use admin_template_core::settings::SettingsService;
use admin_template_core::users::{Role, UsersService};
use banto_core::ListParams;
use std::path::PathBuf;

/// Drop every table this app owns (plus sqlx's migration bookkeeping) so the
/// smoke test starts from a clean schema even if a previous run left state
/// behind. `CASCADE` also drops the identity sequences. Uses the public
/// `connect_postgres` helper to get a raw pool for the DDL.
async fn reset_schema(url: &str) {
    let pool = banto_storage::connect_postgres(url)
        .await
        .expect("connect for schema reset");
    for stmt in [
        // banto-cost P4d and later (orders, direct costs, forecasts,
        // closeouts, the monthly close, fixed costs, recurring revenue).
        "DROP TABLE IF EXISTS recurring_revenues, fixed_cost_postings, fixed_cost_contracts \
         CASCADE",
        "DROP TABLE IF EXISTS closing_snapshot_rows, closing_events, closing_periods CASCADE",
        "DROP TABLE IF EXISTS closeout_reopenings, closeout_waivers, project_closeouts CASCADE",
        "DROP TABLE IF EXISTS forecast_lines, forecast_versions CASCADE",
        "DROP TABLE IF EXISTS cost_allocations, direct_costs, purchase_order_changes, \
         purchase_orders, vendors CASCADE",
        "DROP TABLE IF EXISTS budget_lines, budget_versions CASCADE",
        "DROP TABLE IF EXISTS time_entries, phases, common_activities CASCADE",
        "DROP TABLE IF EXISTS calc_values, calc_items CASCADE",
        "DROP TABLE IF EXISTS outlook_snapshot_rows, outlook_snapshots, revenue_clearings, \
         revenue_recognitions, revenue_plan, order_changes, order_conversions CASCADE",
        "DROP TABLE IF EXISTS pipeline_revenue_plan, pipeline_versions, projects, customers, \
         project_members, user_capabilities CASCADE",
        "DROP TABLE IF EXISTS attachments, audit_log, users, settings, items CASCADE",
        "DROP TABLE IF EXISTS _sqlx_migrations",
    ] {
        sqlx::query(stmt)
            .execute(&pool)
            .await
            .expect("drop for reset");
    }
    pool.close().await;
}

#[tokio::test]
async fn app_layer_crud_round_trips_on_postgres() {
    let Ok(url) = std::env::var("BANTO_TEST_PG_URL") else {
        eprintln!("pg_smoke: BANTO_TEST_PG_URL unset - skipping (no PostgreSQL server)");
        return;
    };

    reset_schema(&url).await;

    // Issue #204: start from the pre-0007 schema with an existing account, so
    // `init_db_from_target` below exercises the in-place upgrade.
    {
        let pool = banto_storage::connect_postgres(&url)
            .await
            .expect("connect for the pre-#204 schema");
        sqlx::migrate!("./migrations-postgres")
            .run_to(6, &pool)
            .await
            .expect("pre-#204 schema");
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, role) \
             VALUES ('existing', 'unused', 'Existing', 'admin')",
        )
        .execute(&pool)
        .await
        .expect("pre-#204 account");
        pool.close().await;
    }

    // migrations-postgres (no demo seed in banto-cost).
    let db = init_db_from_target(&url)
        .await
        .expect("init_db_from_target should run migrations-postgres");
    let existing = UsersService::new(db.clone())
        .get_by_username("existing")
        .await
        .expect("users get_by_username after the upgrade")
        .expect("the pre-#204 account survives the upgrade");
    assert_eq!(existing.auth_epoch, 0);

    // --- items: the template demo table is gone (0012_drop_items.sql) -------
    let items_left: Option<String> = sqlx::query_scalar("SELECT to_regclass('public.items')::text")
        .fetch_one(
            &banto_storage::connect_postgres(&url)
                .await
                .expect("connect"),
        )
        .await
        .expect("to_regclass(items)");
    assert_eq!(items_left, None, "0012 drops the items demo table");

    // --- users: create + list ------------------------------------------------
    let users = UsersService::new(db.clone());
    let identity = users
        .create_user("alice", "correct horse battery", "Alice", Role::Editor)
        .await
        .expect("users create_user");
    assert_eq!(identity.username, "alice");
    let listed_users = users.list_users().await.expect("users list");
    assert!(
        listed_users.iter().any(|u| u.username == "alice"),
        "created user should appear in list"
    );

    // --- users: auth_epoch (Issue #204, migration 0007) ---------------------
    // The Postgres arms of the epoch writes: `CASE WHEN role = $2` reuses a
    // text parameter, and `RETURNING auth_epoch` decodes BIGINT -> i64.
    assert_eq!(identity.auth_epoch, 0);
    let epoch = |users: UsersService| async move {
        users
            .get_by_username("alice")
            .await
            .expect("users get_by_username")
            .expect("alice exists")
            .auth_epoch
    };
    users
        .update_user(identity.id, "Alice A.", Role::Editor)
        .await
        .expect("users update_user (name only)");
    assert_eq!(epoch(users.clone()).await, 0, "a name edit keeps sessions");
    users
        .update_user(identity.id, "Alice A.", Role::Viewer)
        .await
        .expect("users update_user (role)");
    assert_eq!(epoch(users.clone()).await, 1, "a role change ends sessions");
    let changed = users
        .change_password("alice", "correct horse battery", "battery staple horse")
        .await
        .expect("users change_password");
    assert_eq!(changed, 2);
    users
        .reset_password(identity.id, "reset horse battery")
        .await
        .expect("users reset_password");
    assert_eq!(epoch(users.clone()).await, 3);
    let verified = users
        .verify("alice", "reset horse battery")
        .await
        .expect("users verify")
        .expect("alice verifies with the reset password");
    assert_eq!(verified.auth_epoch, 3);

    // --- settings: set + get -------------------------------------------------
    let settings = SettingsService::new(db.clone());
    settings
        .set("smoke.key", "smoke.value")
        .await
        .expect("settings set");
    let got = settings.get("smoke.key").await.expect("settings get");
    assert_eq!(got.as_deref(), Some("smoke.value"));
    // `set_auth_config` writes its four keys in ONE transaction (`set_many`,
    // freshness audit of #266 P2-3): the round trip on PostgreSQL.
    let mut auth = settings.auth_config().await.expect("auth config");
    auth.disabled = true;
    auth.disabled_role = Role::Viewer;
    settings
        .set_auth_config(&auth)
        .await
        .expect("set_auth_config");
    let auth = settings.auth_config().await.expect("auth config again");
    assert!(auth.disabled);
    assert_eq!(auth.disabled_role, Role::Viewer);

    // --- audit: record, list, prune (both branches) --------------------------
    let audit = AuditLogService::new(db.clone());
    for i in 0..3 {
        audit
            .try_record(AuditEntry {
                actor_username: Some("alice"),
                actor_role: Some("editor"),
                action: "create",
                resource: "projects",
                entity_id: Some(&i.to_string()),
                detail: None,
                origin: "rest",
                result: "ok",
            })
            .await
            .expect("audit try_record");
    }
    let audit_rows = audit.list(ListParams::default()).await.expect("audit list");
    assert_eq!(audit_rows.total_count, 3, "three audit rows recorded");

    // retention_days > 0 exercises the `ts::timestamptz < NOW() - interval`
    // Postgres path; our entries are "now", so a 1-day cutoff deletes nothing
    // (the point is that the TEXT->timestamptz cast does not error).
    let deleted_by_age = audit
        .prune(Some(1), None)
        .await
        .expect("audit prune by age");
    assert_eq!(deleted_by_age, 0);

    // retention_rows keeps only the newest row, deleting the two oldest by id
    // (id order == insertion order via IDENTITY).
    let deleted_by_rows = audit
        .prune(None, Some(1))
        .await
        .expect("audit prune by rows");
    assert_eq!(deleted_by_rows, 2);
    let remaining = audit
        .list(ListParams::default())
        .await
        .expect("audit list after prune");
    assert_eq!(remaining.total_count, 1);

    audit_snapshot_boundary_on_postgres(&audit, &db).await;

    concurrent_admin_removals_on_postgres(&url).await;

    // --- backup: SQLite-only, so every op must Err (never panic) on Postgres --
    // V2 owner decision D3 (PR4): backup/restore is a SQLite-only feature.
    // Against a Postgres handle each public operation returns `Err` instead of
    // the old `sqlite_pool()` `expect` panic. The `db_path` here is irrelevant
    // (the backend gate fires before any filesystem access), so a placeholder
    // name is fine.
    let backup = BackupService::new(PathBuf::from("banto-unused.sqlite3"), db.clone());
    assert!(
        backup.create().await.is_err(),
        "backup create must error on Postgres, not panic"
    );
    assert!(
        backup.list().await.is_err(),
        "backup list must error on Postgres"
    );
    assert!(
        backup.read("banto-anything.sqlite3").await.is_err(),
        "backup read must error on Postgres"
    );
    assert!(
        backup
            .stage_restore_from_file("banto-anything.sqlite3")
            .await
            .is_err(),
        "stage_restore_from_file must error on Postgres"
    );
    assert!(
        backup.stage_restore_from_bytes(b"anything").await.is_err(),
        "stage_restore_from_bytes must error on Postgres"
    );
    assert!(
        backup.cancel_pending_restore().await.is_err(),
        "cancel_pending_restore must error on Postgres"
    );
    assert!(
        backup.pending_restore().await.is_none(),
        "pending_restore reports nothing staged on Postgres"
    );

    // banto-cost P3a: customers -> project (with its manager membership) ->
    // pipeline versions -> overview, through the services' Postgres arms.
    {
        use admin_template_core::authz::{AuthzService, MemberKind, ProjectScope};
        use admin_template_core::customers::{CustomerInput, CustomersService};
        use admin_template_core::pipeline::{PipelineService, PipelineVersionInput};
        use admin_template_core::projects::{ProjectInput, ProjectsService};

        let manager = users
            .create_user(
                "p3a-manager",
                "correct horse battery",
                "案件責任者",
                Role::Editor,
            )
            .await
            .expect("manager account")
            .id;
        let customer = CustomersService::new(db.clone())
            .create(CustomerInput {
                name: "架空工業".into(),
                active: true,
                note: None,
                row_version: None,
            })
            .await
            .expect("customer on Postgres");
        let projects = ProjectsService::new(db.clone());
        let project = projects
            .create(
                ProjectInput {
                    code: "P-PG-1".into(),
                    name: "架空案件".into(),
                    customer_id: customer.id,
                    manager_user_id: manager,
                    status: "negotiating".into(),
                    planned_start: None,
                    planned_end: None,
                    order_no: None,
                    department: None,
                    note: None,
                    row_version: None,
                },
                None,
            )
            .await
            .expect("project on Postgres");
        let members = AuthzService::new(db.clone())
            .project_members(project.id)
            .await
            .unwrap();
        assert_eq!(members[0].kind, MemberKind::Manager);
        let listed = projects
            .list(ListParams::default(), &ProjectScope::All)
            .await
            .unwrap();
        assert_eq!(listed.total_count, 1);

        let pipeline = PipelineService::new(db.clone());
        let input: PipelineVersionInput = serde_json::from_value(serde_json::json!({
            "stage": "negotiating",
            "expectedAmount": 3_000_000,
            "probabilityPct": 60,
            "expectedOrderMonth": "2026-11",
            "basis": "見積提出済み",
            "revenuePlan": [{ "month": "2026-12", "amount": 3_000_000 }, { "amount": 0 }],
            "adopt": false
        }))
        .unwrap();
        let draft = pipeline
            .create_version(project.id, input, Some(manager))
            .await
            .expect("version on Postgres");
        pipeline
            .adopt(project.id, draft.id, Some(manager))
            .await
            .expect("adopt on Postgres");
        let overview = pipeline.overview(&ProjectScope::All).await.unwrap();
        assert_eq!(
            (overview.totals.total, overview.totals.weighted),
            (3_000_000, 1_800_000)
        );
        assert_eq!(overview.rows[0].undated_amount, Some(0));

        // banto-cost P4a: the calc basis's Postgres arms (seeded items with
        // BOOLEAN flags, the COALESCE unique indexes, RETURNING id).
        use admin_template_core::calc_basis::{AppliedSource, CalcBasisService, CalcValueInput};
        let basis = CalcBasisService::new(db.clone());
        let value = |item: &str, from: &str, value: Option<i64>| -> CalcValueInput {
            serde_json::from_value(serde_json::json!({
                "itemKey": item, "validFrom": from, "value": value, "reason": "架空の改定"
            }))
            .unwrap()
        };
        assert_eq!(basis.items().await.unwrap().len(), 13);
        let v1 = basis
            .add(
                None,
                value("emp_rate", "2026-06-01", Some(5_000)),
                Some(manager),
            )
            .await
            .expect("company value on Postgres");
        assert_eq!(v1.version_no, 1);
        assert!(matches!(
            basis
                .add(
                    None,
                    value("emp_rate", "2026-06-01", Some(5_100)),
                    Some(manager)
                )
                .await,
            Err(banto_core::BantoError::Validation { .. })
        ));
        basis
            .add(
                Some(project.id),
                value("emp_rate", "2026-12-01", Some(5_500)),
                Some(manager),
            )
            .await
            .expect("override on Postgres");
        let applied = basis.project(project.id, "2026-12-01").await.unwrap();
        assert_eq!(applied.items[0].applied_value, Some(5_500));
        assert_eq!(applied.items[0].source, AppliedSource::Project);
        let company = basis.company("2026-12-01").await.unwrap();
        assert_eq!(company.items[0].overriding_projects, 1);

        // banto-cost P4b: masters and time entries on Postgres (seeded rows,
        // the users-row FOR UPDATE lock, the boolean cost_missing column,
        // the per-user request-id unique index, the approval's rate lookup).
        use admin_template_core::time_entries::{
            DecisionInput, TimeEntriesService, TimeEntryInput,
        };
        use admin_template_core::work_masters::{MasterKind, WorkMastersService};
        let masters = WorkMastersService::new(db.clone());
        assert_eq!(masters.list(MasterKind::Phases).await.unwrap().len(), 6);
        assert_eq!(masters.list(MasterKind::Activities).await.unwrap().len(), 4);
        let time = TimeEntriesService::new(db.clone());
        let entry: TimeEntryInput = serde_json::from_value(serde_json::json!({
            "workDate": "2026-12-01", "projectId": project.id, "phaseId": 1,
            "minutes": 420, "clientRequestId": "pg-1"
        }))
        .unwrap();
        let saved = time
            .create(manager, entry.clone())
            .await
            .expect("create on Postgres");
        let again = time
            .create(manager, entry)
            .await
            .expect("retry on Postgres");
        assert!(again.replayed);
        assert_eq!(saved.entry.id, again.entry.id);
        let submitted = time
            .submit(manager, saved.entry.id, saved.entry.row_version)
            .await
            .expect("submit on Postgres");
        let approved = time
            .decide(
                &submitted,
                DecisionInput {
                    row_version: submitted.row_version,
                    approve: true,
                    reason: None,
                },
                Some(manager),
            )
            .await
            .expect("approve on Postgres");
        assert_eq!(approved.applied_rate, Some(5_500), "the project override");
        assert_eq!(approved.labor_cost, Some(38_500));
        assert!(!approved.cost_missing);
        let summary = time.project_summary(project.id).await.unwrap();
        assert_eq!(summary.total.labor_cost, 38_500);

        // banto-cost P4c: budget versions on Postgres (the one-draft partial
        // index, the COALESCE line index, CURRENT_DATE::text, the project-row
        // lock of the approval, the budget-rate lookup).
        use admin_template_core::budgets::{BudgetDraftInput, BudgetsService};
        basis
            .add(
                None,
                value("budget_rate", "2020-01-01", Some(5_000)),
                Some(manager),
            )
            .await
            .expect("budget rate on Postgres");
        if let banto_storage::Db::Postgres(pool) = &db {
            sqlx::query("UPDATE projects SET status = 'ordered' WHERE id = $1")
                .bind(project.id)
                .execute(pool)
                .await
                .unwrap();
        }
        let budgets = BudgetsService::new(db.clone());
        let draft = budgets
            .create_draft(project.id, Some(manager))
            .await
            .expect("draft on Postgres")
            .draft;
        assert!(
            budgets
                .create_draft(project.id, Some(manager))
                .await
                .unwrap()
                .replayed
        );
        let input: BudgetDraftInput = serde_json::from_value(serde_json::json!({
            "rowVersion": draft.row_version,
            "lines": [
                { "phaseId": 1, "costType": "labor", "plannedMinutes": 12_000 },
                { "costType": "material", "amount": 900_000 }
            ]
        }))
        .unwrap();
        let saved = budgets
            .update_draft(draft.id, input, Some(manager))
            .await
            .expect("save on Postgres");
        assert_eq!(saved.total, Some(1_900_000));
        let v1 = budgets
            .approve(&saved, saved.row_version, Some(manager))
            .await
            .expect("approve on Postgres");
        assert_eq!(v1.version_no, Some(1));
        let overview = budgets.overview(project.id).await.unwrap();
        assert_eq!(overview.current.unwrap().total, Some(1_900_000));
        let labor = overview
            .totals
            .iter()
            .find(|t| t.cost_type == "labor")
            .unwrap();
        assert_eq!(labor.actual, Some(38_500));

        // banto-cost P4d: orders and direct costs on Postgres (the CHECKs on
        // entry_kind / ref_id, the one-confirmation partial index, the
        // FOR UPDATE locks of the approval and the revision, the CASTs).
        use admin_template_core::direct_costs::{
            DirectCostInput, DirectCostsService, OrderRevisionInput, PurchaseOrderInput,
        };
        let costs = DirectCostsService::new(db.clone());
        let order: PurchaseOrderInput = serde_json::from_value(serde_json::json!({
            "projectId": project.id,
            "costType": "outsource",
            "orderedOn": "2026-11-01",
            "amount": 500_000,
            "clientRequestId": "pg-po"
        }))
        .unwrap();
        let po = costs
            .create_order(order, Some(manager))
            .await
            .expect("order on Postgres")
            .order;
        let decide = |row_version| admin_template_core::time_entries::DecisionInput {
            row_version,
            approve: true,
            reason: None,
        };
        let mut approved_ids = Vec::new();
        for body in [
            serde_json::json!({
                "entryKind": "provisional", "purchaseOrderId": po.id,
                "bookedOn": "2026-11-30", "amount": 300_000
            }),
            serde_json::json!({
                "entryKind": "confirms", "refId": 0, "bookedOn": "2026-11-30",
                "amount": 300_000, "reason": "請求書到着"
            }),
        ] {
            let mut input: DirectCostInput = serde_json::from_value(body).unwrap();
            if input.ref_id == Some(0) {
                input.ref_id = approved_ids.first().copied();
            }
            let c = costs
                .create(manager, input)
                .await
                .expect("cost on Postgres")
                .cost;
            let c = costs.submit(manager, c.id, c.row_version).await.unwrap();
            let c = costs
                .decide(&c, decide(c.row_version), Some(manager))
                .await
                .expect("approve cost on Postgres");
            approved_ids.push(c.id);
        }
        let pc = costs.project_costs(project.id).await.unwrap();
        assert_eq!(pc.orders[0].realized, 300_000);
        assert_eq!(pc.orders[0].remaining, 200_000);
        assert!(pc.complete);
        let revised = costs
            .revise_order(
                po.id,
                OrderRevisionInput {
                    kind: "cancel".into(),
                    amount: 200_000,
                    reason: Some("残りは不要".into()),
                    row_version: pc.orders[0].row_version,
                },
                Some(manager),
            )
            .await
            .expect("cancel on Postgres");
        assert_eq!(revised.remaining, 0);
        let overview = budgets.overview(project.id).await.unwrap();
        let outsource = overview
            .totals
            .iter()
            .find(|t| t.cost_type == "outsource")
            .unwrap();
        assert_eq!(outsource.actual, Some(300_000));

        // banto-cost P5: completion forecasts on Postgres (the one-draft
        // partial index, the snapshot columns' CHECK, the project-row lock of
        // the adoption, CURRENT_DATE::text, the overall list).
        use admin_template_core::forecasts::{ForecastDraftInput, ForecastsService};
        basis
            .add(
                None,
                value("forecast_rate", "2020-01-01", Some(5_000)),
                Some(manager),
            )
            .await
            .expect("forecast rate on Postgres");
        let forecasts = ForecastsService::new(db.clone());
        let draft = forecasts
            .create_draft(project.id, Some(manager))
            .await
            .expect("forecast draft on Postgres")
            .draft;
        assert!(
            forecasts
                .create_draft(project.id, Some(manager))
                .await
                .unwrap()
                .replayed
        );
        let input: ForecastDraftInput = serde_json::from_value(serde_json::json!({
            "rowVersion": draft.row_version,
            "baseDate": draft.base_date,
            "reason": "初回",
            "lines": [
                { "phaseId": 1, "costType": "labor", "remainingMinutes": 600 },
                { "costType": "material", "amount": 100_000 }
            ]
        }))
        .unwrap();
        let saved = forecasts
            .update_draft(draft.id, input, Some(manager))
            .await
            .expect("save forecast on Postgres");
        assert_eq!(
            saved.remaining_total.map(|r| r - saved.committed_total),
            Some(150_000)
        );
        let v1 = forecasts
            .adopt(&saved, saved.row_version, Some(manager))
            .await
            .expect("adopt on Postgres");
        assert_eq!(v1.version_no, Some(1));
        assert_eq!(v1.cost_total, saved.cost_total);
        let o = forecasts.overview(project.id).await.unwrap();
        assert_eq!(o.history.len(), 1);
        let portfolio = forecasts
            .portfolio()
            .overview(
                &banto_admin_services::authz::ProjectScope::All,
                &banto_admin_services::authz::ProjectScope::All,
            )
            .await
            .expect("portfolio on Postgres");
        assert!(portfolio.rows.iter().any(|r| r.project_id == project.id));

        // banto-cost P6a: 精算完了 on Postgres (the fingerprint casts, the
        // guarded status update, RETURNING id, the waivers' CHECK).
        use admin_template_core::closeouts::{SettleInput, WaiverInput};
        let pool = db.as_postgres().expect("a PostgreSQL handle");
        sqlx::query("UPDATE projects SET status = 'work_done' WHERE id = $1")
            .bind(project.id)
            .execute(pool)
            .await
            .unwrap();
        let closeouts = forecasts.closeouts();
        let check = closeouts
            .check(project.id)
            .await
            .expect("closeout check on Postgres");
        assert!(check.settleable);
        let waivers: Vec<WaiverInput> = check
            .blockers
            .iter()
            .filter(|b| b.waivable)
            .map(|b| WaiverInput {
                kind: b.kind.clone(),
                purchase_order_id: b.purchase_order_id,
                amount: b.amount.unwrap_or(0),
                reason: "不要になった".into(),
            })
            .collect();
        let settled = closeouts
            .settle(
                project.id,
                SettleInput {
                    row_version: check.row_version,
                    note: None,
                    waivers,
                },
                Some(manager),
            )
            .await;
        // Only remaining amounts are left on the project here: settled.
        assert!(check.blockers.iter().all(|b| b.waivable));
        let settled = settled.expect("settle on Postgres");
        assert_eq!(settled.status, "settled");
        assert!(settled.closeout.is_some());

        // 精算完了の取消 (the dropped unique index, the reopening row and
        // its join, LIMIT in the latest-settlement read).
        let reopened = closeouts
            .reopen(
                project.id,
                admin_template_core::closeouts::ReopenInput {
                    row_version: settled.row_version,
                    reason: "計上漏れ".into(),
                },
                Some(manager),
            )
            .await
            .expect("reopen on Postgres");
        assert_eq!(reopened.status, "work_done");
        assert!(reopened.closeout.is_none());
        assert_eq!(reopened.history.len(), 1);
        assert!(reopened.history[0].reopening.is_some());

        // banto-cost P6b: 月次締め on Postgres (the month gate's ON CONFLICT
        // and FOR SHARE, the closer's FOR UPDATE, the snapshot rows).
        use admin_template_core::closing::{CloseInput, ReopenInput};
        let closing = forecasts.closing();
        let month = closing.get("2026-07").await.expect("month on Postgres");
        assert!(month.can_close);
        let closed = closing
            .close(
                "2026-07",
                CloseInput {
                    row_version: month.row_version,
                },
                Some(manager),
            )
            .await
            .expect("close on Postgres");
        assert_eq!(closed.status, "closed");
        let refused = admin_template_core::time_entries::TimeEntriesService::new(db.clone())
            .create(
                manager,
                serde_json::from_value(serde_json::json!({
                    "workDate": "2026-07-10", "activityId": 1, "minutes": 60
                }))
                .unwrap(),
            )
            .await;
        assert!(refused.is_err(), "a closed month refuses hours");
        let reopened = closing
            .reopen(
                "2026-07",
                ReopenInput {
                    row_version: closed.row_version,
                    reason: "訂正".into(),
                },
                Some(manager),
            )
            .await
            .expect("reopen month on Postgres");
        assert_eq!(reopened.status, "reopened");
        assert!(reopened.comparison.is_some());
        assert_eq!(closing.months().await.unwrap().len(), 1);

        // banto-cost P6b-2: 工数の訂正 on Postgres (the partial unique index
        // on corrects_id, the EXISTS columns, the COUNTS filter, the touch of
        // the replaced entry).
        let time = TimeEntriesService::new(db.clone());
        let common = time
            .create(
                manager,
                serde_json::from_value(serde_json::json!({
                    "workDate": "2026-07-11", "activityId": 1, "minutes": 60
                }))
                .unwrap(),
            )
            .await
            .expect("hours in the reopened month")
            .entry;
        let common = time
            .submit(manager, common.id, common.row_version)
            .await
            .unwrap();
        let decision = |row_version| DecisionInput {
            row_version,
            approve: true,
            reason: None,
        };
        let common = time
            .decide(&common, decision(common.row_version), Some(manager))
            .await
            .expect("approve on Postgres");
        let correction = |reason: &str| {
            serde_json::from_value(serde_json::json!({
                "workDate": "2026-07-11", "activityId": 2, "minutes": 30,
                "rowVersion": common.row_version, "reason": reason
            }))
            .unwrap()
        };
        let c = time
            .correct(manager, common.id, correction("活動の誤り"))
            .await
            .expect("correct on Postgres")
            .entry;
        assert_eq!(c.corrects_id, Some(common.id));
        assert!(time.get(common.id).await.unwrap().correction_pending);
        let second = time
            .correct(manager, common.id, correction("二重"))
            .await
            .unwrap_err();
        assert!(
            matches!(second, banto_core::BantoError::Validation { .. }),
            "one correction in flight: {second:?}"
        );
        assert_eq!(time.pending_corrections().await.unwrap().len(), 1);
        time.decide(&c, decision(c.row_version), Some(manager))
            .await
            .expect("approve the correction on Postgres");
        let replaced = time.get(common.id).await.unwrap();
        assert_eq!(replaced.replaced_by_id, Some(c.id));
        assert_eq!(replaced.row_version, common.row_version + 2);
        assert_eq!(
            time.corrections_of(manager, common.id).await.unwrap().len(),
            1
        );
        let month = closing.get("2026-07").await.unwrap();
        assert_eq!(month.unapproved_time_entries, 0);

        // banto-cost P6c: the monthly figures and the CSV on Postgres
        // (SUBSTR month keys, the local timestamp, the summed casts). The
        // months add up to the total, as on SQLite (T15).
        let reports = forecasts.reports();
        let monthly = reports
            .project_monthly(project.id)
            .await
            .expect("monthly figures on Postgres");
        let labor: i64 = monthly.lines.iter().map(|l| l.amounts.labor).sum();
        assert_eq!(labor, monthly.total.labor);
        let csv = reports
            .project_monthly_csv(project.id)
            .await
            .expect("monthly CSV on Postgres");
        assert!(csv.content.starts_with("\u{feff}出力日時,20"));
        let all = banto_admin_services::authz::ProjectScope::All;
        reports
            .portfolio_csv(&all, &all)
            .await
            .expect("portfolio CSV on Postgres");
        reports
            .period_monthly_csv(14, &all)
            .await
            .expect("period CSV on Postgres");

        // banto-cost P7b: 月額固定原価 on Postgres (the partial unique
        // index's ON CONFLICT ... WHERE, the ledger's UNION ALL with negated
        // ids, the close's fingerprint of the postings).
        use admin_template_core::fixed_costs::{CancelInput, ContractInput};
        let fixed = forecasts.fixed_costs();
        let contract = fixed
            .create(
                ContractInput {
                    project_id: Some(project.id),
                    payee_kind: "employee".into(),
                    user_id: Some(manager),
                    monthly_amount: Some(450_000),
                    from_month: "2026-08".into(),
                    ..Default::default()
                },
                Some(manager),
            )
            .await
            .expect("fixed-cost contract on Postgres");
        assert_eq!(contract.cost_type, "labor");
        let posted = fixed
            .post_month("2026-08", Some(manager))
            .await
            .expect("post on Postgres");
        assert_eq!(posted.posted, 1);
        let again = fixed.post_month("2026-08", Some(manager)).await.unwrap();
        assert_eq!(again.posted, 0, "once per contract and month");
        let monthly = reports.project_monthly(project.id).await.unwrap();
        let aug = monthly
            .lines
            .iter()
            .find(|l| l.month == "2026-08")
            .expect("August figures");
        assert!(aug.amounts.labor >= 450_000);
        let month = closing.get("2026-09").await.unwrap();
        assert!(month.warnings.iter().any(|w| w.code == "fixed_unposted"));
        let posting = again.view.lines[0].posting.clone().unwrap();
        let view = fixed
            .cancel(
                posting.id,
                CancelInput {
                    reason: "架空の訂正".into(),
                },
                Some(manager),
            )
            .await
            .expect("cancel on Postgres");
        assert_eq!(view.posted_total, 0);
        assert_eq!(fixed.list().await.unwrap()[0].posted_count, 0);

        // banto-cost P7c: 定期売上 on Postgres (the plan rewrite in the
        // agreement's transaction, the recognition through the orders
        // service, the close's warning).
        use admin_template_core::orders::{ConversionRequest, OrdersService};
        use admin_template_core::recurring_revenue::AgreementInput;
        let monthly = projects
            .create(
                ProjectInput {
                    code: "P-PG-R".into(),
                    name: "架空の年間保守".into(),
                    customer_id: customer.id,
                    manager_user_id: manager,
                    status: "negotiating".into(),
                    planned_start: None,
                    planned_end: None,
                    order_no: None,
                    department: None,
                    note: None,
                    row_version: None,
                },
                None,
            )
            .await
            .expect("monthly-contract project on Postgres");
        let lead: PipelineVersionInput = serde_json::from_value(serde_json::json!({
            "stage": "negotiating",
            "expectedAmount": 1_200_000,
            "probabilityPct": 90,
            "expectedOrderMonth": "2026-06",
            "basis": "年間保守の更新",
            "revenuePlan": [{ "amount": 1_200_000 }],
            "adopt": true
        }))
        .unwrap();
        pipeline
            .create_version(monthly.id, lead, Some(manager))
            .await
            .expect("version on Postgres");
        let row_version = projects.get(monthly.id).await.unwrap().row_version;
        let conversion: ConversionRequest = serde_json::from_value(serde_json::json!({
            "rowVersion": row_version,
            "convertedOn": "2026-06-01",
            "confirmedAmount": 1_200_000,
            "basis": "年間保守契約",
            "plannedStart": "2026-06-01",
            "plannedEnd": "2027-05-31",
            "revenuePlan": [{ "amount": 1_200_000 }],
            "scope": "whole"
        }))
        .unwrap();
        OrdersService::new(db.clone())
            .convert(monthly.id, conversion, Some(manager))
            .await
            .expect("convert on Postgres");
        let recurring = forecasts.recurring_revenue();
        let agreement = recurring
            .create(
                AgreementInput {
                    project_id: Some(monthly.id),
                    monthly_amount: Some(100_000),
                    from_month: "2026-06".into(),
                    to_month: "2027-05".into(),
                    ..Default::default()
                },
                Some(manager),
            )
            .await
            .expect("agreement on Postgres");
        assert_eq!(agreement.contract_total, 1_200_000);
        let r = recurring
            .recognize_month("2026-10", Some(manager))
            .await
            .expect("recognize on Postgres");
        assert_eq!(r.recognized, 1);
        let again = recurring
            .recognize_month("2026-10", Some(manager))
            .await
            .unwrap();
        assert_eq!(again.recognized, 0, "once a month");
        let mut longer = AgreementInput {
            project_id: Some(monthly.id),
            monthly_amount: Some(100_000),
            from_month: "2026-06".into(),
            to_month: "2027-05".into(),
            description: Some("備考".into()),
            ..Default::default()
        };
        longer.row_version = agreement.row_version;
        recurring
            .update(agreement.id, longer, Some(manager))
            .await
            .expect("regenerate on Postgres");

        // banto-cost P8f (T40): the record counts decode on Postgres, a
        // project with records keeps its conversion, and the partial unique
        // index lets a cancelled project be converted again.
        let orders = OrdersService::new(db.clone());
        assert_eq!(
            orders.summary(monthly.id).await.unwrap().cancel_blockers,
            vec!["recognitions", "recurring_revenue"]
        );
        let wrong = projects
            .create(
                ProjectInput {
                    code: "P-PG-C".into(),
                    name: "架空の取り違え".into(),
                    customer_id: customer.id,
                    manager_user_id: manager,
                    status: "negotiating".into(),
                    planned_start: None,
                    planned_end: None,
                    order_no: None,
                    department: None,
                    note: None,
                    row_version: None,
                },
                None,
            )
            .await
            .expect("project to cancel on Postgres");
        let convert_wrong = |row_version: i64| -> ConversionRequest {
            serde_json::from_value(serde_json::json!({
                "rowVersion": row_version,
                "convertedOn": "2026-06-01",
                "confirmedAmount": 500_000,
                "basis": "注文書",
                "plannedStart": "2026-06-01",
                "plannedEnd": "2026-09-30",
                "revenuePlan": [{ "amount": 500_000 }],
                "scope": "whole"
            }))
            .unwrap()
        };
        let rv = projects.get(wrong.id).await.unwrap().row_version;
        let s = orders
            .convert(wrong.id, convert_wrong(rv), Some(manager))
            .await
            .expect("convert to cancel on Postgres");
        assert!(s.cancel_blockers.is_empty(), "{:?}", s.cancel_blockers);
        let rv = projects.get(wrong.id).await.unwrap().row_version;
        let cancel: admin_template_core::orders::ConversionCancelInput =
            serde_json::from_value(serde_json::json!({ "rowVersion": rv, "reason": "取り違え" }))
                .unwrap();
        let s = orders
            .cancel_conversion(wrong.id, cancel, Some(manager))
            .await
            .expect("cancel the conversion on Postgres");
        assert_eq!(s.status, "negotiating");
        assert_eq!(s.cancelled_conversions.len(), 1);
        let rv = projects.get(wrong.id).await.unwrap().row_version;
        let s = orders
            .convert(wrong.id, convert_wrong(rv), Some(manager))
            .await
            .expect("convert again on Postgres");
        assert_eq!(s.confirmed_amount, Some(500_000));

        let month = closing.get("2026-11").await.unwrap();
        assert!(month
            .warnings
            .iter()
            .any(|w| w.code == "recurring_unrecognized"));
    }
}

// Issue #248: `list_as_of` on PostgreSQL - the boundary pins the set across
// blocks (rows recorded between two blocks stay out, the count stays), rows
// sharing one `ts` keep one order across `OFFSET` blocks in both directions
// (`ORDER BY` ends with `id`), and an omitted boundary keeps `list`'s result.
// Runs inside the smoke test (shared schema, see the note below).
async fn audit_snapshot_boundary_on_postgres(audit: &AuditLogService, db: &banto_storage::Db) {
    use banto_core::{Pagination, SortDirection, SortState};

    let record = |n: usize| async move {
        for _ in 0..n {
            audit
                .try_record(AuditEntry {
                    actor_username: Some("alice"),
                    actor_role: Some("admin"),
                    action: "create",
                    resource: "projects",
                    entity_id: None,
                    detail: None,
                    origin: "rest",
                    result: "ok",
                })
                .await
                .expect("audit try_record");
        }
    };
    let page = |offset: u64, direction: SortDirection| ListParams {
        pagination: Some(Pagination { offset, limit: 3 }),
        sort: vec![SortState {
            field: "ts".to_string(),
            direction,
        }],
        ..Default::default()
    };
    let ids = |list: &admin_template_core::audit::AuditLogList| -> Vec<i64> {
        list.rows.iter().map(|r| r.id).collect()
    };

    record(5).await;
    let pool = db.as_postgres().expect("a PostgreSQL handle");
    sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00+00'")
        .execute(pool)
        .await
        .expect("same ts for every row");
    let all = audit.list(ListParams::default()).await.expect("audit list");
    let mut all_ids: Vec<i64> = all.rows.iter().map(|r| r.id).collect();
    all_ids.sort();
    assert_eq!(all_ids.len(), 6);
    let max_id = *all_ids.last().unwrap();

    let first = audit
        .list_as_of(page(0, SortDirection::Desc), None)
        .await
        .expect("first block");
    assert_eq!(
        first.as_of_id, max_id,
        "an omitted boundary is the newest id"
    );
    assert_eq!(first.total_count, 6);

    // Two rows recorded between the blocks (same second as the rest).
    record(2).await;
    sqlx::query("UPDATE audit_log SET ts = '2026-09-29 12:00:00+00'")
        .execute(pool)
        .await
        .expect("same ts for the new rows");

    let second = audit
        .list_as_of(page(3, SortDirection::Desc), Some(first.as_of_id))
        .await
        .expect("second block");
    assert_eq!(second.as_of_id, first.as_of_id);
    assert_eq!(second.total_count, 6, "the pinned count is unchanged");
    let mut seen = ids(&first);
    seen.extend(ids(&second));
    let mut expected_desc = all_ids.clone();
    expected_desc.reverse();
    assert_eq!(seen, expected_desc, "no duplicate, no gap, id DESC on ties");

    let mut seen_asc = Vec::new();
    for offset in [0, 3] {
        let block = audit
            .list_as_of(page(offset, SortDirection::Asc), Some(first.as_of_id))
            .await
            .expect("ascending block");
        seen_asc.extend(ids(&block));
    }
    assert_eq!(seen_asc, all_ids, "id ASC on ties");

    let fresh = audit
        .list_as_of(page(0, SortDirection::Desc), None)
        .await
        .expect("fresh generation");
    assert_eq!(fresh.total_count, 8);
    assert_eq!(fresh.as_of_id, max_id + 2);
    let old = audit
        .list(page(0, SortDirection::Desc))
        .await
        .expect("list without a boundary");
    assert_eq!(old.total_count, fresh.total_count);
    assert_eq!(old.rows, fresh.rows);

    // Issue #248 review: a row with a lower id committing late (+1) and a
    // prune of the same size (-1) leave the pinned count unchanged while the
    // set changed - the block after the edge repeats a row. Reproduced with a
    // real open transaction: IDENTITY hands out ids outside transactions, so
    // the row inserted in `late` gets a lower id than the one committed
    // after it. Only the deletion epoch tells the two reads apart.
    let by_id_desc = |offset: u64| ListParams {
        pagination: Some(Pagination { offset, limit: 2 }),
        sort: vec![SortState {
            field: "id".to_string(),
            direction: SortDirection::Desc,
        }],
        ..Default::default()
    };
    let mut late = pool.begin().await.expect("begin the late writer");
    sqlx::query(
        "INSERT INTO audit_log (action, resource, origin) VALUES ('create', 'projects', 'rest')",
    )
    .execute(&mut *late)
    .await
    .expect("insert in the late transaction");
    record(1).await;

    let first = audit
        .list_as_of(by_id_desc(0), None)
        .await
        .expect("first block before the late commit");
    let before = audit
        .list(ListParams::default())
        .await
        .expect("count before the late commit")
        .total_count;
    assert_eq!(first.total_count, before);

    late.commit().await.expect("the late writer commits");
    let pruned = audit
        .prune(None, Some(before as i64))
        .await
        .expect("another tab's unbounded read prunes");
    assert_eq!(pruned, 1);

    let second = audit
        .list_as_of(by_id_desc(2), Some(first.as_of_id))
        .await
        .expect("second block after the late commit and the prune");
    assert_eq!(
        second.total_count, first.total_count,
        "the count alone cannot see the change"
    );
    assert_eq!(
        second.rows[0].id, first.rows[1].id,
        "the edge row repeats: the set shifted"
    );
    assert_ne!(
        second.deletion_epoch, first.deletion_epoch,
        "the deletion epoch catches it"
    );
}

// Issue #207 / roadmap M10: keep this in the existing smoke test so no other
// test resets the shared schema while these concurrent transactions are live.
async fn concurrent_admin_removals_on_postgres(url: &str) {
    use banto_core::BantoError;
    use banto_storage::Db;
    use sqlx::postgres::PgPoolOptions;
    use std::time::Duration;

    // Separate pools rule out a service-local mutex masquerading as DB locking.
    // A stricter session default verifies that the service explicitly selects
    // READ COMMITTED, so a lock waiter sees the preceding writer's commit.
    let options = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET default_transaction_isolation = 'repeatable read'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        });
    let first_pool = options.clone().connect(url).await.unwrap();
    let second_pool = options.connect(url).await.unwrap();
    let control = banto_storage::connect_postgres(url).await.unwrap();
    let first = UsersService::new(Db::Postgres(first_pool.clone()));
    let second = UsersService::new(Db::Postgres(second_pool.clone()));

    for (delete_first, delete_second) in [(false, false), (true, true), (false, true)] {
        sqlx::query("DELETE FROM users")
            .execute(&control)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (username, password_hash, display_name, role) VALUES
             ('owner1', 'unused', 'Original 1', 'admin'),
             ('owner2', 'unused', 'Original 2', 'admin')",
        )
        .execute(&control)
        .await
        .unwrap();
        let before = first.list_users().await.unwrap();
        let first_id = before
            .iter()
            .find(|user| user.username == "owner1")
            .unwrap()
            .id;
        let second_id = before
            .iter()
            .find(|user| user.username == "owner2")
            .unwrap()
            .id;
        let mut gate = control.begin().await.unwrap();
        sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *gate)
            .await
            .unwrap();

        let launch = |svc: UsersService, id, actor_id, delete| {
            tokio::spawn(async move {
                if delete {
                    svc.delete_user(id, Some(actor_id)).await
                } else {
                    svc.update_user(id, "Changed", Role::Viewer)
                        .await
                        .map(|_| ())
                }
            })
        };
        let a = launch(first.clone(), first_id, second_id, delete_first);
        let b = launch(second.clone(), second_id, first_id, delete_second);
        // The gate allows SELECTs but blocks mutations. In the old code both
        // calls pass the count check before waiting at their writes; with the
        // fix both wait before their protected reads. Observe real lock waits,
        // rather than assuming an arbitrary sleep was enough to reach them.
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let waiting: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM pg_locks
                     WHERE relation = 'users'::regclass AND NOT granted",
                )
                .fetch_one(&control)
                .await
                .unwrap();
                if waiting == 2 {
                    break;
                }
                assert!(
                    !a.is_finished() && !b.is_finished(),
                    "operations must wait for the gate"
                );
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both concurrent operations must reach the database lock gate");
        gate.commit().await.unwrap();
        let (a, b) = tokio::time::timeout(Duration::from_secs(15), async {
            let (a, b) = tokio::join!(a, b);
            (a.unwrap(), b.unwrap())
        })
        .await
        .expect("both operations must complete once the gate opens");
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let (refused_id, error) = if let Err(error) = a {
            (first_id, error)
        } else {
            (second_id, b.unwrap_err())
        };
        match error {
            BantoError::Other(message) => {
                assert_eq!(message, "最後の管理者を降格・削除することはできません");
            }
            other => panic!("expected last-admin refusal, got {other:?}"),
        }
        let after = first.list_users().await.unwrap();
        assert_eq!(after.iter().filter(|user| user.role.is_admin()).count(), 1);
        assert_eq!(
            after.iter().find(|user| user.id == refused_id),
            before.iter().find(|user| user.id == refused_id),
            "a refused operation must preserve its display name and role"
        );
        tokio::time::timeout(
            Duration::from_secs(5),
            second.update_user(refused_id, "Still admin", Role::Admin),
        )
        .await
        .expect("refusal must release its transaction lock")
        .unwrap();
    }
    first_pool.close().await;
    second_pool.close().await;
    control.close().await;
}
