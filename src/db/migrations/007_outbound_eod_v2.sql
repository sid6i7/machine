-- Outbound approval queue: every bot-initiated message to a non-Sid recipient
-- lands here pending manual approval via /outbound, then gets sent.
CREATE TABLE pending_outbound (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  to_jid        TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions_json TEXT,                          -- JSON array of JIDs (Baileys mentions)
  kind          TEXT NOT NULL,                 -- 'tasklist_nudge'|'eod_check_in'|'eod_summary'|'eod_summary_dm'
  context_json  TEXT,                          -- {memberJid, sessionId, date, ...}
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'sent'|'skipped'|'error'
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  sent_at       INTEGER,
  error         TEXT
);
CREATE INDEX idx_pending_outbound_status ON pending_outbound(status, created_at);
CREATE INDEX idx_pending_outbound_to ON pending_outbound(to_jid, kind, created_at);

-- New EOD storage: one combined free-form reply per (session, member),
-- optionally parsed by Gemini into structured done/left/blockers. Replaces
-- the old eod_answers (kept around but unused).
CREATE TABLE eod_replies (
  session_id      INTEGER NOT NULL REFERENCES eod_sessions(id) ON DELETE CASCADE,
  member_jid      TEXT NOT NULL,
  raw_reply       TEXT NOT NULL,
  parsed_done     TEXT,
  parsed_left     TEXT,
  parsed_blockers TEXT,
  recorded_at     INTEGER NOT NULL,
  parsed_at       INTEGER,
  PRIMARY KEY (session_id, member_jid)
);
