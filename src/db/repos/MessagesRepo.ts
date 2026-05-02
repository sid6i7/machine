import { getDatabase, type Db } from '../Database.js';

export interface MessageRow {
  id: string;
  remote_jid: string;
  participant_jid: string;
  is_group: number;
  is_from_me: number;
  text: string | null;
  has_image: number;
  has_media: number;
  media_path: string | null;
  mentions_json: string | null;
  quoted_id: string | null;
  ts: number;
  raw_json: string | null;
  classified_at: number | null;
  push_name: string | null;
  classified_intent?: string | null;       // 'task'|'connect'|'task_update'|'status_check'|'noise'|null
}

export class MessagesRepo {
  private db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDatabase();
  }

  insert(row: MessageRow): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, remote_jid, participant_jid, is_group, is_from_me, text,
         has_image, has_media, media_path, mentions_json, quoted_id,
         ts, raw_json, classified_at, push_name, classified_intent)
      VALUES
        (@id, @remote_jid, @participant_jid, @is_group, @is_from_me, @text,
         @has_image, @has_media, @media_path, @mentions_json, @quoted_id,
         @ts, @raw_json, @classified_at, @push_name, @classified_intent)
    `).run({ classified_intent: null, ...row });
  }

  setClassifiedIntent(id: string, intent: string | null): void {
    this.db.prepare(
      'UPDATE messages SET classified_intent = ?, classified_at = ? WHERE id = ?'
    ).run(intent, Date.now(), id);
  }

  findById(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  findByJidSince(remoteJid: string, sinceTs: number): MessageRow[] {
    return this.db.prepare(
      'SELECT * FROM messages WHERE remote_jid = ? AND ts >= ? ORDER BY ts ASC'
    ).all(remoteJid, sinceTs) as MessageRow[];
  }

  pruneOlderThan(cutoffTs: number): number {
    // Preserve backfilled rows (id starts with 'bf:'). They were inserted on
    // purpose with historical timestamps and are needed for retroactive
    // summaries; pruning them silently is exactly the wrong behavior.
    const info = this.db.prepare(
      "DELETE FROM messages WHERE ts < ? AND id NOT LIKE 'bf:%'"
    ).run(cutoffTs);
    return info.changes;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    return row.c;
  }
}
