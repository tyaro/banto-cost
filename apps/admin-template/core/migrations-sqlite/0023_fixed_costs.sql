-- banto-cost P7b (docs/project/design.md §9.4 items 3 and 5, T37): monthly
-- fixed costs (月額固定原価).
--
-- A contract is one person's fixed monthly amount (an employee: labor; a
-- vendor: outsourcing) booked every month to the monthly-contract project
-- that person serves - no split (2026-11-07 decision). The amount is never
-- 0 or unset: a month with no posting adds nothing.
--
-- cost_type follows payee_kind (`cost_domain::fixed_cost::PayeeKind`).
-- The project and the payee are fixed once a month is posted; the amount
-- may change and only the months not posted yet take the new amount (a
-- change such as 450,000 -> 300,000 may also end the contract and start a
-- new one).
CREATE TABLE fixed_cost_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    payee_kind TEXT NOT NULL CHECK (payee_kind IN ('employee','vendor')),
    user_id INTEGER REFERENCES users(id),
    vendor_id INTEGER REFERENCES vendors(id),
    cost_type TEXT NOT NULL CHECK (cost_type IN ('labor','outsource')),
    monthly_amount INTEGER NOT NULL CHECK (monthly_amount > 0),
    from_month TEXT NOT NULL,
    to_month TEXT,
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((payee_kind = 'employee' AND user_id IS NOT NULL AND vendor_id IS NULL
            AND cost_type = 'labor')
        OR (payee_kind = 'vendor' AND vendor_id IS NOT NULL AND user_id IS NULL
            AND cost_type = 'outsource')),
    CHECK (to_month IS NULL OR to_month >= from_month)
);

CREATE INDEX fixed_cost_contracts_project ON fixed_cost_contracts (project_id);

-- One posting per contract and month: an approved record booked on the
-- month's last day (the amount copied from the contract then, never
-- changed). A cancelled posting (reason required) counts as nothing and the
-- month may be posted again. Rows are only added or cancelled.
CREATE TABLE fixed_cost_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES fixed_cost_contracts(id),
    month TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    cost_type TEXT NOT NULL CHECK (cost_type IN ('labor','outsource')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    booked_on TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('approved','cancelled')),
    posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    posted_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancel_reason TEXT,
    cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TEXT,
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX fixed_cost_postings_once ON fixed_cost_postings (contract_id, month)
    WHERE status = 'approved';
CREATE INDEX fixed_cost_postings_project ON fixed_cost_postings (project_id);
CREATE INDEX fixed_cost_postings_month ON fixed_cost_postings (month);
