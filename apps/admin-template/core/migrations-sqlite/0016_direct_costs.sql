-- banto-cost P4d (docs/project/design.md §3.3, spec §6.3 / §6.4 / §11, T05,
-- T10, T14): vendors, purchase orders and direct costs.
--
-- Vendors (取引先) are a master like phases: never deleted, made inactive
-- when no longer used (spec §10). Nothing is seeded (no company data).
CREATE TABLE vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A purchase order is a commitment, not a cost: its realized amount is the
-- sum of the approved direct costs that refer to it (computed, never stored,
-- design §3.3), so ordering, the invoice and the payment never add the same
-- cost twice (spec §3.2, T05). cancelled_amount is the sum of the 'cancel'
-- changes; every change of amount or cancellation keeps its reason in
-- purchase_order_changes. cost_type never 'labor' (hours carry labor).
CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    vendor_id INTEGER REFERENCES vendors(id),
    phase_id INTEGER REFERENCES phases(id),
    cost_type TEXT NOT NULL CHECK (cost_type IN ('material','outsource','travel','other')),
    description TEXT,
    ordered_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    cancelled_amount INTEGER NOT NULL DEFAULT 0
        CHECK (cancelled_amount >= 0 AND cancelled_amount <= amount),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    client_request_id TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX purchase_orders_request ON purchase_orders (created_by, client_request_id);
CREATE INDEX purchase_orders_project ON purchase_orders (project_id);

-- kind 'amount': the order amount before/after; 'cancel': the cancelled
-- amount before/after. Rows are only added.
CREATE TABLE purchase_order_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    kind TEXT NOT NULL CHECK (kind IN ('amount','cancel')),
    before_amount INTEGER NOT NULL,
    after_amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX purchase_order_changes_order ON purchase_order_changes (purchase_order_id);

-- One row per direct cost record. amount is tax-exclusive yen (比較は税抜).
-- entry_kind MUST match `cost_domain::direct_cost::RecordKind`:
--   normal / provisional (仮計上): a cost of its own;
--   confirms: replaces the provisional ref_id with the invoiced amount (the
--     provisional no longer counts, spec §6.3);
--   adjustment: a return / cancel / discount of ref_id, the reduction as a
--     positive amount (never a negative normal entry, spec §11).
-- A confirming or adjusting record copies project, phase, cost type, vendor
-- and purchase order from ref_id when it is created. project_id NULL = the
-- cost is split over projects in cost_allocations (T10).
-- status MUST match `cost_domain::time::TimeStatus` (the same workflow as
-- hours). Only approved rows are actuals; an approved row is never edited.
CREATE TABLE direct_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    entry_kind TEXT NOT NULL
        CHECK (entry_kind IN ('normal','provisional','confirms','adjustment')),
    ref_id INTEGER REFERENCES direct_costs(id),
    adjustment_kind TEXT CHECK (adjustment_kind IN ('return','cancel','discount')),
    project_id INTEGER REFERENCES projects(id),
    phase_id INTEGER REFERENCES phases(id),
    cost_type TEXT NOT NULL CHECK (cost_type IN ('material','outsource','travel','other')),
    vendor_id INTEGER REFERENCES vendors(id),
    purchase_order_id INTEGER REFERENCES purchase_orders(id),
    description TEXT,
    booked_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    tax_kind TEXT CHECK (tax_kind IN ('standard','reduced','exempt','out_of_scope')),
    amount_in_tax INTEGER CHECK (amount_in_tax >= 0),
    voucher_no TEXT,
    reason TEXT,
    allocation_basis TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','returned')),
    submitted_at TEXT,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    return_reason TEXT,
    client_request_id TEXT,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((entry_kind IN ('confirms','adjustment')) = (ref_id IS NOT NULL)),
    CHECK ((entry_kind = 'adjustment') = (adjustment_kind IS NOT NULL)),
    CHECK (entry_kind = 'confirms' OR amount > 0)
);

CREATE UNIQUE INDEX direct_costs_request ON direct_costs (user_id, client_request_id);
-- A provisional is confirmed once (T14).
CREATE UNIQUE INDEX direct_costs_one_confirm ON direct_costs (ref_id)
    WHERE entry_kind = 'confirms' AND status = 'approved';
CREATE INDEX direct_costs_project ON direct_costs (project_id);
CREATE INDEX direct_costs_status ON direct_costs (status);
CREATE INDEX direct_costs_ref ON direct_costs (ref_id);
CREATE INDEX direct_costs_order ON direct_costs (purchase_order_id);

-- The split of a cost with no project (T10): the lines sum to the cost's
-- amount; the cost counts on these projects only, never twice.
CREATE TABLE cost_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direct_cost_id INTEGER NOT NULL REFERENCES direct_costs(id),
    line_no INTEGER NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    amount INTEGER NOT NULL CHECK (amount > 0)
);

CREATE UNIQUE INDEX cost_allocations_key ON cost_allocations (direct_cost_id, project_id);
CREATE INDEX cost_allocations_project ON cost_allocations (project_id);
