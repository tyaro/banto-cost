//! App-layer PostgreSQL smoke test (V2 "PostgreSQL アプリ全体対応", PR3).
//!
//! This is the first place the whole app service stack is exercised against a
//! real PostgreSQL server: `init_db_from_target` runs `migrations-postgres` +
//! the demo seed, then the four core services (`items`/`users`/`settings`/
//! `audit`) perform representative CRUD. It proves the strict-typed Postgres
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
use admin_template_core::items::{ImportResult, ItemImportRow, ItemInput, ItemsService};
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

    // migrations-postgres + deterministic 1,000-row seed.
    let db = init_db_from_target(&url)
        .await
        .expect("init_db_from_target should run migrations-postgres and seed");
    let existing = UsersService::new(db.clone())
        .get_by_username("existing")
        .await
        .expect("users get_by_username after the upgrade")
        .expect("the pre-#204 account survives the upgrade");
    assert_eq!(existing.auth_epoch, 0);

    // --- items: seed count, create, update, list, delete ---------------------
    let items = ItemsService::new(db.clone());

    let seeded = items
        .list(ListParams::default())
        .await
        .expect("items list after seed");
    assert_eq!(
        seeded.total_count, 1_000,
        "seed should insert exactly 1,000 rows"
    );

    // A create must land AFTER the seeded ids (the identity sequence was
    // advanced past the explicit 1..=1000 seed), proving id order == insertion
    // order still holds.
    let created = items
        .create(ItemInput {
            name: "テスト商品".to_string(),
            price: 123,
            stock: 7,
        })
        .await
        .expect("items create");
    assert!(
        created.id > 1_000,
        "new id must be past the seed, got {}",
        created.id
    );
    assert_eq!(created.price, 123);
    assert_eq!(
        created.updated_at.len(),
        10,
        "updated_at is a YYYY-MM-DD date"
    );

    let updated = items
        .update(
            created.id,
            ItemInput {
                name: "テスト商品(改)".to_string(),
                price: 200,
                stock: 3,
            },
        )
        .await
        .expect("items update");
    assert_eq!(updated.price, 200);
    assert_eq!(updated.stock, 3);

    items.delete(created.id).await.expect("items delete");
    let after_delete = items
        .list(ListParams::default())
        .await
        .expect("items list after delete");
    assert_eq!(after_delete.total_count, 1_000);

    // --- items import: round-trip + all-or-nothing rollback (spec M15) --------
    // Exercises `import_apply_postgres` - the hand-written Postgres mirror of
    // the SQLite transaction body that no other test or CI path reached
    // (M-review 2026-08 M-12). Both of its branches (commit / rollback) run
    // here against real Postgres.
    //
    // Round-trip: two INSERTs (`id: None`) plus one UPDATE of a seeded row
    // (ids 1..=1000) commit together.
    let import_ok = items
        .import(vec![
            ItemImportRow {
                id: None,
                name: "取込A".to_string(),
                price: 111,
                stock: 1,
            },
            ItemImportRow {
                id: None,
                name: "取込B".to_string(),
                price: 222,
                stock: 2,
            },
            ItemImportRow {
                id: Some(1),
                name: "既存1(改)".to_string(),
                price: 333,
                stock: 3,
            },
        ])
        .await
        .expect("items import (round-trip)");
    assert_eq!(
        import_ok,
        ImportResult {
            created: 2,
            updated: 1,
            errors: Vec::new(),
        }
    );
    let after_import = items
        .list(ListParams::default())
        .await
        .expect("items list after import");
    assert_eq!(
        after_import.total_count, 1_002,
        "the two INSERTs in the batch committed"
    );
    let seeded_one = items.get(1).await.expect("get updated seed row");
    assert_eq!(
        seeded_one.price, 333,
        "the UPDATE in the same batch committed too"
    );

    // All-or-nothing rollback: a batch whose second row UPDATEs a NON-existent
    // id (so `rows_affected == 0`) must roll the WHOLE thing back - the
    // otherwise-valid INSERT before it must NOT land, and `import` returns
    // `Ok(ImportResult { errors })`, not `Err`. NOTE: the trigger has to be a
    // missing-id UPDATE, not a bad-value row - validation runs BEFORE any
    // transaction opens, so a validation error never reaches
    // `import_apply_postgres`'s rollback branch.
    let import_rollback = items
        .import(vec![
            ItemImportRow {
                id: None,
                name: "巻き戻るはず".to_string(),
                price: 999,
                stock: 9,
            },
            ItemImportRow {
                id: Some(10_000_000),
                name: "存在しないid".to_string(),
                price: 1,
                stock: 1,
            },
        ])
        .await
        .expect("items import rollback returns Ok(with errors), never Err");
    assert_eq!(import_rollback.created, 0);
    assert_eq!(import_rollback.updated, 0);
    assert_eq!(
        import_rollback.errors.len(),
        1,
        "only the missing-id row is an error"
    );
    assert_eq!(
        import_rollback.errors[0].row, 1,
        "0-based index of the failing row"
    );
    let after_rollback = items
        .list(ListParams::default())
        .await
        .expect("items list after rollback");
    assert_eq!(
        after_rollback.total_count, 1_002,
        "the valid INSERT in the rolled-back batch must not have landed"
    );

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
                resource: "items",
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
                    resource: "items",
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
        "INSERT INTO audit_log (action, resource, origin) VALUES ('create', 'items', 'rest')",
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
