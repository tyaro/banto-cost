-- banto-cost (docs/project/design.md §10.9, 2026-11-14): 個人別の時間原価単価.
--
-- A person's hourly cost rate for every project (project_id NULL) or for one
-- project. A time entry is costed with, in order: the person's rate for its
-- project, the person's rate, the project's emp_rate override, the company
-- emp_rate (cost_domain::person_rate). Like calc_values a change is a NEW
-- row with an effective date and nothing is updated or deleted; value NULL
-- means "from valid_from on, this person (on this project) has no own rate
-- any more" and falls back to the next level. Approved time entries keep the
-- rate they were costed with; the row it came from is in
-- applied_person_rate_id (applied_calc_value_id stays NULL then).
--
-- Only finance.rate + amount.view see or change these rows (personal rates,
-- design §2.3). No row is seeded: no rate is 未設定, never 0.

CREATE TABLE person_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    project_id INTEGER REFERENCES projects(id),
    valid_from TEXT NOT NULL,
    value INTEGER CHECK (value IS NULL OR value > 0),
    version_no INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per person, scope and effective date; versions are numbered per
-- person and scope (a concurrent save of the same date is refused, T13).
CREATE UNIQUE INDEX person_rates_valid_from
    ON person_rates (user_id, COALESCE(project_id, 0), valid_from);
CREATE UNIQUE INDEX person_rates_version
    ON person_rates (user_id, COALESCE(project_id, 0), version_no);
CREATE INDEX person_rates_project ON person_rates (project_id);

-- The business date check of 0027_date_formats.sql.
CREATE TRIGGER person_rates_dates_insert BEFORE INSERT ON person_rates
WHEN (NEW.valid_from IS NOT NULL AND date(NEW.valid_from, '+0 days') IS NOT NEW.valid_from)
BEGIN
    SELECT RAISE(ABORT, 'person_rates: dates must be YYYY-MM-DD and months YYYY-MM');
END;

CREATE TRIGGER person_rates_dates_update BEFORE UPDATE OF valid_from ON person_rates
WHEN (NEW.valid_from IS NOT OLD.valid_from AND NEW.valid_from IS NOT NULL AND date(NEW.valid_from, '+0 days') IS NOT NEW.valid_from)
BEGIN
    SELECT RAISE(ABORT, 'person_rates: dates must be YYYY-MM-DD and months YYYY-MM');
END;

ALTER TABLE time_entries ADD COLUMN applied_person_rate_id INTEGER REFERENCES person_rates(id);
