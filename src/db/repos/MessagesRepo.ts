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
         ts, raw_json, classified_at)
      VALUES
        (@id, @remote_jid, @participant_jid, @is_group, @is_from_me, @text,
         @has_image, @has_media, @media_path, @mentions_json, @quoted_id,
         @ts, @raw_json, @classified_at)
    `).run(row);
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
    const info = this.db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoffTs);
    return info.changes;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    return row.c;
  }
}
