-- Feature-suggestion store. Populated daily by SuggestFeaturesJob and rendered
-- in the backlog UI for one-click human accept/reject. Two kinds:
--   'new_feature' → propose a new feature (BacklogItem source='feature') made
--                   up of N orphan members. accepted_feature_id is set on accept.
--   'member_add'  → propose attaching one orphan item to an existing feature.
--                   feature_id is the target feature.
--
-- member_set_hash dedupes proposals across runs so dismissed sets aren't
-- re-suggested. If members change (a new MR appears), the hash changes and
-- a fresh suggestion is allowed — desirable.
CREATE TABLE feature_suggestions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,                -- 'new_feature' | 'member_add'
  feature_id          INTEGER REFERENCES backlog_items(id) ON DELETE CASCADE,
  proposed_title      TEXT,
  proposed_desc       TEXT,
  rationale           TEXT,
  confidence          REAL NOT NULL,
  signals_json        TEXT,
  member_set_hash     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|dismissed|superseded
  created_at          INTEGER NOT NULL,
  decided_at          INTEGER,
  decided_by          TEXT,
  accepted_feature_id INTEGER REFERENCES backlog_items(id) ON DELETE SET NULL,
  UNIQUE(member_set_hash, kind)
);
CREATE INDEX idx_fs_status ON feature_suggestions(status, created_at DESC);
CREATE INDEX idx_fs_feature ON feature_suggestions(feature_id);

CREATE TABLE feature_suggestion_members (
  suggestion_id  INTEGER NOT NULL REFERENCES feature_suggestions(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  reason         TEXT,                              -- 'hard_link' | 'token_overlap' | 'llm'
  PRIMARY KEY (suggestion_id, item_id)
);
CREATE INDEX idx_fsm_item ON feature_suggestion_members(item_id);
