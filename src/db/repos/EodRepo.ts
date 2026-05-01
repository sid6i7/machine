import { getDatabase, type Db } from '../Database.js';

export interface EodSession {
  id: number;
  date: string;
  posted_at: number | null;
  summary_md: string | null;
  created_at: number;
}

export interface EodAnswer {
  session_id: number;
  member_jid: string;
  question_idx: number;
  text: string;
  recorded_at: number;
}

export class EodRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  // Idempotent — returns the existing session for the date if present.
  ensureSession(date: string): EodSession {
    const existing = this.getSession(date);
    if (existing) return existing;
    const result = this.db.prepare(
      'INSERT INTO eod_sessions (date, created_at) VALUES (?, ?)'
    ).run(date, Date.now());
    return this.db.prepare('SELECT * FROM eod_sessions WHERE id = ?').get(result.lastInsertRowid) as EodSession;
  }

  getSession(date: string): EodSession | undefined {
    return this.db.prepare('SELECT * FROM eod_sessions WHERE date = ?').get(date) as EodSession | undefined;
  }

  recordAnswer(sessionId: number, memberJid: string, questionIdx: number, text: string): void {
    this.db.prepare(`
      INSERT INTO eod_answers (session_id, member_jid, question_idx, text, recorded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, member_jid, question_idx) DO UPDATE SET
        text        = excluded.text,
        recorded_at = excluded.recorded_at
    `).run(sessionId, memberJid, questionIdx, text, Date.now());
  }

  listAnswers(sessionId: number): EodAnswer[] {
    return this.db.prepare(
      'SELECT * FROM eod_answers WHERE session_id = ? ORDER BY member_jid, question_idx'
    ).all(sessionId) as EodAnswer[];
  }

  getMemberAnswers(sessionId: number, memberJid: string): EodAnswer[] {
    return this.db.prepare(
      'SELECT * FROM eod_answers WHERE session_id = ? AND member_jid = ? ORDER BY question_idx'
    ).all(sessionId, memberJid) as EodAnswer[];
  }

  markPosted(sessionId: number, summaryMd: string): void {
    this.db.prepare(
      'UPDATE eod_sessions SET posted_at = ?, summary_md = ? WHERE id = ?'
    ).run(Date.now(), summaryMd, sessionId);
  }
}
