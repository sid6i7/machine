import 'dotenv/config';
import { migrate } from './db/migrate.js';
import { getDatabase } from './db/Database.js';
import { GeminiClient } from './llm/GeminiClient.js';
import { Scheduler } from './scheduler/Scheduler.js';
import { HookDispatcher } from './hooks/HookDispatcher.js';
import { ActionDispatcher } from './actions/ActionDispatcher.js';
import { TeamRepo } from './db/repos/TeamRepo.js';
import { MessagesRepo } from './db/repos/MessagesRepo.js';
import { DailyRunsRepo } from './db/repos/DailyRunsRepo.js';
import { TasklistsRepo } from './db/repos/TasklistsRepo.js';
import { EodRepo } from './db/repos/EodRepo.js';
import { BacklogRepo } from './db/repos/BacklogRepo.js';
import { OutboundQueueRepo } from './db/repos/OutboundQueueRepo.js';
import { SheetEditQueueRepo } from './db/repos/SheetEditQueueRepo.js';
import { MrReviewsRepo } from './db/repos/MrReviewsRepo.js';
import { SummariesRepo } from './db/repos/SummariesRepo.js';
import { EvaluationsRepo } from './db/repos/EvaluationsRepo.js';
import { MergedMrsRepo } from './db/repos/MergedMrsRepo.js';
import { ItemChatRepo } from './db/repos/ItemChatRepo.js';
import { BacklogActionableRepo } from './db/repos/BacklogActionableRepo.js';
import { BacklogEventRepo } from './db/repos/BacklogEventRepo.js';
import { startWebServer } from './web/server.js';
import { logger } from './utils/logger.js';
import type { InboundMessage } from './services/InboundService.js';
import type { JobContext } from './jobs/Job.js';

async function bootstrap() {
  // 1. Migrations
  migrate();

  // 2. Inbound service
  const serviceName = process.env.INBOUND_SERVICE || 'WhatsAppService';
  let InboundServiceClass: any;
  try {
    const module = await import(`./services/${serviceName}.js`);
    InboundServiceClass = module[serviceName];
    if (!InboundServiceClass) throw new Error(`Class ${serviceName} not found in module.`);
  } catch (err: any) {
    logger.error({ err, serviceName }, 'Failed to load inbound service');
    process.exit(1);
  }
  const inboundService = new InboundServiceClass();

  // 3. Shared context for hooks + jobs
  const jobCtx: JobContext = {
    db: getDatabase(),
    logger,
    gemini: new GeminiClient(),
    inboundService,
    team: new TeamRepo(),
    messages: new MessagesRepo(),
    dailyRuns: new DailyRunsRepo(),
    tasklists: new TasklistsRepo(),
    eod: new EodRepo(),
    backlog: new BacklogRepo(),
    outbound: new OutboundQueueRepo(),
    sheetEdits: new SheetEditQueueRepo(),
    mrReviews: new MrReviewsRepo(),
    summaries: new SummariesRepo(),
    evaluations: new EvaluationsRepo(),
    mergedMrs: new MergedMrsRepo(),
    itemChat: new ItemChatRepo(),
    actionables: new BacklogActionableRepo(),
    backlogEvents: new BacklogEventRepo(),
  };

  // 4. Dispatchers + scheduler
  const hookDispatcher = new HookDispatcher(jobCtx);
  await hookDispatcher.loadEnabled();

  const actionDispatcher = new ActionDispatcher();
  await actionDispatcher.init();

  const scheduler = new Scheduler(jobCtx);
  await scheduler.loadEnabled();
  scheduler.start();

  // 5. Wire inbound messages
  inboundService.on('message', (msg: InboundMessage) => {
    // Hooks: fire-and-forget, parallel, never block action dispatch
    hookDispatcher.run(msg).catch(err =>
      logger.error({ err }, 'HookDispatcher.run rejected unexpectedly')
    );

    // Actions: existing behavior — skip the bot's own outgoing messages
    if (msg.isFromMe) return;

    actionDispatcher.dispatch(msg)
      .then(async (response) => {
        if (response) {
          await inboundService.sendMessage(msg.groupID || msg.sender, response);
        }
      })
      .catch((err: Error) => logger.error({ err }, 'Action dispatch failed'));
  });

  // 6. Start the WA socket
  inboundService.start().catch((err: Error) => {
    logger.error({ err, serviceName }, 'Failed to start inbound service');
  });

  // 7. Start the local web dashboard
  startWebServer(jobCtx, scheduler).catch((err: Error) => {
    logger.error({ err }, 'Failed to start web server');
  });
}

bootstrap().catch((err: Error) => {
  logger.error({ err }, 'Bootstrap failed');
  process.exit(1);
});
