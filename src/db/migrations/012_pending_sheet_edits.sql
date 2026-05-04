-- Sheet-edit approval queue. Mirrors pending_outbound: every bot-initiated
-- write to a Google Sheet lands here pending Sid's approval, then gets
-- applied via SheetsClient.updateCell.
--
-- Initial use case (P9): when SyncGitlabMrsJob links an MR to a sheet task,
-- enqueue an append of "MR: <url>\n" to the row's "Task Updates" column —
-- but only if no MR URL is already present in any cell of the row.
CREATE TABLE pending_sheet_edits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id        TEXT NOT NULL,                          -- spreadsheet id
  tab             TEXT NOT NULL,                          -- e.g. 'All Tasks'
  row_index       INTEGER NOT NULL,                       -- 1-based, sheet absolute
  column_match    TEXT NOT NULL,                          -- header startsWith match (e.g. 'Task Updates')
  append_text     TEXT NOT NULL,                          -- the text to append to the cell
  kind            TEXT NOT NULL,                          -- 'mr_link' (room for future kinds)
  context_json    TEXT,                                   -- {sheetItemId, mrItemId, mrUrl, dedupKey, …}
  status          TEXT NOT NULL DEFAULT 'pending',        -- 'pending'|'applied'|'skipped'|'error'
  created_at      INTEGER NOT NULL,
  approved_at     INTEGER,
  applied_at      INTEGER,
  error           TEXT
);
CREATE INDEX idx_pending_sheet_edits_status ON pending_sheet_edits(status, created_at);
CREATE INDEX idx_pending_sheet_edits_dedup  ON pending_sheet_edits(sheet_id, row_index, kind);
