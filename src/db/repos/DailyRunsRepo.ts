import { getDatabase, type Db } from '../Database.js';

export class DailyRunsRepo {
  private db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDatabase();
  }

  hasRun(date: string, jobName: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM daily_runs WHERE date = ? AND job_name = ?'
    ).get(date, jobName);
    return row !== undefined;
  }

  recordRun(date: string, jobName: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO daily_runs (date, job_name, ran_at) VALUES (?, ?, ?)'
    ).run(date, jobName, Date.now());
  }
}
