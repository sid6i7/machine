import type { TeamRepo } from '../db/repos/TeamRepo.js';
import type { SummariesRepo } from '../db/repos/SummariesRepo.js';
import type { OutboundQueueRepo, PendingOutbound } from '../db/repos/OutboundQueueRepo.js';

export interface EnqueueDeps {
  team: TeamRepo;
  summaries: SummariesRepo;
  outbound: OutboundQueueRepo;
}

// Build the per-member day recap as a single WhatsApp DM body and enqueue it
// to the user. Idempotent via dedupKey: re-running for the same date returns
// the existing pending row instead of duplicating.
export function enqueueDailySummaryDm(
  deps: EnqueueDeps,
  date: string,
  source: string,
): { queued: PendingOutbound | null; reason?: string } {
  const rows = deps.summaries.listMembersForPeriod('day', date);
  if (rows.length === 0) return { queued: null, reason: 'no member_summaries rows' };

  const nameByJid = new Map(deps.team.getMembers().map(m => [m.jid, m.name || m.jid.split('@')[0]]));
  const isEmpty = (md: string) => /no activity captured/i.test(md.trim());
  const active = rows.filter(r => !isEmpty(r.summary_md));
  const inactive = rows.filter(r => isEmpty(r.summary_md));

  let body = `*Daily summary — ${date}*\n`;
  for (const r of active) {
    const name = nameByJid.get(r.member_jid) || r.member_jid.split('@')[0];
    body += `\n_${name}_\n${r.summary_md}\n`;
  }
  if (inactive.length) {
    const names = inactive.map(r => nameByJid.get(r.member_jid) || r.member_jid.split('@')[0]);
    body += `\n_No activity captured:_ ${names.join(', ')}\n`;
  }

  const queued = deps.outbound.enqueue({
    toJid: deps.team.getUserJid(),
    body,
    kind: 'eod_summary_dm',
    context: { date, source },
    dedupKey: `daily_summary_dm:${date}`,
  });
  return { queued };
}
