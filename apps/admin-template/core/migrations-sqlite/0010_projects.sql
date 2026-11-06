-- banto-cost P3a (docs/project/design.md §3.1): customers, the project ledger
-- and the pre-order pipeline versions. Amounts are integer yen (tax excluded);
-- unknown values are NULL, never 0 (spec §5.4).
CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    note TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: MUST match `cost_domain::project::ProjectStatus`. The responsible
-- person (manager_user_id) is also kept as a `project_members` row of kind
-- 'manager' by the service, which is what authorization reads (ADR-0028).
-- Deleting a user who is still a responsible person is refused by the FK.
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    manager_user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('lead','quoting','negotiating','ordered',
        'in_progress','work_done','settled','lost','cancelled','on_hold')),
    planned_start TEXT,
    planned_end TEXT,
    order_no TEXT,
    department TEXT,
    note TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX projects_customer ON projects (customer_id);

-- One row per saved pipeline version. A version is never edited after it is
-- saved; adopting a draft only flips `kind` and records who adopted it. The
-- aggregate uses each project's latest adopted version (T22).
-- stage: MUST match `cost_domain::pipeline::Stage::VERSION_STAGES`.
CREATE TABLE pipeline_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    version_no INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('draft','adopted')),
    stage TEXT NOT NULL CHECK (stage IN ('lead','quoting','negotiating','informal')),
    expected_amount INTEGER,
    probability_pct INTEGER CHECK (probability_pct BETWEEN 0 AND 99),
    expected_order_month TEXT,
    expected_start_month TEXT,
    expected_end_month TEXT,
    est_cost_at_order INTEGER,
    basis TEXT,
    next_action TEXT,
    confirmed_on TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    adopted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    adopted_at TEXT,
    UNIQUE (project_id, version_no)
);

-- Revenue plan of a pipeline version. month NULL = timing undecided (shown
-- separately, never spread over months, spec §7.5).
CREATE TABLE pipeline_revenue_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_version_id INTEGER NOT NULL REFERENCES pipeline_versions(id) ON DELETE CASCADE,
    month TEXT,
    amount INTEGER NOT NULL
);

CREATE INDEX pipeline_revenue_plan_version ON pipeline_revenue_plan (pipeline_version_id);
