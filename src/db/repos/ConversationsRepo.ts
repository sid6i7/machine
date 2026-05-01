import { getDatabase, type Db } from '../Database.js';

export interface ConversationRow {
  jid: string;
  name: string;
  state: string;
  payload_json: string | null;
  updated_at: number;
}

export class ConversationsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  getState(jid: string, name: string): ConversationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM conversations WHERE jid = ? AND name = ?'
    ).get(jid, name) as ConversationRow | undefined;
  }

  setState(jid: string, name: string, state: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO conversations (jid, name, state, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid, name) DO UPDATE SET
        state        = excluded.state,
        payload_json = excluded.payload_json,
        updated_at   = excluded.updated_at
    `).run(jid, name, state, payload === undefined ? null : JSON.stringify(payload), Date.now());
  }

  clear(jid: string, name: string): void {
    this.db.prepare('DELETE FROM conversations WHERE jid = ? AND name = ?').run(jid, name);
  }

  // Returns all open conversations for a given conversation name (e.g. all
  // members currently in 'tasklist_followup'). Useful for cleanup/sweep jobs.
  listByName(name: string): ConversationRow[] {
    return this.db.prepare(
      'SELECT * FROM conversations WHERE name = ?'
    ).all(name) as ConversationRow[];
  }
}
