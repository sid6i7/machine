-- PM-only annotation per backlog item. Single overwriteable note (history
-- not kept v1 — keep simple; if needed later, split into backlog_notes table).
ALTER TABLE backlog_items ADD COLUMN pm_note TEXT;

-- Snooze deadline. When set, item is hidden from open lists until past this
-- timestamp. status stays 'open'; `snoozed_until` is the gating filter.
-- Distinct from 'snoozed' status so the gate is purely time-based.
ALTER TABLE backlog_items ADD COLUMN snoozed_until INTEGER;
CREATE INDEX idx_backlog_snooze ON backlog_items(snoozed_until) WHERE snoozed_until IS NOT NULL;
