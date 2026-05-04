import { getDatabase, type Db } from '../Database.js';

export type SheetEditKind = 'mr_link';
export type SheetEditStatus = 'pending' | 'applied' | 'skipped' | 'error';

export interface PendingSheetEdit {
  id: number;
  sheet_id: string;
  tab: string;
  row_index: number;
  column_match: string;
  append_text: string;
  kind: SheetEditKind;
  context_json: string | null;
  status: SheetEditStatus;
  created_at: number;
  approved_at: number | null;
  applied_at: number | null;
  error: string | null;
}

export interface EnqueueSheetEditOpts {
  sheetId: string;
  tab: string;
  rowIndex: number;
  columnMatch: string;
  appendText: string;
  kind: SheetEditKind;
  context?: Record<string, unknown>;
  // If set, dedup against any pending/applied row with the same dedupKey.
  dedupKey?: string;
}

export class SheetEditQueueRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  enqueue(opts: EnqueueSheetEditOpts): PendingSheetEdit {
    if (opts.dedupKey) {
      const existing = this.db.prepare(`
        SELECT * FROM pending_sheet_edits
        WHERE kind = ? AND sheet_id = ? AND row_index = ?
          AND status IN ('pending', 'applied')
          AND json_extract(context_json, '$.dedupKey') = ?
        ORDER BY id DESC LIMIT 1
      `).get(opts.kind, opts.sheetId, opts.rowIndex, opts.dedupKey) as PendingSheetEdit | undefined;
      if (existing) return existing;
    }
    const ctx = opts.context
      ? { ...opts.context, dedupKey: opts.dedupKey }
      : (opts.dedupKey ? { dedupKey: opts.dedupKey } : null);
    const result = this.db.prepare(`
      INSERT INTO pending_sheet_edits
        (sheet_id, tab, row_index, column_match, append_text, kind, context_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      opts.sheetId,
      opts.tab,
      opts.rowIndex,
      opts.columnMatch,
      opts.appendText,
      opts.kind,
      ctx ? JSON.stringify(ctx) : null,
      Date.now(),
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): PendingSheetEdit | undefined {
    return this.db.prepare('SELECT * FROM pending_sheet_edits WHERE id = ?').get(id) as PendingSheetEdit | undefined;
  }

  listPending(): PendingSheetEdit[] {
    return this.db.prepare(
      `SELECT * FROM pending_sheet_edits WHERE status = 'pending' ORDER BY created_at ASC`
    ).all() as PendingSheetEdit[];
  }

  listRecent(limit = 50): PendingSheetEdit[] {
    return this.db.prepare(
      `SELECT * FROM pending_sheet_edits ORDER BY id DESC LIMIT ?`
    ).all(limit) as PendingSheetEdit[];
  }

  pendingCount(): number {
    const r = this.db.prepare(
      `SELECT COUNT(*) as c FROM pending_sheet_edits WHERE status = 'pending'`
    ).get() as { c: number };
    return r.c;
  }

  updateAppendText(id: number, text: string): void {
    this.db.prepare(
      `UPDATE pending_sheet_edits SET append_text = ? WHERE id = ? AND status = 'pending'`
    ).run(text, id);
  }

  markApplied(id: number): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE pending_sheet_edits SET status = 'applied', approved_at = COALESCE(approved_at, ?), applied_at = ?, error = NULL WHERE id = ?`
    ).run(now, now, id);
  }

  markSkipped(id: number): void {
    this.db.prepare(
      `UPDATE pending_sheet_edits SET status = 'skipped', approved_at = ? WHERE id = ?`
    ).run(Date.now(), id);
  }

  markError(id: number, err: string): void {
    this.db.prepare(
      `UPDATE pending_sheet_edits SET status = 'error', error = ?, approved_at = ? WHERE id = ?`
    ).run(err, Date.now(), id);
  }

  retry(id: number): void {
    this.db.prepare(
      `UPDATE pending_sheet_edits SET status = 'pending', error = NULL WHERE id = ? AND status = 'error'`
    ).run(id);
  }
}
