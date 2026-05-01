import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import { KICKOFF_REPLY } from '../conversations/TasklistFollowup.js';

export class MorningTasklistReminderJob implements Job {
  name = 'MorningTasklistReminderJob';
  schedule = '0 12 * * 1-5';
  description = 'At 12 PM IST on weekdays, DM each team member who has not yet shared their tasklist.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }
    if (!ctx.inboundService) {
      ctx.logger.warn({ job: this.name }, 'no inboundService; this job must run from the bot, not CLI');
      return;
    }

    const members = ctx.team.getMembers();
    let reminded = 0;
    let skipped = 0;

    for (const member of members) {
      if (member.excludeFromTasklist) { skipped++; continue; }
      if (ctx.tasklists.hasSubmittedToday(member.jid)) { skipped++; continue; }
      if (ctx.conversations.getState(member.jid, 'tasklist_followup')) { skipped++; continue; }

      try {
        await ctx.inboundService.sendMessage(member.jid, KICKOFF_REPLY);
        ctx.conversations.setState(member.jid, 'tasklist_followup', 'asked_started');
        reminded++;
        ctx.logger.info({ member: member.jid, name: member.name || '(no name)' }, 'reminder sent');
      } catch (err) {
        ctx.logger.error({ err, member: member.jid }, 'failed to send reminder DM');
      }
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, reminded, skipped, total: members.length }, 'MorningTasklistReminderJob done');
  }
}
