-- banto-cost P8f (docs/project/design.md §3.2.2, T40, review U-3): 受注転換の取消.
--
-- A conversion made by mistake may be cancelled with a reason while nothing
-- has been recorded on the order yet (`cost_domain::order::check_conversion_cancel`).
-- The project goes back to its status before the conversion and may be
-- converted again, so the UNIQUE on project_id becomes a partial unique index
-- over the rows not cancelled. Cancelled rows are never rewritten or deleted.
ALTER TABLE order_conversions DROP CONSTRAINT order_conversions_project_id_key;

ALTER TABLE order_conversions ADD COLUMN cancelled_on TEXT;
ALTER TABLE order_conversions ADD COLUMN cancel_reason TEXT;
ALTER TABLE order_conversions ADD COLUMN cancelled_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE order_conversions ADD COLUMN cancelled_at TEXT;
ALTER TABLE order_conversions ADD CONSTRAINT order_conversions_cancel_complete
    CHECK ((cancelled_at IS NULL AND cancelled_on IS NULL AND cancel_reason IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_on IS NOT NULL AND cancel_reason IS NOT NULL));

CREATE INDEX order_conversions_project ON order_conversions (project_id);

-- At most one conversion that is not cancelled per project.
CREATE UNIQUE INDEX order_conversions_active ON order_conversions (project_id)
    WHERE cancelled_at IS NULL;
