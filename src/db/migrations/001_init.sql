CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  remote_jid      TEXT NOT NULL,
  participant_jid TEXT NOT NULL,
  is_group        INTEGER NOT NULL,
  is_from_me      INTEGER NOT NULL,
  text            TEXT,
  has_image       INTEGER NOT NULL DEFAULT 0,
  has_media       INTEGER NOT NULL DEFAULT 0,
  media_path      TEXT,
  mentions_json   TEXT,
  quoted_id       TEXT,
  ts              INTEGER NOT NULL,
  raw_json        TEXT,
  classified_at   INTEGER
);
CREATE INDEX idx_messages_jid_ts ON messages(remote_jid, ts);
CREATE INDEX idx_messages_classified ON messages(classified_at, ts);
CREATE INDEX idx_messages_participant_ts ON messages(participant_jid, ts);

CREATE TABLE scheduler_runs (
  job_name TEXT NOT NULL,
  ran_at   INTEGER NOT NULL,
  ok       INTEGER NOT NULL,
  error    TEXT
);
CREATE INDEX idx_scheduler_runs_job_time ON scheduler_runs(job_name, ran_at);

CREATE TABLE daily_runs (
  date     TEXT NOT NULL,
  job_name TEXT NOT NULL,
  ran_at   INTEGER NOT NULL,
  PRIMARY KEY (date, job_name)
);
