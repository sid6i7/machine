import { getDatabase, type Db } from '../Database.js';
import crypto from 'crypto';

export type MrReviewStatus =
  | 'queued' | 'running' | 'finished'
  | 'submitting' | 'submitted'
  | 'failed' | 'cancelled' | 'discarded';

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'apply_failed';
export type SuggestionSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface MrReview {
  id: number;
  mr_backlog_id: number | null;
  mr_external_id: string;
  mr_url: string;
  mr_title: string;
  source_branch: string;
  target_branch: string;
  project_path: string;
  worktree_path: string | null;
  model: string;
  level: string;
  status: MrReviewStatus;
  pid: number | null;
  session_id: string | null;
  log_path: string | null;
  transcript: string;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  submitted_at: number | null;
  push_commit_sha: string | null;
  error: string | null;
}

export interface MrReviewSuggestion {
  id: number;
  review_id: number;
  file: string;
  line_start: number;
  line_end: number;
  severity: SuggestionSeverity;
  rationale: string;
  original: string;
  replacement: string;
  status: SuggestionStatus;
  decided_at: number | null;
  apply_error: string | null;
  created_at: number;
  fingerprint: string;
}

export interface CreateReviewOpts {
  mrBacklogId: number | null;
  mrExternalId: string;
  mrUrl: string;
  mrTitle: string;
  sourceBranch: string;
  targetBranch: string;
  projectPath: string;
  model: string;
  level: string;
}

export class MrReviewsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  create(opts: CreateReviewOpts): MrReview {
    const r = this.db.prepare(`
      INSERT INTO mr_reviews
        (mr_backlog_id, mr_external_id, mr_url, mr_title,
         source_branch, target_branch, project_path,
         model, level, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(
      opts.mrBacklogId, opts.mrExternalId, opts.mrUrl, opts.mrTitle,
      opts.sourceBranch, opts.targetBranch, opts.projectPath,
      opts.model, opts.level, Date.now(),
    );
    return this.getById(Number(r.lastInsertRowid))!;
  }

  getById(id: number): MrReview | undefined {
    return this.db.prepare('SELECT * FROM mr_reviews WHERE id = ?').get(id) as MrReview | undefined;
  }

  list(opts: { status?: MrReviewStatus; limit?: number } = {}): MrReview[] {
    if (opts.status) {
      return this.db.prepare(`SELECT * FROM mr_reviews WHERE status = ? ORDER BY id DESC LIMIT ?`)
        .all(opts.status, opts.limit ?? 50) as MrReview[];
    }
    return this.db.prepare(`SELECT * FROM mr_reviews ORDER BY id DESC LIMIT ?`)
      .all(opts.limit ?? 50) as MrReview[];
  }

  listByMrBacklogId(mrBacklogId: number): MrReview[] {
    return this.db.prepare(
      `SELECT * FROM mr_reviews WHERE mr_backlog_id = ? ORDER BY id DESC`,
    ).all(mrBacklogId) as MrReview[];
  }

  countByStatus(status: MrReviewStatus): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM mr_reviews WHERE status = ?`).get(status) as { c: number };
    return r.c;
  }

  pendingApprovalCount(): number {
    return 0;
  }

  setRunning(id: number, opts: { pid: number; sessionId?: string | null; worktreePath: string; logPath: string }): void {
    this.db.prepare(`
      UPDATE mr_reviews
      SET status = 'running', pid = ?, session_id = ?, worktree_path = ?, log_path = ?, started_at = ?
      WHERE id = ?
    `).run(opts.pid, opts.sessionId ?? null, opts.worktreePath, opts.logPath, Date.now(), id);
  }

  setSessionId(id: number, sessionId: string): void {
    this.db.prepare(`UPDATE mr_reviews SET session_id = ? WHERE id = ?`).run(sessionId, id);
  }

  appendTranscript(id: number, chunk: string): void {
    this.db.prepare(`UPDATE mr_reviews SET transcript = transcript || ? WHERE id = ?`).run(chunk, id);
  }

  setFinished(id: number, opts: { costUsd?: number | null; durationMs?: number | null; error?: string | null } = {}): void {
    this.db.prepare(`
      UPDATE mr_reviews
      SET status = ?, finished_at = ?, cost_usd = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `).run(
      opts.error ? 'failed' : 'finished',
      Date.now(),
      opts.costUsd ?? null,
      opts.durationMs ?? null,
      opts.error ?? null,
      id,
    );
  }

  setStatus(id: number, status: MrReviewStatus, extra: Partial<Pick<MrReview, 'error' | 'push_commit_sha'>> = {}): void {
    this.db.prepare(`
      UPDATE mr_reviews
      SET status = ?,
          submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END,
          push_commit_sha = COALESCE(?, push_commit_sha),
          error = COALESCE(?, error)
      WHERE id = ?
    `).run(status, status, Date.now(), extra.push_commit_sha ?? null, extra.error ?? null, id);
  }

  // ----- suggestions -----

  insertSuggestion(reviewId: number, s: Omit<MrReviewSuggestion, 'id' | 'review_id' | 'created_at' | 'fingerprint' | 'status' | 'decided_at' | 'apply_error'>): MrReviewSuggestion | null {
    const fp = crypto.createHash('sha1')
      .update(`${s.file}|${s.line_start}|${s.line_end}|${s.original}|${s.replacement}`)
      .digest('hex');
    try {
      const r = this.db.prepare(`
        INSERT INTO mr_review_suggestions
          (review_id, file, line_start, line_end, severity, rationale, original, replacement, status, created_at, fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(reviewId, s.file, s.line_start, s.line_end, s.severity, s.rationale, s.original, s.replacement, Date.now(), fp);
      return this.getSuggestionById(Number(r.lastInsertRowid));
    } catch (err) {
      // UNIQUE(review_id, fingerprint) → silently dedup
      if (err instanceof Error && /UNIQUE/.test(err.message)) return null;
      throw err;
    }
  }

  getSuggestionById(id: number): MrReviewSuggestion | null {
    return (this.db.prepare(`SELECT * FROM mr_review_suggestions WHERE id = ?`).get(id) as MrReviewSuggestion) ?? null;
  }

  listSuggestions(reviewId: number): MrReviewSuggestion[] {
    return this.db.prepare(
      `SELECT * FROM mr_review_suggestions WHERE review_id = ? ORDER BY id ASC`
    ).all(reviewId) as MrReviewSuggestion[];
  }

  setSuggestionStatus(id: number, status: SuggestionStatus, error?: string): void {
    this.db.prepare(`
      UPDATE mr_review_suggestions
      SET status = ?, decided_at = ?, apply_error = ?
      WHERE id = ?
    `).run(status, Date.now(), error ?? null, id);
  }

  countAccepted(reviewId: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) c FROM mr_review_suggestions WHERE review_id = ? AND status IN ('accepted','applied')`).get(reviewId) as { c: number };
    return r.c;
  }
}
