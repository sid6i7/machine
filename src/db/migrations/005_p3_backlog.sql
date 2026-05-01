CREATE TABLE backlog_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,                 -- 'sheet' | 'gitlab' | 'wa_task' | 'wa_connect' | 'wa_mention_unreplied'
  external_id   TEXT NOT NULL,                 -- sheet row id | 'projectId:mrIid' | wa msg id
  title         TEXT NOT NULL,
  description   TEXT,
  url           TEXT,
  origin_jid    TEXT,                          -- group/chat the wa_* item came from
  origin_msg_id TEXT,                          -- messages.id for wa_* sources
  is_dev_task   INTEGER,                       -- 1|0|NULL (set only for wa_task)
  metadata_json TEXT,                          -- source-specific payload
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'snoozed'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  UNIQUE(source, external_id)
);
CREATE INDEX idx_backlog_status_source ON backlog_items(status, source);
CREATE INDEX idx_backlog_origin_msg ON backlog_items(origin_msg_id);

CREATE TABLE oauth_tokens (
  provider      TEXT PRIMARY KEY,             -- 'google'
  access_token  TEXT,
  refresh_token TEXT,
  expiry        INTEGER,
  scope         TEXT,
  updated_at    INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN classified_intent TEXT;
