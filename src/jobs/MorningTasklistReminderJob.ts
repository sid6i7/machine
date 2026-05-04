import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';

const DEFAULT_BODY_TAIL = 'Quick reminder — please share your tasklist for today when you get a moment. 🙏';

function tagForJid(jid: string): string {
  return `@${jid.split('@')[0]}`;
}

export class MorningTasklistReminderJob implements Job {
  name = 'MorningTasklistReminderJob';
  schedule = '0 12 * * 1-5';
  description = 'At 12 PM IST on weekdays, draft ONE group nudge in the meetings group tagging everyone who has not yet shared their tasklist. Sid picks the final recipient set in the approval UI.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }

    const members = ctx.team.getMembers();
    const candidates = members.filter(m => !m.excludeFromTasklist);  // every member who CAN be tagged
    const missing = candidates.filter(m => !ctx.tasklists.hasSubmittedToday(m.jid));

    if (missing.length === 0) {
      ctx.dailyRuns.recordRun(today, this.name);
      ctx.logger.info({ today, candidateCount: candidates.length }, 'MorningTasklistReminderJob done (nobody missing)');
      return;
    }

    const groupJid = ctx.team.getGroupJid('meetings');
    if (!groupJid) {
      ctx.logger.warn({ today }, 'no meetings group configured — skipping nudge');
      ctx.dailyRuns.recordRun(today, this.name);
      return;
    }

    // Default selection = missing. The approval UI lets Sid toggle any
    // candidate on/off; on submit, body's tag line is rebuilt from the
    // checked set.
    const tags = missing.map(m => tagForJid(m.jid)).join(' ');
    const body = `${tags}\n\n${DEFAULT_BODY_TAIL}`;

    ctx.outbound.enqueue({
      toJid: groupJid,
      body,
      mentions: missing.map(m => m.jid),
      kind: 'tasklist_nudge',
      context: {
        groupJid,
        date: today,
        bodyTail: DEFAULT_BODY_TAIL,
        // Static for the lifetime of the draft — even if Sid eventually checks
        // someone outside the missing set, the candidate pool defines the
        // checkbox list rendered in the UI.
        candidates: candidates.map(m => ({ jid: m.jid, name: m.name || m.jid.split('@')[0] })),
        missingJids: missing.map(m => m.jid),
      },
      dedupKey: `tasklist_nudge_group:${today}`,
    });

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, groupJid, candidates: candidates.length, missing: missing.length }, 'tasklist nudge drafted (group)');
  }
}
