-- Claude-Code-driven MR reviews. One row per review attempt; suggestions live
-- in mr_review_suggestions. Reviews surface on /approvals when status='finished'
-- and stay around as history once status='submitted'/'discarded'.
CREATE TABLE mr_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mr_backlog_id     INTEGER,                            -- FK to backlog_items (gitlab MR row); NULL if reviewing arbitrary branch later
  mr_external_id    TEXT NOT NULL,                      -- "<projectId>:<iid>"
  mr_url            TEXT NOT NULL,
  mr_title          TEXT NOT NULL,
  source_branch     TEXT NOT NULL,
  target_branch     TEXT NOT NULL,
  project_path      TEXT NOT NULL,                      -- "namespace/repo" (clone URL suffix)
  worktree_path     TEXT,                               -- absolute path to the per-review worktree
  model             TEXT NOT NULL,
  level             TEXT NOT NULL,                      -- 'critical_only' | 'critical_plus_correctness' | 'thorough'
  status            TEXT NOT NULL DEFAULT 'queued',     -- queued | running | finished | submitting | submitted | failed | cancelled | discarded
  pid               INTEGER,
  session_id        TEXT,                               -- Claude Code session id from stream-json
  log_path          TEXT,                               -- raw stream-json log
  transcript        TEXT NOT NULL DEFAULT '',           -- accumulated assistant text (visible progress)
  cost_usd          REAL,
  duration_ms       INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  submitted_at      INTEGER,
  push_commit_sha   TEXT,
  error             TEXT
);
CREATE INDEX idx_mr_reviews_status ON mr_reviews(status, created_at);

CREATE TABLE mr_review_suggestions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id         INTEGER NOT NULL REFERENCES mr_reviews(id) ON DELETE CASCADE,
  file              TEXT NOT NULL,
  line_start        INTEGER NOT NULL,
  line_end          INTEGER NOT NULL,
  severity          TEXT NOT NULL,                      -- critical | high | medium | low
  rationale         TEXT NOT NULL,
  original          TEXT NOT NULL,                      -- exact existing text (must match file content for apply)
  replacement       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | rejected | applied | apply_failed
  decided_at        INTEGER,
  apply_error       TEXT,
  created_at        INTEGER NOT NULL,
  -- enqueue-time dedup so a stuttering agent that emits the same block twice
  -- doesn't spam the UI
  fingerprint       TEXT NOT NULL,
  UNIQUE(review_id, fingerprint)
);
CREATE INDEX idx_mr_review_suggestions_review ON mr_review_suggestions(review_id, status);
