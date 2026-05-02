import { getDatabase, type Db } from '../Database.js';

export type OutboundKind =
  | 'tasklist_nudge'
  | 'eod_check_in'
  | 'eod_summary'
  | 'eod_summary_dm';

export type OutboundStatus = 'pending' | 'sent' | 'skipped' | 'error';

export interface PendingOutbound {
  id: number;
  to_jid: string;
  body: string;
  mentions_json: string | null;
  kind: OutboundKind;
  context_json: string | null;
  status: OutboundStatus;
  created_at: number;
  approved_at: number | null;
  sent_at: number | null;
  error: string | null;
}

export interface EnqueueOpts {
  toJid: string;
  body: string;
  kind: OutboundKind;
  mentions?: string[];
  context?: Record<string, unknown>;
  // If set, return existing pending row for this (kind, to_jid, dedupKey) instead
  // of inserting a duplicate. Useful for jobs that may run more than once a day.
  dedupKey?: string;
}

export class OutboundQueueRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  enqueue(opts: EnqueueOpts): PendingOutbound {
    if (opts.dedupKey) {
      const existing = this.db.prepare(`
        SELECT * FROM pending_outbound
        WHERE kind = ? AND to_jid = ? AND status IN ('pending', 'sent')
          AND json_extract(context_json, '$.dedupKey') = ?
        ORDER BY id DESC LIMIT 1
      `).get(opts.kind, opts.toJid, opts.dedupKey) as PendingOutbound | undefined;
      if (existing) return existing;
    }
    const ctx = opts.context ? { ...opts.context, dedupKey: opts.dedupKey } : (opts.dedupKey ? { dedupKey: opts.dedupKey } : null);
    const result = this.db.prepare(`
      INSERT INTO pending_outbound (to_jid, body, mentions_json, kind, context_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      opts.toJid,
      opts.body,
      opts.mentions && opts.mentions.length ? JSON.stringify(opts.mentions) : null,
      opts.kind,
      ctx ? JSON.stringify(ctx) : null,
      Date.now(),
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): PendingOutbound | undefined {
    return this.db.prepare('SELECT * FROM pending_outbound WHERE id = ?').get(id) as PendingOutbound | undefined;
  }

  listPending(): PendingOutbound[] {
    return this.db.prepare(
      `SELECT * FROM pending_outbound WHERE status = 'pending' ORDER BY created_at ASC`
    ).all() as PendingOutbound[];
  }

  listRecent(limit = 50): PendingOutbound[] {
    return this.db.prepare(
      `SELECT * FROM pending_outbound ORDER BY id DESC LIMIT ?`
    ).all(limit) as PendingOutbound[];
  }

  pendingCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) as c FROM pending_outbound WHERE status = 'pending'`).get() as { c: number };
    return r.c;
  }

  // Optional body edit on approve. Caller is responsible for actually sending;
  // markSent() / markError() are the terminal transitions.
  updateBody(id: number, body: string): void {
    this.db.prepare(`UPDATE pending_outbound SET body = ? WHERE id = ? AND status = 'pending'`).run(body, id);
  }

  markSent(id: number): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE pending_outbound SET status = 'sent', approved_at = COALESCE(approved_at, ?), sent_at = ?, error = NULL WHERE id = ?`
    ).run(now, now, id);
  }

  markSkipped(id: number): void {
    this.db.prepare(`UPDATE pending_outbound SET status = 'skipped', approved_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  markError(id: number, err: string): void {
    this.db.prepare(`UPDATE pending_outbound SET status = 'error', error = ?, approved_at = ? WHERE id = ?`).run(err, Date.now(), id);
  }

  // Reset 'error' rows back to 'pending' so the user can retry.
  retry(id: number): void {
    this.db.prepare(`UPDATE pending_outbound SET status = 'pending', error = NULL WHERE id = ? AND status = 'error'`).run(id);
  }

  // Look up the most recent successfully-sent outbound of a given kind to a
  // given recipient. EodReplyCaptureHook uses this to gate DM capture to the
  // window after the kickoff DM was actually sent.
  findLastSent(toJid: string, kind: OutboundKind): PendingOutbound | undefined {
    return this.db.prepare(
      `SELECT * FROM pending_outbound WHERE to_jid = ? AND kind = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`
    ).get(toJid, kind) as PendingOutbound | undefined;
  }
}
