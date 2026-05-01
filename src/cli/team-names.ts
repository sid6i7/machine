import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from '../db/migrate.js';
import { getDatabase } from '../db/Database.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_JSON_PATH = path.resolve(__dirname, '../config/team.json');

interface TeamMember {
  jid: string;
  name: string;
  email?: string;
  role?: string;
  excludeFromTasklist?: boolean;
  excludeFromEod?: boolean;
}
interface TeamConfig { userJid: string; groups: Record<string, unknown>; members: TeamMember[]; }

interface NameRow { participant_jid: string; push_name: string; last_ts: number; message_count: number; }

async function main() {
  migrate();
  const db = getDatabase();
  const apply = process.argv.includes('--apply');

  const rows = db.prepare(`
    SELECT participant_jid, push_name, MAX(ts) AS last_ts, COUNT(*) AS message_count
    FROM messages
    WHERE push_name IS NOT NULL AND push_name != ''
    GROUP BY participant_jid
    ORDER BY last_ts DESC
  `).all() as NameRow[];

  if (rows.length === 0) {
    console.log('No pushNames captured yet. Run the bot for a while; need messages to flow first.');
    process.exit(0);
  }

  const map = new Map<string, string>();
  for (const r of rows) map.set(r.participant_jid, r.push_name);

  console.log('\nDiscovered names (most recent push_name per JID):');
  for (const r of rows) {
    console.log(`  ${r.participant_jid.padEnd(40)} → "${r.push_name}"  (${r.message_count} msgs)`);
  }

  if (!fs.existsSync(TEAM_JSON_PATH)) {
    console.warn('\nteam.json not found; cannot suggest updates.');
    process.exit(0);
  }
  const team: TeamConfig = JSON.parse(fs.readFileSync(TEAM_JSON_PATH, 'utf-8'));

  const updates: { jid: string; was: string; willBe: string }[] = [];
  for (const m of team.members) {
    const known = map.get(m.jid);
    if (known && (!m.name || m.name.trim() === '')) {
      updates.push({ jid: m.jid, was: m.name, willBe: known });
    }
  }

  if (updates.length === 0) {
    console.log('\nteam.json: no empty names match a known pushName. Nothing to update.');
    process.exit(0);
  }

  console.log('\nProposed team.json updates:');
  for (const u of updates) console.log(`  ${u.jid}  "${u.was}" → "${u.willBe}"`);

  if (!apply) {
    console.log('\n(dry-run) Re-run with --apply to write these to team.json.');
    process.exit(0);
  }

  const backup = TEAM_JSON_PATH + '.bak';
  fs.copyFileSync(TEAM_JSON_PATH, backup);
  console.log(`Backup: ${backup}`);
  for (const m of team.members) {
    const known = map.get(m.jid);
    if (known && (!m.name || m.name.trim() === '')) m.name = known;
  }
  fs.writeFileSync(TEAM_JSON_PATH, JSON.stringify(team, null, 2) + '\n');
  console.log(`✓ Applied ${updates.length} name updates to team.json`);
  process.exit(0);
}

main().catch((err) => { logger.error({ err }, 'team-names failed'); process.exit(1); });
