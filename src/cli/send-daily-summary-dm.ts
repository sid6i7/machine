import 'dotenv/config';
import { migrate } from '../db/migrate.js';
import { TeamRepo } from '../db/repos/TeamRepo.js';
import { SummariesRepo } from '../db/repos/SummariesRepo.js';
import { OutboundQueueRepo } from '../db/repos/OutboundQueueRepo.js';
import { istDateString } from '../utils/time.js';
import { enqueueDailySummaryDm } from '../jobs/dailySummaryDm.js';

async function main() {
  migrate();
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : istDateString();

  const { queued, reason } = enqueueDailySummaryDm(
    { team: new TeamRepo(), summaries: new SummariesRepo(), outbound: new OutboundQueueRepo() },
    date,
    'send-daily-summary-dm cli',
  );

  if (!queued) {
    console.error(`Skipped: ${reason}. Run DailyMemberSummaryJob first.`);
    process.exit(1);
  }
  console.log(`Queued outbound id=${queued.id} status=${queued.status} for ${date}. Approve at /approvals.`);
}

main().catch(err => { console.error(err); process.exit(1); });
