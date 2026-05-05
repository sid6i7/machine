import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';

// Returns yesterday's IST date string. (Falls back to today on weekends since
// we don't run on Sat/Sun anyway.)
function previousIstDate(): string {
  return istDateString(Date.now() - 24 * 60 * 60 * 1000);
}

export class MorningEodCatchupJob implements Job {
  name = 'MorningEodCatchupJob';
  schedule = '0 8 * * 2-5';
  description = '8 AM IST Tue-Fri: DM the user any EOD replies that landed AFTER yesterday\'s aggregate post — folds late shares into the morning view.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();
    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }
    if (!ctx.inboundService) {
      ctx.logger.warn({ job: this.name }, 'no inboundService; cannot DM');
      return;
    }
    if (!ctx.team.exists()) {
      ctx.logger.warn({ job: this.name }, 'team.json missing; skipping');
      return;
    }

    const yesterday = previousIstDate();
    const session = ctx.eod.getSession(yesterday);
    if (!session) {
      ctx.logger.info({ yesterday }, 'no EOD session yesterday; nothing to catch up');
      ctx.dailyRuns.recordRun(today, this.name);
      return;
    }

    // "Late" = recorded after the aggregate posted (or, if aggregate never
    // posted, after the canonical 20:00 cutoff in IST).
    const cutoffMs = session.posted_at
      ?? new Date(yesterday + 'T20:00:00+05:30').getTime();

    const replies = ctx.eod.listReplies(session.id).filter(r => r.recorded_at > cutoffMs);
    if (replies.length === 0) {
      ctx.logger.info({ yesterday, sessionId: session.id }, 'no late EOD replies — skipping DM');
      ctx.dailyRuns.recordRun(today, this.name);
      return;
    }

    const nameByJid = new Map(ctx.team.getMembers().map(m => [m.jid, m.name || m.jid.split('@')[0]]));

    const lines: string[] = [`*Late EOD updates — ${yesterday}*`, ''];
    for (const r of replies) {
      const name = nameByJid.get(r.member_jid) || r.member_jid.split('@')[0];
      const body = r.parsed_done || r.raw_reply || '';
      const trimmed = body.length > 600 ? body.slice(0, 600) + '…' : body;
      lines.push(`_${name}_`);
      lines.push(trimmed || '(no content)');
      lines.push('');
    }

    try {
      await ctx.inboundService.sendMessage(ctx.team.getUserJid(), lines.join('\n').trimEnd());
      ctx.dailyRuns.recordRun(today, this.name);
      ctx.logger.info({ yesterday, sessionId: session.id, lateCount: replies.length }, 'late-EOD catchup DM sent');
    } catch (err) {
      ctx.logger.error({ err }, 'failed to send late-EOD catchup');
    }
  }
}
