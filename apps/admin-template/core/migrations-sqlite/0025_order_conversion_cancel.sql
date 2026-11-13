-- banto-cost P8f (docs/project/design.md §3.2.2, T40, review U-3): 受注転換の取消.
--
-- A conversion made by mistake (the wrong project, for example) may be
-- cancelled with a reason while nothing has been recorded on the order yet
-- (`cost_domain::order::check_conversion_cancel`). The project goes back to
-- the status it had before the conversion and may be converted again, so a
-- project now has at most one *active* conversion: the inline UNIQUE on
-- project_id becomes a partial unique index over the rows not cancelled.
--
-- SQLite cannot drop an inline UNIQUE, so the table is rebuilt with the same
-- columns plus the cancellation (business date, reason, who, when). No table
-- references order_conversions, so the rebuild drops nothing else. Cancelled
-- rows are never rewritten or deleted.
CREATE TABLE order_conversions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    source_pipeline_version_id INTEGER REFERENCES pipeline_versions(id),
    previous_status TEXT NOT NULL,
    converted_on TEXT NOT NULL,
    confirmed_amount INTEGER NOT NULL CHECK (confirmed_amount > 0),
    scope TEXT NOT NULL CHECK (scope IN ('whole','partial')),
    remainder_project_id INTEGER REFERENCES projects(id),
    basis TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_on TEXT,
    cancel_reason TEXT,
    cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TEXT,
    CHECK ((cancelled_at IS NULL AND cancelled_on IS NULL AND cancel_reason IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_on IS NOT NULL AND cancel_reason IS NOT NULL))
);

INSERT INTO order_conversions_new (id, project_id, source_pipeline_version_id,
    previous_status, converted_on, confirmed_amount, scope, remainder_project_id,
    basis, created_by, created_at)
SELECT id, project_id, source_pipeline_version_id, previous_status, converted_on,
    confirmed_amount, scope, remainder_project_id, basis, created_by, created_at
FROM order_conversions;

DROP TABLE order_conversions;

ALTER TABLE order_conversions_new RENAME TO order_conversions;

CREATE INDEX order_conversions_project ON order_conversions (project_id);

-- At most one conversion that is not cancelled per project.
CREATE UNIQUE INDEX order_conversions_active ON order_conversions (project_id)
    WHERE cancelled_at IS NULL;
