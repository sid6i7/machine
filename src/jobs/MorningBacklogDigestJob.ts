import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import { formatBacklog } from '../actions/BacklogAction.js';

export class MorningBacklogDigestJob implements Job {
  name = 'MorningBacklogDigestJob';
  schedule = '0 9 * * 1-5';
  description = '9 AM IST weekdays: DM the user the morning backlog digest.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();
    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }
    if (!ctx.inboundService) {
      ctx.logger.warn({ job: this.name }, 'no inboundService; must run from the bot');
      return;
    }
    if (!ctx.team.exists()) {
      ctx.logger.warn({ job: this.name }, 'team.json missing; cannot DM');
      return;
    }

    const items = ctx.backlog.listAllOpen();
    const message = `Morning. Here's today's backlog:\n\n${formatBacklog(items)}`;

    try {
      await ctx.inboundService.sendMessage(ctx.team.getUserJid(), message);
      ctx.dailyRuns.recordRun(today, this.name);
      ctx.logger.info({ today, items: items.length }, 'morning digest DM sent');
    } catch (err) {
      ctx.logger.error({ err }, 'failed to send morning backlog digest');
    }
  }
}
