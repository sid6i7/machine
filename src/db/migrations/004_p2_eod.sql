CREATE TABLE eod_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL UNIQUE,            -- 'YYYY-MM-DD' IST
  posted_at   INTEGER,
  summary_md  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE eod_answers (
  session_id   INTEGER NOT NULL REFERENCES eod_sessions(id) ON DELETE CASCADE,
  member_jid   TEXT NOT NULL,
  question_idx INTEGER NOT NULL,                -- 0=done, 1=left, 2=blockers
  text         TEXT NOT NULL,
  recorded_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, member_jid, question_idx)
);
CREATE INDEX idx_eod_answers_member ON eod_answers(member_jid, session_id);
