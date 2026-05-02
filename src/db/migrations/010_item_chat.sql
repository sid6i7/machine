-- Per-item chat history. Each Q is independent (no multi-turn context fed
-- back to the LLM v1) but we keep a per-item log so re-opening shows past Qs.
CREATE TABLE item_chat_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  backlog_id  INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_item_chat_backlog ON item_chat_history(backlog_id, created_at);
