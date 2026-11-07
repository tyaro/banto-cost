-- banto-cost P6b-2 (docs/project/design.md §3.5.3, spec §8 / §11, T11):
-- correcting an approved time entry (締め後の訂正).
--
-- An approved entry is never rewritten. A correction is a new row of the
-- same person that names the entry it replaces (corrects_id) with a reason
-- (correction_reason, required by the service), is submitted at once and
-- approved again by accounting. Once the correction is approved the entry it
-- names drops out of every figure (it stays for the history); a returned
-- correction is history only and counts as nothing.
--
-- At most one correction of an entry is in flight or approved: a second one
-- has to correct the approved correction instead (the newest row of the
-- chain is the one that counts). Returned corrections may pile up.
ALTER TABLE time_entries ADD COLUMN corrects_id INTEGER REFERENCES time_entries(id);
ALTER TABLE time_entries ADD COLUMN correction_reason TEXT;

CREATE UNIQUE INDEX time_entries_one_correction ON time_entries (corrects_id)
    WHERE corrects_id IS NOT NULL AND status IN ('submitted','approved');
CREATE INDEX time_entries_corrects ON time_entries (corrects_id);
