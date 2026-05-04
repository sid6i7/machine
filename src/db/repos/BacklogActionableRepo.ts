import { getDatabase, type Db } from '../Database.js';

export type ActionableTarget = 'self' | 'owner' | 'mr_author';
export type Phase = 'intake' | 'refined' | 'in_sprint' | 'in_dev' | 'in_review' | 'released';

export interface BacklogActionable {
  id: number;
  backlog_id: number;
  phase: Phase;
  template_key: string | null;
  text: string;
  target: ActionableTarget;
  is_done: number;
  done_at: number | null;
  pending_outbound_id: number | null;
  created_at: number;
}

export interface InsertActionableInput {
  backlogId: number;
  phase: Phase;
  text: string;
  templateKey?: string | null;
  target?: ActionableTarget;
}

export class BacklogActionableRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  // Returns the inserted row, or the existing row when template_key collides
  // (UNIQUE on (backlog_id, template_key)). Custom rows (template_key=NULL)
  // never collide and always insert fresh.
  insert(input: InsertActionableInput): BacklogActionable {
    const tk = input.templateKey ?? null;
    if (tk) {
      const existing = this.db.prepare(
        'SELECT * FROM backlog_actionables WHERE backlog_id = ? AND template_key = ?'
      ).get(input.backlogId, tk) as BacklogActionable | undefined;
      if (existing) return existing;
    }
    const result = this.db.prepare(`
      INSERT INTO backlog_actionables
        (backlog_id, phase, template_key, text, target, is_done, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.backlogId,
      input.phase,
      tk,
      input.text,
      input.target ?? 'self',
      Date.now(),
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): BacklogActionable | undefined {
    return this.db.prepare('SELECT * FROM backlog_actionables WHERE id = ?')
      .get(id) as BacklogActionable | undefined;
  }

  listForBacklog(backlogId: number): BacklogActionable[] {
    return this.db.prepare(
      'SELECT * FROM backlog_actionables WHERE backlog_id = ? ORDER BY phase, created_at ASC'
    ).all(backlogId) as BacklogActionable[];
  }

  countSeededForBacklogPhase(backlogId: number, phase: Phase): number {
    const r = this.db.prepare(
      'SELECT COUNT(*) AS c FROM backlog_actionables WHERE backlog_id = ? AND phase = ? AND template_key IS NOT NULL'
    ).get(backlogId, phase) as { c: number };
    return r.c;
  }

  setDone(id: number, done: boolean): void {
    this.db.prepare(
      'UPDATE backlog_actionables SET is_done = ?, done_at = ? WHERE id = ?'
    ).run(done ? 1 : 0, done ? Date.now() : null, id);
  }

  attachOutbound(id: number, outboundId: number): void {
    this.db.prepare(
      'UPDATE backlog_actionables SET pending_outbound_id = ? WHERE id = ?'
    ).run(outboundId, id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM backlog_actionables WHERE id = ?').run(id);
  }
}
