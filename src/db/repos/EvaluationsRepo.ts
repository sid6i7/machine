import { getDatabase, type Db } from '../Database.js';

export interface MemberEvaluation {
  week_start_date: string;
  member_jid: string;
  score_properly: number | null;
  score_on_time: number | null;
  score_updates: number | null;
  score_feedback: number | null;
  feedback_text: string | null;
  evidence_json: string | null;
  saved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertEvalInput {
  weekStartDate: string;
  memberJid: string;
  scoreProperly?: number | null;
  scoreOnTime?: number | null;
  scoreUpdates?: number | null;
  scoreFeedback?: number | null;
  feedbackText?: string | null;
  evidence?: unknown;
  savedAt?: number | null;
}

export class EvaluationsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  // Upsert that respects existing finalized rows: callers wanting non-destructive
  // prefill should check `get()` first and skip when saved_at is non-null.
  upsert(input: UpsertEvalInput): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO member_evaluations
        (week_start_date, member_jid, score_properly, score_on_time, score_updates, score_feedback,
         feedback_text, evidence_json, saved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(week_start_date, member_jid) DO UPDATE SET
        score_properly = excluded.score_properly,
        score_on_time  = excluded.score_on_time,
        score_updates  = excluded.score_updates,
        score_feedback = excluded.score_feedback,
        feedback_text  = excluded.feedback_text,
        evidence_json  = excluded.evidence_json,
        saved_at       = excluded.saved_at,
        updated_at     = excluded.updated_at
    `).run(
      input.weekStartDate,
      input.memberJid,
      input.scoreProperly ?? null,
      input.scoreOnTime ?? null,
      input.scoreUpdates ?? null,
      input.scoreFeedback ?? null,
      input.feedbackText ?? null,
      input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
      input.savedAt ?? null,
      now, now
    );
  }

  get(weekStartDate: string, memberJid: string): MemberEvaluation | undefined {
    return this.db.prepare(
      'SELECT * FROM member_evaluations WHERE week_start_date = ? AND member_jid = ?'
    ).get(weekStartDate, memberJid) as MemberEvaluation | undefined;
  }

  listForWeek(weekStartDate: string): MemberEvaluation[] {
    return this.db.prepare(
      'SELECT * FROM member_evaluations WHERE week_start_date = ? ORDER BY member_jid'
    ).all(weekStartDate) as MemberEvaluation[];
  }

  // Latest finalized eval for a member, used to source "last week's feedback"
  // when prefilling the new week's score_feedback.
  getLatestSaved(memberJid: string, beforeWeek: string): MemberEvaluation | undefined {
    return this.db.prepare(
      `SELECT * FROM member_evaluations
       WHERE member_jid = ? AND week_start_date < ? AND saved_at IS NOT NULL
       ORDER BY week_start_date DESC LIMIT 1`
    ).get(memberJid, beforeWeek) as MemberEvaluation | undefined;
  }

  finalize(weekStartDate: string, memberJid: string, scores: {
    scoreProperly: number; scoreOnTime: number; scoreUpdates: number; scoreFeedback: number;
    feedbackText: string;
  }): void {
    const now = Date.now();
    // Insert if missing, else update; either way set saved_at.
    const existing = this.get(weekStartDate, memberJid);
    if (existing) {
      this.db.prepare(`
        UPDATE member_evaluations SET
          score_properly = ?, score_on_time = ?, score_updates = ?, score_feedback = ?,
          feedback_text = ?, saved_at = ?, updated_at = ?
        WHERE week_start_date = ? AND member_jid = ?
      `).run(
        scores.scoreProperly, scores.scoreOnTime, scores.scoreUpdates, scores.scoreFeedback,
        scores.feedbackText, now, now, weekStartDate, memberJid
      );
    } else {
      this.upsert({
        weekStartDate, memberJid,
        scoreProperly: scores.scoreProperly,
        scoreOnTime: scores.scoreOnTime,
        scoreUpdates: scores.scoreUpdates,
        scoreFeedback: scores.scoreFeedback,
        feedbackText: scores.feedbackText,
        savedAt: now,
      });
    }
  }
}
