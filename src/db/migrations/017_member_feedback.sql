-- Free-form daily feedback notes the PM logs about a team member, usually
-- tied to an MR review or other backlog item. Surfaced as evidence in the
-- weekly evaluation prefill (Friday 21:05) so that on Saturday morning the
-- PM has a recall of how each member did across the week.
--
-- backlog_item_id is optional and points at the unified backlog_items table,
-- which already covers GitLab MRs (source='gitlab'), sheet rows (source='sheet')
-- and grouped features (source='feature') — one nullable FK covers all three.
CREATE TABLE member_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_jid      TEXT NOT NULL,
  feedback_date   TEXT NOT NULL,                          -- YYYY-MM-DD IST
  text            TEXT NOT NULL,
  backlog_item_id INTEGER REFERENCES backlog_items(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,                          -- 'whatsapp' | 'web'
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_member_feedback_member_date ON member_feedback(member_jid, feedback_date);
CREATE INDEX idx_member_feedback_date ON member_feedback(feedback_date);
CREATE INDEX idx_member_feedback_backlog ON member_feedback(backlog_item_id);
