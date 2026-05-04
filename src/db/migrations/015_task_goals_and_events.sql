-- Per-task end-goal expectation and verifiable proof (e.g. demo video URL).
-- Both are PM-editable free text; no parsing, no validation beyond "looks like a URL"
-- on the client. Kept as flat columns (not JSON) to make /backlog list queries simple.
ALTER TABLE backlog_items ADD COLUMN expected_outcome TEXT;
ALTER TABLE backlog_items ADD COLUMN proof_url TEXT;

-- Append-only timeline events for a backlog item. The existing /timeline endpoint
-- already aggregates linked children/parents/chats — this table captures the
-- *actions* taken on the item (snoozed, resolved, mr_linked, actionable_added,
-- actionable_removed, actionable_toggled, note_saved, goal_set, proof_set, pinned,
-- unpinned, chat_created, mr_review_started). text is the human-readable summary;
-- metadata_json holds structured detail when useful.
CREATE TABLE backlog_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  backlog_id      INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  text            TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_backlog_events_item ON backlog_events(backlog_id, created_at);
