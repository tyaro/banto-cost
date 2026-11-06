-- banto-cost P3b (docs/project/design.md §3.2): order conversion, order
-- changes, the ordered revenue plan, revenue recognition with plan clearing,
-- and outlook snapshots. Amounts are integer yen (tax excluded).
--
-- parent_project_id: the project a remainder of a partial order was split
-- from (spec §5.5). revenue_version: bumped by every write to the order /
-- revenue rows of the project, so two writers cannot both pass the
-- consistency check (`cost_domain::revenue::OrderedRevenue::check`) on the
-- same state (T13). It is separate from row_version so a revenue write does
-- not make the project's edit form stale.
ALTER TABLE projects ADD COLUMN parent_project_id INTEGER REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN revenue_version INTEGER NOT NULL DEFAULT 0;

-- One conversion per project: the project itself switches to 'ordered'
-- (spec §5.5). previous_status / source_pipeline_version_id keep what the
-- pipeline looked like right before; the versions themselves stay as they were.
CREATE TABLE order_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id),
    source_pipeline_version_id INTEGER REFERENCES pipeline_versions(id),
    previous_status TEXT NOT NULL,
    converted_on TEXT NOT NULL,
    confirmed_amount INTEGER NOT NULL CHECK (confirmed_amount > 0),
    scope TEXT NOT NULL CHECK (scope IN ('whole','partial')),
    remainder_project_id INTEGER REFERENCES projects(id),
    basis TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Order changes (spec §3.1): 'pending' is 未確定追加売上 and is not part of
-- the confirmed order amount; 'approved' adds delta_amount to the confirmed
-- amount and to the revenue plan of plan_month (NULL = timing undecided).
-- status: MUST match `cost_domain::order::ChangeStatus`.
CREATE TABLE order_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    change_no INTEGER NOT NULL,
    delta_amount INTEGER NOT NULL CHECK (delta_amount <> 0),
    plan_month TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    basis TEXT NOT NULL,
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    decision_note TEXT,
    UNIQUE (project_id, change_no)
);

-- The ordered revenue plan. amount = cleared + still open; the open total
-- must equal the confirmed order amount minus recognized revenue (spec §5.5).
-- month NULL = timing undecided. A line some recognition (even a cancelled
-- one) cleared is kept at amount 0 instead of being deleted.
CREATE TABLE revenue_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    month TEXT,
    amount INTEGER NOT NULL CHECK (amount >= 0)
);

CREATE INDEX revenue_plan_project ON revenue_plan (project_id);

-- Revenue recognized by accounting (finance.close). Never edited; a mistake
-- is cancelled with a reason, which releases its clearings (history stays).
CREATE TABLE revenue_recognitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    recognized_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    basis TEXT,
    recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TEXT,
    cancel_reason TEXT
);

CREATE INDEX revenue_recognitions_project ON revenue_recognitions (project_id);

-- Which plan lines a recognition cleared (T26).
CREATE TABLE revenue_clearings (
    recognition_id INTEGER NOT NULL REFERENCES revenue_recognitions(id),
    plan_id INTEGER NOT NULL REFERENCES revenue_plan(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    PRIMARY KEY (recognition_id, plan_id)
);

-- Saved monthly outlooks (spec §7.5, T27): a report keeps its figures even
-- after an order conversion or a recognition changes the live outlook.
-- One row per project and month (month NULL = timing undecided).
CREATE TABLE outlook_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE outlook_snapshot_rows (
    snapshot_id INTEGER NOT NULL REFERENCES outlook_snapshots(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    month TEXT,
    recognized INTEGER NOT NULL,
    ordered_plan INTEGER NOT NULL,
    weighted_pipeline INTEGER NOT NULL,
    pending_addition INTEGER NOT NULL
);

CREATE INDEX outlook_snapshot_rows_snapshot ON outlook_snapshot_rows (snapshot_id);
