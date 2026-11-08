-- banto-cost P7c (docs/project/design.md §9.4 items 2 and 6, T38): recurring
-- revenue (定期売上) of a monthly contract.
--
-- One agreement per project: a monthly amount and a closed term (start and
-- end month). Saving it regenerates the project's open revenue plan - one
-- line per month of the term - and its monthly amount × months must equal
-- the confirmed order (`cost_domain::recurring::regenerate`). Each month is
-- recognized on its last day (検収日) by clearing that month's plan line;
-- the recognitions are ordinary `revenue_recognitions` rows, so nothing
-- here is counted as revenue. The amount is never 0 or unset.
CREATE TABLE recurring_revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id),
    monthly_amount INTEGER NOT NULL CHECK (monthly_amount > 0),
    from_month TEXT NOT NULL,
    to_month TEXT NOT NULL,
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    row_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (to_month >= from_month)
);
