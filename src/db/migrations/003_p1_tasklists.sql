CREATE TABLE tasklists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_jid      TEXT NOT NULL,
  date            TEXT NOT NULL,                -- 'YYYY-MM-DD' IST
  source_msg_id   TEXT,                         -- messages.id (no FK; allows pruning)
  items_json      TEXT NOT NULL,                -- JSON array of { text, est_hours? }
  raw_text        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(member_jid, date)
);
CREATE INDEX idx_tasklists_date ON tasklists(date);

CREATE TABLE conversations (
  jid          TEXT NOT NULL,
  name         TEXT NOT NULL,                   -- 'tasklist_followup' | 'eod_standup' | ...
  state        TEXT NOT NULL,
  payload_json TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (jid, name)
);
