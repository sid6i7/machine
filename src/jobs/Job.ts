import type { Logger } from 'pino';
import type { Db } from '../db/Database.js';
import type { GeminiClient } from '../llm/GeminiClient.js';
import type { AbstractInboundService } from '../services/InboundService.js';
import type { TeamRepo } from '../db/repos/TeamRepo.js';
import type { MessagesRepo } from '../db/repos/MessagesRepo.js';
import type { DailyRunsRepo } from '../db/repos/DailyRunsRepo.js';
import type { TasklistsRepo } from '../db/repos/TasklistsRepo.js';
import type { ConversationsRepo } from '../db/repos/ConversationsRepo.js';

export interface JobContext {
  db: Db;
  logger: Logger;
  gemini: GeminiClient;
  // Undefined when running from the CLI (no live WA socket). Jobs that need
  // to send WhatsApp messages must guard against this.
  inboundService?: AbstractInboundService;
  team: TeamRepo;
  messages: MessagesRepo;
  dailyRuns: DailyRunsRepo;
  tasklists: TasklistsRepo;
  conversations: ConversationsRepo;
}

export interface Job {
  name: string;
  schedule: string;          // cron expression interpreted in SCHEDULER_TZ
  description?: string;
  run(ctx: JobContext): Promise<void>;
  // Optional catch-up support: returns true if today's scheduled run was missed
  // and should fire on next bootstrap.
  shouldHaveRunToday?(ctx: JobContext): boolean;
}
