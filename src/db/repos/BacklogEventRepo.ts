import { getDatabase, type Db } from '../Database.js';

export interface BacklogEvent {
  id: number;
  backlog_id: number;
  kind: string;
  text: string;
  metadata_json: string | null;
  created_at: number;
}

export class BacklogEventRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  insert(backlogId: number, kind: string, text: string, metadata?: unknown): void {
    this.db.prepare(
      'INSERT INTO backlog_events (backlog_id, kind, text, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      backlogId,
      kind,
      text,
      metadata === undefined ? null : JSON.stringify(metadata),
      Date.now(),
    );
  }

  listForBacklog(backlogId: number): BacklogEvent[] {
    return this.db.prepare(
      'SELECT * FROM backlog_events WHERE backlog_id = ? ORDER BY created_at ASC'
    ).all(backlogId) as BacklogEvent[];
  }
}
