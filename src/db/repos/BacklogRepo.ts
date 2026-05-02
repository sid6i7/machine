import { getDatabase, type Db } from '../Database.js';

export type BacklogSource =
  | 'sheet'
  | 'gitlab'
  | 'wa_task'
  | 'wa_connect'
  | 'wa_task_update'
  | 'wa_status_check'
  | 'wa_mention_unreplied';
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
        updated_at    = excluded.updated_at
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

  listOpenBySource(source: BacklogSource, opts: { includeBackfill?: boolean } = {}): BacklogItem[] {
    const filter = opts.includeBackfill ? '' : "AND (origin_jid IS NULL OR origin_jid NOT LIKE 'backfill:%')";
    return this.db.prepare(
      `SELECT * FROM backlog_items WHERE source = ? AND status = 'open' ${filter} ORDER BY created_at DESC`
    ).all(source) as BacklogItem[];
  }

  listAllOpen(opts: { includeBackfill?: boolean } = {}): BacklogItem[] {
    const filter = opts.includeBackfill ? '' : "AND (origin_jid IS NULL OR origin_jid NOT LIKE 'backfill:%')";
    return this.db.prepare(
      `SELECT * FROM backlog_items WHERE status = 'open' ${filter} ORDER BY source, created_at DESC`
    ).all() as BacklogItem[];
  }

  // Filtered open list — used by /backlog with optional source / search / mine.
  // Search hits title + description + metadata_json; case-insensitive LIKE.
  // `mine` filters by metadata.Allotted to LIKE %name%, scoped to source=sheet.
  listOpen(opts: {
    source?: BacklogSource;
    includeBackfill?: boolean;
    q?: string;
    mineName?: string;        // assignee substring; matches metadata.Allotted to
    missingEta?: boolean;     // sheet items where metadata.ETA is empty
  } = {}): BacklogItem[] {
    const conds: string[] = [`status = 'open'`];
    const params: unknown[] = [];

    if (opts.source) { conds.push('source = ?'); params.push(opts.source); }
    if (!opts.includeBackfill) conds.push("(origin_jid IS NULL OR origin_jid NOT LIKE 'backfill:%')");
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

    const sql = `SELECT * FROM backlog_items WHERE ${conds.join(' AND ')} ORDER BY source, created_at DESC`;
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

  // Used by /plan-day to score across the entire scored-eligible backlog.
  // Mirrors listAllOpen but excludes signal sources up front.
  listScoreable(opts: { includeBackfill?: boolean } = {}): BacklogItem[] {
    const filter = opts.includeBackfill ? '' : "AND (origin_jid IS NULL OR origin_jid NOT LIKE 'backfill:%')";
    return this.db.prepare(`
      SELECT * FROM backlog_items
      WHERE status = 'open'
        AND source NOT IN ('wa_task_update', 'wa_status_check')
        ${filter}
      ORDER BY source, created_at DESC
    `).all() as BacklogItem[];
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
