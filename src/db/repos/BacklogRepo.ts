import { getDatabase, type Db } from '../Database.js';

export type BacklogSource =
  | 'sheet'
  | 'gitlab'
  | 'wa_task'
  | 'wa_connect'
  | 'wa_task_update'
  | 'wa_status_check'
  | 'wa_mention_unreplied'
  | 'feature';
export type BacklogStatus = 'open' | 'resolved' | 'snoozed';

export interface BacklogItem {
  id: number;
  source: BacklogSource;
  external_id: string;
  title: string;
  description: string | null;
  url: string | null;
  origin_jid: string | null;
  origin_msg_id: string | null;
  is_dev_task: number | null;
  metadata_json: string | null;
  status: BacklogStatus;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  pinned_for_date: string | null;
  pm_note: string | null;
  snoozed_until: number | null;
  phase_override: string | null;
  expected_outcome: string | null;
  proof_url: string | null;
}

export interface UpsertBacklogInput {
  source: BacklogSource;
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  originJid?: string;
  originMsgId?: string;
  isDevTask?: boolean;
  metadata?: unknown;
}

export class BacklogRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  upsert(input: UpsertBacklogInput): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO backlog_items
        (source, external_id, title, description, url, origin_jid, origin_msg_id,
         is_dev_task, metadata_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET
        title         = excluded.title,
        description   = excluded.description,
        url           = excluded.url,
        origin_jid    = excluded.origin_jid,
        origin_msg_id = excluded.origin_msg_id,
        is_dev_task   = excluded.is_dev_task,
        metadata_json = excluded.metadata_json,
        updated_at    = excluded.updated_at,
        -- Re-open if upstream still has this item. Without this, a single
        -- transient sync failure (which triggers markResolved on items missing
        -- from the seen set) freezes the row as resolved forever even after it
        -- re-appears. Sync jobs only call upsert for items they observed as
        -- open right now, so resetting status here is safe.
        status        = 'open',
        resolved_at   = NULL
    `).run(
      input.source,
      input.externalId,
      input.title,
      input.description ?? null,
      input.url ?? null,
      input.originJid ?? null,
      input.originMsgId ?? null,
      input.isDevTask === undefined ? null : (input.isDevTask ? 1 : 0),
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      now, now
    );
  }

  markResolved(source: BacklogSource, externalId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE backlog_items SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE source = ? AND external_id = ? AND status = 'open'
    `).run(now, now, source, externalId);
  }

  listOpenBySource(source: BacklogSource): BacklogItem[] {
    return this.db.prepare(
      `SELECT * FROM backlog_items WHERE source = ? AND status = 'open' ORDER BY created_at DESC`
    ).all(source) as BacklogItem[];
  }

  listAllOpen(): BacklogItem[] {
    return this.db.prepare(
      `SELECT * FROM backlog_items WHERE status = 'open' ORDER BY source, created_at DESC`
    ).all() as BacklogItem[];
  }

  // Filtered open list — used by /backlog with optional source / search / mine.
  // Search hits title + description + metadata_json; case-insensitive LIKE.
  // `mine` filters by metadata.Allotted to LIKE %name%, scoped to source=sheet.
  // `includeSnoozed` defaults false: snoozed items are time-gated by snoozed_until.
  listOpen(opts: {
    source?: BacklogSource;
    q?: string;
    mineName?: string;
    missingEta?: boolean;
    includeSnoozed?: boolean;
    onlySnoozed?: boolean;
  } = {}): BacklogItem[] {
    const conds: string[] = [`status = 'open'`];
    const params: unknown[] = [];

    if (opts.source) { conds.push('source = ?'); params.push(opts.source); }
    if (opts.q && opts.q.trim()) {
      const like = `%${opts.q.trim().toLowerCase()}%`;
      conds.push(`(LOWER(title) LIKE ? OR LOWER(IFNULL(description,'')) LIKE ? OR LOWER(IFNULL(metadata_json,'')) LIKE ?)`);
      params.push(like, like, like);
    }
    if (opts.mineName) {
      conds.push(`LOWER(IFNULL(json_extract(metadata_json, '$."Allotted to"'), '')) LIKE ?`);
      params.push(`%${opts.mineName.toLowerCase()}%`);
    }
    if (opts.missingEta) {
      conds.push(`(json_extract(metadata_json, '$.ETA') IS NULL OR TRIM(IFNULL(json_extract(metadata_json, '$.ETA'),'')) = '')`);
    }
    if (opts.onlySnoozed) {
      conds.push('snoozed_until IS NOT NULL AND snoozed_until > ?');
      params.push(Date.now());
    } else if (!opts.includeSnoozed) {
      conds.push('(snoozed_until IS NULL OR snoozed_until <= ?)');
      params.push(Date.now());
    }

    // Sort options. ETA / priority sort sheet items by their metadata fields;
    // non-sheet items get pushed to the end so the sort key is meaningful.
    const sort = (opts as { sort?: string }).sort;
    let order = 'source, created_at DESC';
    if (sort === 'recent') order = 'created_at DESC';
    else if (sort === 'oldest') order = 'created_at ASC';
    else if (sort === 'eta') {
      // NULL ETAs last; otherwise lexicographic on the raw ETA text. Imperfect
      // because ETAs in this sheet are like "04/Feb" — proper date parsing would
      // need a CASE WHEN; revisit if this proves misleading in practice.
      order = `CASE WHEN json_extract(metadata_json, '$.ETA') IS NULL OR TRIM(IFNULL(json_extract(metadata_json, '$.ETA'),'')) = '' THEN 1 ELSE 0 END, json_extract(metadata_json, '$.ETA') ASC`;
    } else if (sort === 'priority') {
      order = `CASE WHEN json_extract(metadata_json, '$."New Priority"') IS NULL OR TRIM(IFNULL(json_extract(metadata_json, '$."New Priority"'),'')) = '' THEN 9 ELSE CAST(json_extract(metadata_json, '$."New Priority"') AS INTEGER) END, created_at DESC`;
    }
    const sql = `SELECT * FROM backlog_items WHERE ${conds.join(' AND ')} ORDER BY ${order}`;
    return this.db.prepare(sql).all(...params) as BacklogItem[];
  }

  listOpenExternalIds(source: BacklogSource): Set<string> {
    const rows = this.db.prepare(
      "SELECT external_id FROM backlog_items WHERE source = ? AND status = 'open'"
    ).all(source) as { external_id: string }[];
    return new Set(rows.map(r => r.external_id));
  }

  findByOriginMsgId(msgId: string): BacklogItem | undefined {
    return this.db.prepare(
      'SELECT * FROM backlog_items WHERE origin_msg_id = ?'
    ).get(msgId) as BacklogItem | undefined;
  }

  findByExternalId(source: BacklogSource, externalId: string): BacklogItem | undefined {
    return this.db.prepare(
      'SELECT * FROM backlog_items WHERE source = ? AND external_id = ?'
    ).get(source, externalId) as BacklogItem | undefined;
  }

  findById(id: number): BacklogItem | undefined {
    return this.db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id) as BacklogItem | undefined;
  }

  // ----- pin / today's plan -----

  setNote(id: number, note: string | null): void {
    this.db.prepare('UPDATE backlog_items SET pm_note = ?, updated_at = ? WHERE id = ?')
      .run(note && note.trim() ? note.trim() : null, Date.now(), id);
  }

  setExpectedOutcome(id: number, value: string | null): void {
    this.db.prepare('UPDATE backlog_items SET expected_outcome = ?, updated_at = ? WHERE id = ?')
      .run(value && value.trim() ? value.trim() : null, Date.now(), id);
  }

  setProofUrl(id: number, value: string | null): void {
    this.db.prepare('UPDATE backlog_items SET proof_url = ?, updated_at = ? WHERE id = ?')
      .run(value && value.trim() ? value.trim() : null, Date.now(), id);
  }

  // Snooze for N hours from now. Pass 0 to clear snooze.
  snooze(id: number, hours: number): void {
    const until = hours > 0 ? Date.now() + hours * 3_600_000 : null;
    this.db.prepare('UPDATE backlog_items SET snoozed_until = ?, updated_at = ? WHERE id = ?')
      .run(until, Date.now(), id);
  }

  pin(id: number, date: string): void {
    this.db.prepare(`UPDATE backlog_items SET pinned_for_date = ?, updated_at = ? WHERE id = ?`)
      .run(date, Date.now(), id);
  }

  unpin(id: number): void {
    this.db.prepare(`UPDATE backlog_items SET pinned_for_date = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  listPinnedForDate(date: string): BacklogItem[] {
    return this.db.prepare(
      `SELECT * FROM backlog_items WHERE pinned_for_date = ? AND status = 'open' ORDER BY updated_at DESC`
    ).all(date) as BacklogItem[];
  }

  // Used by the home dashboard scorer to rank across the eligible backlog.
  // Mirrors listAllOpen but excludes signal sources up front.
  listScoreable(): BacklogItem[] {
    return this.db.prepare(`
      SELECT * FROM backlog_items
      WHERE status = 'open'
        AND source NOT IN ('wa_task_update', 'wa_status_check')
      ORDER BY source, created_at DESC
    `).all() as BacklogItem[];
  }

  // Create a manually-grouped feature item. Members are attached via addLink
  // with link_type='feature_member'. external_id is auto-generated since
  // features have no upstream system.
  createFeature(title: string, description?: string): number {
    const now = Date.now();
    const externalId = `feat:${now}:${Math.random().toString(36).slice(2, 8)}`;
    const info = this.db.prepare(`
      INSERT INTO backlog_items
        (source, external_id, title, description, status, created_at, updated_at)
      VALUES ('feature', ?, ?, ?, 'open', ?, ?)
    `).run(externalId, title, description ?? null, now, now);
    return Number(info.lastInsertRowid);
  }

  // ----- backlog_links -----

  addLink(parentId: number, childId: number, linkType: string, source: string, confidence?: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO backlog_links (parent_id, child_id, link_type, source, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parentId, childId, linkType, source, confidence ?? null, Date.now());
  }

  removeLink(parentId: number, childId: number, linkType: string): void {
    this.db.prepare(
      'DELETE FROM backlog_links WHERE parent_id = ? AND child_id = ? AND link_type = ?'
    ).run(parentId, childId, linkType);
  }

  // For a given parent (e.g. a sheet task), return its child rows joined.
  getChildrenOf(parentId: number): Array<BacklogItem & { link_type: string; link_source: string; link_confidence: number | null }> {
    return this.db.prepare(`
      SELECT b.*, l.link_type AS link_type, l.source AS link_source, l.confidence AS link_confidence
      FROM backlog_links l
      JOIN backlog_items b ON b.id = l.child_id
      WHERE l.parent_id = ?
    `).all(parentId) as Array<BacklogItem & { link_type: string; link_source: string; link_confidence: number | null }>;
  }

  // Inverse: for a given child (e.g. an MR), find its parent rows.
  getParentsOf(childId: number): Array<BacklogItem & { link_type: string; link_source: string; link_confidence: number | null }> {
    return this.db.prepare(`
      SELECT b.*, l.link_type AS link_type, l.source AS link_source, l.confidence AS link_confidence
      FROM backlog_links l
      JOIN backlog_items b ON b.id = l.parent_id
      WHERE l.child_id = ?
    `).all(childId) as Array<BacklogItem & { link_type: string; link_source: string; link_confidence: number | null }>;
  }
}
