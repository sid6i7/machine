import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import { KICKOFF_QUESTION } from '../conversations/EodStandup.js';

export class EodKickoffJob implements Job {
  name = 'EodKickoffJob';
  schedule = '0 19 * * 1-5';
  description = 'At 19:00 IST weekdays, open EOD standup conversation with each non-excluded team member.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }
    if (!ctx.inboundService) {
      ctx.logger.warn({ job: this.name }, 'no inboundService; this job must run from the bot');
      return;
    }

    const session = ctx.eod.ensureSession(today);
    const members = ctx.team.getMembers();
    let opened = 0;
    let skipped = 0;

    for (const member of members) {
      if (member.excludeFromEod) { skipped++; continue; }
      const existing = ctx.conversations.getState(member.jid, 'eod_standup');
      if (existing && existing.state === 'complete') { skipped++; continue; }

      // Stale tasklist follow-up conversations get superseded by EOD.
      ctx.conversations.clear(member.jid, 'tasklist_followup');

      try {
        await ctx.inboundService.sendMessage(member.jid, KICKOFF_QUESTION);
        ctx.conversations.setState(member.jid, 'eod_standup', 'q1_done', { sessionId: session.id });
        opened++;
        ctx.logger.info({ member: member.jid, name: member.name || '(no name)' }, 'EOD kickoff sent');
      } catch (err) {
        ctx.logger.error({ err, member: member.jid }, 'failed to send EOD kickoff DM');
      }
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, opened, skipped, sessionId: session.id }, 'EodKickoffJob done');
  }
}
