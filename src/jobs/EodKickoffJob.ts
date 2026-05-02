import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';

const EOD_PROMPT = `EOD check-in 🌙

Please reply (in this DM) with:
1. What did you complete today?
2. What's left / pending?
3. Any blockers?

You can reply in one go — just one message is enough.`;

export class EodKickoffJob implements Job {
  name = 'EodKickoffJob';
  schedule = '0 19 * * 1-5';
  description = 'At 19:00 IST weekdays, queue a single combined-question EOD DM for each non-excluded member.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }

    const session = ctx.eod.ensureSession(today);
    const members = ctx.team.getMembers();
    let queued = 0;
    let skipped = 0;

    for (const member of members) {
      if (member.excludeFromEod) { skipped++; continue; }
      ctx.outbound.enqueue({
        toJid: member.jid,
        body: EOD_PROMPT,
        kind: 'eod_check_in',
        context: { memberJid: member.jid, memberName: member.name, sessionId: session.id, date: today },
        dedupKey: `eod_check_in:${today}`,
      });
      queued++;
      ctx.logger.info({ member: member.jid, name: member.name || '(no name)' }, 'EOD kickoff queued');
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, queued, skipped, sessionId: session.id }, 'EodKickoffJob done');
  }
}
