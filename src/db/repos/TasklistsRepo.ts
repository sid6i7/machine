import { getDatabase, type Db } from '../Database.js';
import { istDateString } from '../../utils/time.js';

export interface TasklistItem {
  text: string;
  est_hours?: number;
}

export interface TasklistRow {
  id: number;
  member_jid: string;
  date: string;
  source_msg_id: string | null;
  items_json: string;
  raw_text: string;
  created_at: number;
}

export interface UpsertTasklistInput {
  memberJid: string;
  date: string;                  // IST 'YYYY-MM-DD'
  sourceMsgId?: string;
  items: TasklistItem[];
  rawText: string;
}

export class TasklistsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  upsert(input: UpsertTasklistInput): void {
    this.db.prepare(`
      INSERT INTO tasklists (member_jid, date, source_msg_id, items_json, raw_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_jid, date) DO UPDATE SET
        source_msg_id = excluded.source_msg_id,
        items_json    = excluded.items_json,
        raw_text      = excluded.raw_text
    `).run(
      input.memberJid,
      input.date,
      input.sourceMsgId ?? null,
      JSON.stringify(input.items),
      input.rawText,
      Date.now()
    );
  }

  hasSubmittedToday(memberJid: string, dateOverride?: string): boolean {
    const date = dateOverride ?? istDateString();
    const row = this.db.prepare(
      'SELECT 1 FROM tasklists WHERE member_jid = ? AND date = ?'
    ).get(memberJid, date);
    return row !== undefined;
  }

  getForDate(date: string): TasklistRow[] {
    return this.db.prepare(
      'SELECT * FROM tasklists WHERE date = ?'
    ).all(date) as TasklistRow[];
  }

  getForMemberDate(memberJid: string, date: string): TasklistRow | undefined {
    return this.db.prepare(
      'SELECT * FROM tasklists WHERE member_jid = ? AND date = ?'
    ).get(memberJid, date) as TasklistRow | undefined;
  }
}
