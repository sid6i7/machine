import type { Job, JobContext } from './Job.js';

export class PruneMessagesJob implements Job {
  name = 'PruneMessagesJob';
  schedule = '0 3 * * *';
  description = 'Delete messages older than MESSAGE_RETENTION_DAYS at 03:00 IST daily.';

  async run(ctx: JobContext): Promise<void> {
    const days = Number(process.env.MESSAGE_RETENTION_DAYS || '7');
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const removed = ctx.messages.pruneOlderThan(cutoff);
    ctx.logger.info({ removed, days }, 'PruneMessagesJob done');
  }
}
