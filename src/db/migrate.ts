import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDatabase } from './Database.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function migrate(): void {
  const db = getDatabase();

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn({ dir: MIGRATIONS_DIR }, 'Migrations directory missing; nothing to apply');
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set<string>(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map(r => r.id)
  );

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlPath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    tx();
    logger.info({ migration: file }, 'Applied migration');
    appliedCount++;
  }

  if (appliedCount === 0) {
    logger.info('No new migrations to apply');
  }
}

const invokedAsScript =
  process.argv[1] && (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (invokedAsScript) {
  try {
    migrate();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  }
}
