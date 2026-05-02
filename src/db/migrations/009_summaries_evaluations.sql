-- Daily / weekly per-member narrative summaries + team weekly roll-up.
-- Persisted so re-renders don't re-LLM. Re-running a job overwrites the same
-- (member_jid, period_kind, period_start) row; team analogue is keyed similarly.
CREATE TABLE member_summaries (
  member_jid     TEXT NOT NULL,
  period_kind    TEXT NOT NULL,          -- 'day' | 'week'
  period_start   TEXT NOT NULL,          -- 'YYYY-MM-DD' IST (day = the date itself; week = Monday)
  summary_md     TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  generated_at   INTEGER NOT NULL,
  PRIMARY KEY (member_jid, period_kind, period_start)
);
CREATE INDEX idx_member_summaries_period ON member_summaries(period_kind, period_start);

CREATE TABLE team_summaries (
  period_kind    TEXT NOT NULL,          -- 'week' (room for 'day' later)
  period_start   TEXT NOT NULL,          -- Monday YYYY-MM-DD IST
  summary_md     TEXT NOT NULL,
  made_live_md   TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  generated_at   INTEGER NOT NULL,
  PRIMARY KEY (period_kind, period_start)
);

-- Weekly evaluation rubric. Drafts are saved_at IS NULL and re-prefillable.
-- Once Sid clicks Save, saved_at is set and prefill stops touching the row.
CREATE TABLE member_evaluations (
  week_start_date  TEXT NOT NULL,        -- Monday YYYY-MM-DD IST
  member_jid       TEXT NOT NULL,
  score_properly   INTEGER,              -- 0-6
  score_on_time    INTEGER,              -- 0-6
  score_updates    INTEGER,              -- 0-6
  score_feedback   INTEGER,              -- 0-1
  feedback_text    TEXT,
  evidence_json    TEXT,                 -- snapshot at prefill time, kept for audit
  saved_at         INTEGER,              -- non-null = finalized
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (week_start_date, member_jid)
);

-- Append-only log of MRs that have shipped. Powers "what we made live this week".
-- SyncGitlabMrsJob walks merged-MR pages until it hits an external_id we already
-- have, so the log stays cheap to maintain.
CREATE TABLE gitlab_merged_log (
  external_id    TEXT PRIMARY KEY,       -- 'project_id:mr_iid'
  title          TEXT NOT NULL,
  author         TEXT,
  source_branch  TEXT,
  target_branch  TEXT NOT NULL,
  merged_at      INTEGER NOT NULL,       -- ms epoch
  url            TEXT,
  metadata_json  TEXT
);
CREATE INDEX idx_gitlab_merged_at ON gitlab_merged_log(merged_at);
CREATE INDEX idx_gitlab_merged_target_at ON gitlab_merged_log(target_branch, merged_at);
