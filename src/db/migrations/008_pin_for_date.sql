-- Pin a backlog item to a specific date so it shows up in "Today's plan".
-- Manual pin (button on each row) or auto-pin from the heuristic Plan-my-Day.
-- One date per item; pinning to a new date overwrites.
ALTER TABLE backlog_items ADD COLUMN pinned_for_date TEXT;
CREATE INDEX idx_backlog_pinned ON backlog_items(pinned_for_date) WHERE pinned_for_date IS NOT NULL;
