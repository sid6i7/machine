import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';

const NUDGE_BODY =
  'Quick reminder — please share your tasklist for today in the meetings group when you get a moment. Thanks!';

export class MorningTasklistReminderJob implements Job {
  name = 'MorningTasklistReminderJob';
  schedule = '0 12 * * 1-5';
  description = 'At 12 PM IST on weekdays, queue a one-shot DM nudge for each member who has not yet shared their tasklist.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }

    const members = ctx.team.getMembers();
    let queued = 0;
    let skipped = 0;

    for (const member of members) {
      if (member.excludeFromTasklist) { skipped++; continue; }
      if (ctx.tasklists.hasSubmittedToday(member.jid)) { skipped++; continue; }

      ctx.outbound.enqueue({
        toJid: member.jid,
        body: NUDGE_BODY,
        kind: 'tasklist_nudge',
        context: { memberJid: member.jid, memberName: member.name, date: today },
        dedupKey: `tasklist_nudge:${today}`,
      });
      queued++;
      ctx.logger.info({ member: member.jid, name: member.name || '(no name)' }, 'tasklist nudge queued');
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, queued, skipped, total: members.length }, 'MorningTasklistReminderJob done');
  }
}
