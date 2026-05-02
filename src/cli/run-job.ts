import 'dotenv/config';
import { migrate } from '../db/migrate.js';
import { getDatabase } from '../db/Database.js';
import { GeminiClient } from '../llm/GeminiClient.js';
import { Scheduler } from '../scheduler/Scheduler.js';
import { TeamRepo } from '../db/repos/TeamRepo.js';
import { MessagesRepo } from '../db/repos/MessagesRepo.js';
import { DailyRunsRepo } from '../db/repos/DailyRunsRepo.js';
import { TasklistsRepo } from '../db/repos/TasklistsRepo.js';
import { EodRepo } from '../db/repos/EodRepo.js';
import { BacklogRepo } from '../db/repos/BacklogRepo.js';
import { OutboundQueueRepo } from '../db/repos/OutboundQueueRepo.js';
import { SummariesRepo } from '../db/repos/SummariesRepo.js';
import { EvaluationsRepo } from '../db/repos/EvaluationsRepo.js';
import { MergedMrsRepo } from '../db/repos/MergedMrsRepo.js';
import { logger } from '../utils/logger.js';
import type { JobContext } from '../jobs/Job.js';

async function main() {
  const jobName = process.argv[2];
  if (!jobName) {
    console.error('Usage: npm run job <JobClassName>');
    console.error('Example: npm run job PruneMessagesJob');
    process.exit(2);
  }

  // Run migrations on demand so the CLI is standalone.
  migrate();

  const ctx: JobContext = {
    db: getDatabase(),
    logger,
    gemini: new GeminiClient(),
    inboundService: undefined,   // CLI has no live WA socket
    team: new TeamRepo(),
    messages: new MessagesRepo(),
    dailyRuns: new DailyRunsRepo(),
    tasklists: new TasklistsRepo(),
    eod: new EodRepo(),
    backlog: new BacklogRepo(),
    outbound: new OutboundQueueRepo(),
    summaries: new SummariesRepo(),
    evaluations: new EvaluationsRepo(),
    mergedMrs: new MergedMrsRepo(),
  };

  // Make sure the requested job is in ENABLED_JOBS for this run, even if the
  // user hasn't toggled it on yet.
  const existing = (process.env.ENABLED_JOBS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!existing.includes(jobName)) {
    process.env.ENABLED_JOBS = [...existing, jobName].join(',');
  }

  const scheduler = new Scheduler(ctx);
  await scheduler.loadEnabled();

  try {
    await scheduler.runOnce(jobName);
    process.exit(0);
  } catch (err) {
    logger.error({ err, jobName }, 'Job run failed');
    process.exit(1);
  }
}

main();
