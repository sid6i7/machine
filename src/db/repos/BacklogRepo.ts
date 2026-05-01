import { getDatabase, type Db } from '../Database.js';

export type BacklogSource = 'sheet' | 'gitlab' | 'wa_task' | 'wa_connect' | 'wa_mention_unreplied';
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

  listOpenBySource(source: BacklogSource): BacklogItem[] {
    return this.db.prepare(
      "SELECT * FROM backlog_items WHERE source = ? AND status = 'open' ORDER BY created_at DESC"
    ).all(source) as BacklogItem[];
  }

  listAllOpen(): BacklogItem[] {
    return this.db.prepare(
      "SELECT * FROM backlog_items WHERE status = 'open' ORDER BY source, created_at DESC"
    ).all() as BacklogItem[];
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
}
