import { getDatabase, type Db } from '../Database.js';

export interface ItemChatEntry {
  id: number;
  backlog_id: number;
  question: string;
  answer: string;
  created_at: number;
}

export class ItemChatRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  insert(backlogId: number, question: string, answer: string): ItemChatEntry {
    const result = this.db.prepare(
      'INSERT INTO item_chat_history (backlog_id, question, answer, created_at) VALUES (?, ?, ?, ?)'
    ).run(backlogId, question, answer, Date.now());
    return this.db.prepare('SELECT * FROM item_chat_history WHERE id = ?').get(result.lastInsertRowid) as ItemChatEntry;
  }

  listForItem(backlogId: number, limit = 30): ItemChatEntry[] {
    return this.db.prepare(
      'SELECT * FROM item_chat_history WHERE backlog_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(backlogId, limit) as ItemChatEntry[];
  }
}
