import { getDatabase, type Db } from '../Database.js';

export interface MergedMr {
  external_id: string;
  title: string;
  author: string | null;
  source_branch: string | null;
  target_branch: string;
  merged_at: number;
  url: string | null;
  metadata_json: string | null;
}

export interface UpsertMergedInput {
  externalId: string;
  title: string;
  author?: string;
  sourceBranch?: string;
  targetBranch: string;
  mergedAt: number;
  url?: string;
  metadata?: unknown;
}

export class MergedMrsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  upsert(input: UpsertMergedInput): void {
    this.db.prepare(`
      INSERT INTO gitlab_merged_log
        (external_id, title, author, source_branch, target_branch, merged_at, url, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        title         = excluded.title,
        author        = excluded.author,
        source_branch = excluded.source_branch,
        target_branch = excluded.target_branch,
        merged_at     = excluded.merged_at,
        url           = excluded.url,
        metadata_json = excluded.metadata_json
    `).run(
      input.externalId,
      input.title,
      input.author ?? null,
      input.sourceBranch ?? null,
      input.targetBranch,
      input.mergedAt,
      input.url ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    );
  }

  has(externalId: string): boolean {
    const r = this.db.prepare('SELECT 1 FROM gitlab_merged_log WHERE external_id = ?').get(externalId);
    return !!r;
  }

  // MRs merged within [startMs, endMs). Used by WeeklyTeamSummaryJob.
  listInWindow(startMs: number, endMs: number, targetBranches?: string[]): MergedMr[] {
    if (targetBranches && targetBranches.length) {
      const placeholders = targetBranches.map(() => '?').join(',');
      return this.db.prepare(
        `SELECT * FROM gitlab_merged_log
         WHERE merged_at >= ? AND merged_at < ? AND target_branch IN (${placeholders})
         ORDER BY merged_at DESC`
      ).all(startMs, endMs, ...targetBranches) as MergedMr[];
    }
    return this.db.prepare(
      `SELECT * FROM gitlab_merged_log
       WHERE merged_at >= ? AND merged_at < ?
       ORDER BY merged_at DESC`
    ).all(startMs, endMs) as MergedMr[];
  }
}
