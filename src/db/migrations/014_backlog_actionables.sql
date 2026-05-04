-- SDLC phase + per-task actionables.
--
-- Phase is computed at read time from existing signals (sheet status, linked
-- MR state, target branch, sprint metadata). This column is the manual
-- override; NULL means "use the inferred phase".
ALTER TABLE backlog_items ADD COLUMN phase_override TEXT;

-- Per-task to-do list. Two species in one table:
--   * template_key NOT NULL → seeded from PHASE_TEMPLATES at first view of the task
--     for that phase. UNIQUE constraint blocks duplicate seeds.
--   * template_key NULL    → freeform actionable the user typed in.
-- target=self is a personal todo. Anything else is dispatchable to outbound;
-- pending_outbound_id links the resulting draft for status display.
CREATE TABLE backlog_actionables (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  backlog_id            INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  phase                 TEXT NOT NULL,    -- one of: intake|refined|in_sprint|in_dev|in_review|released
  template_key          TEXT,             -- slug if seeded; NULL if custom
  text                  TEXT NOT NULL,
  target                TEXT NOT NULL DEFAULT 'self',  -- self|owner|mr_author
  is_done               INTEGER NOT NULL DEFAULT 0,
  done_at               INTEGER,
  pending_outbound_id   INTEGER REFERENCES pending_outbound(id),
  created_at            INTEGER NOT NULL,
  UNIQUE (backlog_id, template_key)
);
CREATE INDEX idx_actionables_backlog ON backlog_actionables(backlog_id);
