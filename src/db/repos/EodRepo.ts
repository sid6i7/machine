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

export interface EodReply {
  session_id: number;
  member_jid: string;
  raw_reply: string;
  parsed_done: string | null;
  parsed_left: string | null;
  parsed_blockers: string | null;
  recorded_at: number;
  parsed_at: number | null;
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

  // --- New (post-conversation refactor) reply API ---
  // Last reply wins — members can amend their EOD DM up until aggregate posts.

  recordReply(sessionId: number, memberJid: string, rawReply: string): void {
    this.db.prepare(`
      INSERT INTO eod_replies (session_id, member_jid, raw_reply, recorded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, member_jid) DO UPDATE SET
        raw_reply       = excluded.raw_reply,
        recorded_at     = excluded.recorded_at,
        parsed_done     = NULL,
        parsed_left     = NULL,
        parsed_blockers = NULL,
        parsed_at       = NULL
    `).run(sessionId, memberJid, rawReply, Date.now());
  }

  setParsed(sessionId: number, memberJid: string, done: string, left: string, blockers: string): void {
    this.db.prepare(`
      UPDATE eod_replies
      SET parsed_done = ?, parsed_left = ?, parsed_blockers = ?, parsed_at = ?
      WHERE session_id = ? AND member_jid = ?
    `).run(done, left, blockers, Date.now(), sessionId, memberJid);
  }

  getReply(sessionId: number, memberJid: string): EodReply | undefined {
    return this.db.prepare(
      'SELECT * FROM eod_replies WHERE session_id = ? AND member_jid = ?'
    ).get(sessionId, memberJid) as EodReply | undefined;
  }

  listReplies(sessionId: number): EodReply[] {
    return this.db.prepare(
      'SELECT * FROM eod_replies WHERE session_id = ? ORDER BY member_jid'
    ).all(sessionId) as EodReply[];
  }

  // Latest session that has at least one reply or has been posted. Used by the
  // "Yesterday's EOD" panel on /.
  getMostRecentSession(): EodSession | undefined {
    return this.db.prepare(`
      SELECT s.* FROM eod_sessions s
      WHERE s.posted_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM eod_replies r WHERE r.session_id = s.id)
      ORDER BY s.date DESC LIMIT 1
    `).get() as EodSession | undefined;
  }
}
