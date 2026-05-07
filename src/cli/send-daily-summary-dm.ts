import 'dotenv/config';
import { migrate } from '../db/migrate.js';
import { TeamRepo } from '../db/repos/TeamRepo.js';
import { SummariesRepo } from '../db/repos/SummariesRepo.js';
import { OutboundQueueRepo } from '../db/repos/OutboundQueueRepo.js';
import { istDateString } from '../utils/time.js';

async function main() {
  migrate();
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : istDateString();

  const team = new TeamRepo();
  const summaries = new SummariesRepo();
  const outbound = new OutboundQueueRepo();

  const rows = summaries.listMembersForPeriod('day', date);
  if (rows.length === 0) {
    console.error(`No member_summaries rows for ${date}. Run DailyMemberSummaryJob first.`);
    process.exit(1);
  }

  const nameByJid = new Map(team.getMembers().map(m => [m.jid, m.name || m.jid.split('@')[0]]));

  const isEmpty = (md: string) => /no activity captured/i.test(md.trim());
  const active = rows.filter(r => !isEmpty(r.summary_md));
  const inactive = rows.filter(r => isEmpty(r.summary_md));

  let body = `*Daily summary — ${date}*\n`;
  for (const r of active) {
    const name = nameByJid.get(r.member_jid) || r.member_jid.split('@')[0];
    body += `\n_${name}_\n${r.summary_md}\n`;
  }
  if (inactive.length) {
    const names = inactive.map(r => nameByJid.get(r.member_jid) || r.member_jid.split('@')[0]);
    body += `\n_No activity captured:_ ${names.join(', ')}\n`;
  }

  const userJid = team.getUserJid();
  const queued = outbound.enqueue({
    toJid: userJid,
    body,
    kind: 'eod_summary_dm',
    context: { date, source: 'send-daily-summary-dm cli' },
    dedupKey: `daily_summary_dm:${date}`,
  });

  console.log(`Queued outbound id=${queued.id} status=${queued.status} to=${userJid} (${rows.length} members). Approve at /approvals.`);
}

main().catch(err => { console.error(err); process.exit(1); });
