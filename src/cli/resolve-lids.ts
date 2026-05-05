// One-shot: walk every configured group, pull participant metadata, and fill in
// missing `lid` fields on members in src/config/team.json. Useful when you add
// a member by phone (e.g. Emon: @s.whatsapp.net) and want their @lid form so
// future @-mention matching and group-participant equality both work.
//
//   npm run resolve-lids       # reports what would change
//   npm run resolve-lids -- --write   # actually rewrites team.json
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WhatsAppService } from '../services/WhatsAppService.js';
import { TeamRepo } from '../db/repos/TeamRepo.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_JSON_PATH = path.resolve(__dirname, '../config/team.json');

const WRITE = process.argv.includes('--write');

function bareNumber(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

async function main() {
  const wa = new WhatsAppService();
  await wa.start();

  // Wait until the socket is up. start() returns before connection.update fires.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wa.getMyJid()) resolve();
      else setTimeout(check, 500);
    };
    check();
  });

  const team = new TeamRepo();
  const cfg = JSON.parse(fs.readFileSync(TEAM_JSON_PATH, 'utf-8'));

  // Build a phone -> lid map by union-ing participants of every configured group.
  const phoneToLid = new Map<string, string>();
  const lidToPhone = new Map<string, string>();
  for (const groupKey of Object.keys(cfg.groups)) {
    const groupJid: string = cfg.groups[groupKey].jid;
    const participants = await wa.getGroupParticipants(groupJid);
    if (!participants) {
      logger.warn({ groupKey, groupJid }, 'could not fetch participants');
      continue;
    }
    for (const p of participants) {
      const lid = p.lid || (p.id.endsWith('@lid') ? p.id : undefined);
      const phone = p.phoneNumber || (p.id.endsWith('@s.whatsapp.net') ? p.id : undefined);
      if (lid && phone) {
        phoneToLid.set(bareNumber(phone), lid);
        lidToPhone.set(bareNumber(lid), phone);
      }
    }
    logger.info({ groupKey, count: participants.length }, 'fetched group participants');
  }

  // Now walk members and fill in `lid` (or `jid` when the member was added by lid only).
  const changes: { name: string; field: 'lid' | 'jid'; value: string }[] = [];
  for (const m of cfg.members) {
    const jid: string = m.jid;
    if (jid.endsWith('@s.whatsapp.net') && !m.lid) {
      const lid = phoneToLid.get(bareNumber(jid));
      if (lid) {
        m.lid = lid;
        changes.push({ name: m.name || jid, field: 'lid', value: lid });
      }
    } else if (jid.endsWith('@lid') && !m.lid) {
      // Member is identified by lid only — fill in the matching phone number
      // form into `lid` field for symmetry? No, keep `jid` as canonical. Skip.
    }
  }

  // Also set top-level userLid from userJid if missing.
  if (cfg.userJid && !cfg.userLid) {
    const lid = phoneToLid.get(bareNumber(cfg.userJid));
    if (lid) {
      cfg.userLid = lid;
      changes.push({ name: '<userLid>', field: 'lid', value: lid });
    }
  }

  if (changes.length === 0) {
    console.log('No changes — every member already has a `lid` (or no match found).');
  } else {
    console.log(`\nProposed changes (${changes.length}):`);
    for (const c of changes) console.log(`  ${c.name}: ${c.field} = ${c.value}`);
    if (WRITE) {
      fs.writeFileSync(TEAM_JSON_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      team.invalidate();
      console.log(`\nWrote ${TEAM_JSON_PATH}`);
    } else {
      console.log('\nDry-run only. Re-run with --write to apply.');
    }
  }

  await wa.stop();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, 'resolve-lids failed');
  process.exit(1);
});
