import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

let _db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || 'data/machine.db';
  const dir = path.dirname(dbPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info({ dbPath }, 'Opened SQLite database');
  _db = db;
  return db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export type Db = Database.Database;
