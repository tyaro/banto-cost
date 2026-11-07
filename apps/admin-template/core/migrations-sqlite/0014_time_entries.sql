-- banto-cost P4b (docs/project/design.md §3.3, spec §5.2 / §6.1 / §6.2):
-- the phase and common-activity masters and the time entries.
--
-- Masters are never deleted; one that is no longer used is made inactive so
-- the entries that refer to it keep their history (spec §10). The seeded
-- names are the spec's initial candidates (spec §5.2), not company data.
CREATE TABLE phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO phases (name, sort_order) VALUES
    ('設計', 10), ('ソフト開発', 20), ('製作', 30), ('試験', 40),
    ('現地調整', 50), ('管理・打合せ', 60);

CREATE TABLE common_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO common_activities (name, sort_order) VALUES
    ('社内会議', 10), ('教育', 20), ('営業', 30), ('待機', 40);

-- One row per time entry. Exactly one of project_id / activity_id is set; a
-- project entry has a phase, an activity entry has neither phase nor rework.
-- status MUST match `cost_domain::time::TimeStatus`, rework_kind
-- `cost_domain::time::Rework`.
--
-- applied_* and labor_cost are fixed when the entry is approved: the
-- `emp_rate` calc-basis row in effect on work_date and ROUND(minutes × rate
-- / 60). No rate = labor_cost NULL (原価未確定, never 0 yen, T04). A later
-- calc-basis change never rewrites them (T03, design §10.5).
--
-- client_request_id makes a retried create return the first row instead of
-- a second one (T13); row_version guards every update (T13).
CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    project_id INTEGER REFERENCES projects(id),
    activity_id INTEGER REFERENCES common_activities(id),
    phase_id INTEGER REFERENCES phases(id),
    minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
    description TEXT,
    rework_kind TEXT CHECK (rework_kind IN ('internal','customer','other')),
    status TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','returned')),
    submitted_at TEXT,
    applied_calc_value_id INTEGER REFERENCES calc_values(id),
    applied_rate INTEGER,
    labor_cost INTEGER,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    return_reason TEXT,
    client_request_id TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((project_id IS NOT NULL AND activity_id IS NULL AND phase_id IS NOT NULL)
        OR (project_id IS NULL AND activity_id IS NOT NULL AND phase_id IS NULL
            AND rework_kind IS NULL)),
    CHECK (status = 'approved' OR (labor_cost IS NULL AND applied_rate IS NULL))
);

CREATE UNIQUE INDEX time_entries_request ON time_entries (user_id, client_request_id);
CREATE INDEX time_entries_user_date ON time_entries (user_id, work_date);
CREATE INDEX time_entries_project ON time_entries (project_id);
CREATE INDEX time_entries_status ON time_entries (status);
