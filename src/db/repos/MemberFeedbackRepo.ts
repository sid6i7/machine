import { getDatabase, type Db } from '../Database.js';

export type FeedbackSource = 'whatsapp' | 'web';

export interface MemberFeedback {
  id: number;
  member_jid: string;
  feedback_date: string;        // YYYY-MM-DD IST
  text: string;
  backlog_item_id: number | null;
  source: FeedbackSource;
  created_at: number;
}

export interface InsertFeedbackInput {
  memberJid: string;
  feedbackDate: string;
  text: string;
  backlogItemId?: number | null;
  source: FeedbackSource;
}

export class MemberFeedbackRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  insert(input: InsertFeedbackInput): MemberFeedback {
    const result = this.db.prepare(`
      INSERT INTO member_feedback (member_jid, feedback_date, text, backlog_item_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.memberJid,
      input.feedbackDate,
      input.text,
      input.backlogItemId ?? null,
      input.source,
      Date.now(),
    );
    return this.db.prepare('SELECT * FROM member_feedback WHERE id = ?').get(result.lastInsertRowid) as MemberFeedback;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM member_feedback WHERE id = ?').run(id);
  }

  // All feedback for one member across an inclusive date range, oldest first.
  listForMemberInRange(memberJid: string, fromDate: string, toDate: string): MemberFeedback[] {
    return this.db.prepare(`
      SELECT * FROM member_feedback
      WHERE member_jid = ? AND feedback_date >= ? AND feedback_date <= ?
      ORDER BY feedback_date ASC, created_at ASC
    `).all(memberJid, fromDate, toDate) as MemberFeedback[];
  }

  // All feedback in a date range (across members), newest first — for the /feedback log page.
  listInRange(fromDate: string, toDate: string, limit = 200): MemberFeedback[] {
    return this.db.prepare(`
      SELECT * FROM member_feedback
      WHERE feedback_date >= ? AND feedback_date <= ?
      ORDER BY feedback_date DESC, created_at DESC
      LIMIT ?
    `).all(fromDate, toDate, limit) as MemberFeedback[];
  }

  listRecent(limit = 100): MemberFeedback[] {
    return this.db.prepare(`
      SELECT * FROM member_feedback
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as MemberFeedback[];
  }
}
