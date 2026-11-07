-- banto-cost P6a 追補 (docs/project/design.md §3.5.1, T17): 精算完了の取消（再開）.
--
-- A settled project may be reopened back to 作業完了 with a reason
-- (2026-11-07 decision). The settlement and its waivers stay as they were;
-- one closeout_reopenings row records that the settlement was cancelled:
-- the business date, the reason and who. A reopened project is settled
-- again through the check, which writes a new project_closeouts row, so a
-- project now has one settlement per round (the unique index goes; the
-- project's status and row_version decide which round is current).
--
-- Rows are never rewritten or deleted.
DROP INDEX project_closeouts_project;

CREATE INDEX project_closeouts_project ON project_closeouts (project_id);

CREATE TABLE closeout_reopenings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    closeout_id INTEGER NOT NULL REFERENCES project_closeouts(id),
    reopened_on TEXT NOT NULL,
    reason TEXT NOT NULL,
    reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A settlement is cancelled at most once.
CREATE UNIQUE INDEX closeout_reopenings_closeout ON closeout_reopenings (closeout_id);
