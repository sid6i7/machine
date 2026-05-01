CREATE TABLE backlog_links (
  parent_id   INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  child_id    INTEGER NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  link_type   TEXT NOT NULL,        -- 'sheet_mr' | 'wa_task_mr' | 'task_update' | 'manual'
  source      TEXT NOT NULL,        -- how we found the link: 'sheet_column' | 'llm' | 'quote' | 'manual'
  confidence  REAL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id, link_type)
);
CREATE INDEX idx_backlog_links_parent ON backlog_links(parent_id);
CREATE INDEX idx_backlog_links_child ON backlog_links(child_id);
