import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import type { TeamMember } from '../db/repos/TeamRepo.js';

const EOD_PROMPT_DM = `EOD check-in 🌙

Please reply (in this DM) with:
1. What did you complete today?
2. What's left / pending?
3. Any blockers?

You can reply in one go — just one message is enough.`;

const EOD_PROMPT_GROUP_TAIL = `EOD check-in 🌙

Please reply with:
1. What did you complete today?
2. What's left / pending?
3. Any blockers?

One message each is enough.`;

function tagForJid(jid: string): string {
  return `@${jid.split('@')[0]}`;
}

export class EodKickoffJob implements Job {
  name = 'EodKickoffJob';
  schedule = '0 19 * * 1-5';
  description = 'At 19:00 IST weekdays, queue EOD prompts: per-member DM or one combined group post per eodChannel (tagging all members in that group).';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();

    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today, skipping');
      return;
    }

    const session = ctx.eod.ensureSession(today);
    const members = ctx.team.getMembers();

    // Bucket members by eodChannel. 'dm' or unset → individual DM. Otherwise
    // group key (must resolve to a configured group jid).
    const dmRecipients: TeamMember[] = [];
    const byGroupKey = new Map<string, TeamMember[]>();

    for (const member of members) {
      if (member.excludeFromEod) continue;
      const channel = (member.eodChannel || 'dm').trim();
      if (channel === 'dm') {
        dmRecipients.push(member);
        continue;
      }
      if (!byGroupKey.has(channel)) byGroupKey.set(channel, []);
      byGroupKey.get(channel)!.push(member);
    }

    let queued = 0;

    // 1) DM each direct-recipient.
    for (const member of dmRecipients) {
      ctx.outbound.enqueue({
        toJid: member.jid,
        body: EOD_PROMPT_DM,
        kind: 'eod_check_in',
        context: { memberJid: member.jid, memberName: member.name, sessionId: session.id, date: today },
        dedupKey: `eod_check_in:${today}:${member.jid}`,
      });
      queued++;
      ctx.logger.info({ member: member.jid, name: member.name || '(no name)' }, 'EOD kickoff DM queued');
    }

    // 2) One combined post per group, tagging all assigned members. Validate
    //    each assigned member is actually in the group via groupMetadata —
    //    anyone missing falls back to a DM with a logged warning.
    for (const [groupKey, groupMembers] of byGroupKey) {
      const groupJid = ctx.team.getGroupJid(groupKey);
      if (!groupJid) {
        ctx.logger.warn({ groupKey, members: groupMembers.map(m => m.jid) }, 'eodChannel group not configured in team.json — falling back to DMs');
        for (const member of groupMembers) {
          ctx.outbound.enqueue({
            toJid: member.jid,
            body: EOD_PROMPT_DM,
            kind: 'eod_check_in',
            context: { memberJid: member.jid, memberName: member.name, sessionId: session.id, date: today, fallback: 'missing_group' },
            dedupKey: `eod_check_in:${today}:${member.jid}`,
          });
          queued++;
        }
        continue;
      }

      // Build a lookup set of every JID-shape we know for the group's members.
      // `inboundService` is undefined under CLI runs — in that case we skip
      // validation rather than block the kickoff.
      const participants = ctx.inboundService
        ? await ctx.inboundService.getGroupParticipants(groupJid)
        : undefined;
      const presentJids = participants
        ? new Set(participants.flatMap(p => [p.id, p.lid, p.phoneNumber].filter((x): x is string => !!x)))
        : null;

      const inGroup: typeof groupMembers = [];
      const notInGroup: typeof groupMembers = [];
      for (const m of groupMembers) {
        if (!presentJids) { inGroup.push(m); continue; }
        const candidates = [m.jid, m.lid].filter((x): x is string => !!x);
        if (candidates.some(c => presentJids.has(c))) inGroup.push(m);
        else notInGroup.push(m);
      }

      // Anyone not in the group: DM fallback.
      for (const member of notInGroup) {
        ctx.logger.warn(
          { groupKey, groupJid, memberJid: member.jid, memberName: member.name },
          'member not found in eodChannel group — falling back to DM'
        );
        ctx.outbound.enqueue({
          toJid: member.jid,
          body: EOD_PROMPT_DM,
          kind: 'eod_check_in',
          context: { memberJid: member.jid, memberName: member.name, sessionId: session.id, date: today, fallback: 'not_in_group', groupKey },
          dedupKey: `eod_check_in:${today}:${member.jid}`,
        });
        queued++;
      }

      if (inGroup.length === 0) {
        ctx.logger.warn({ groupKey, groupJid }, 'no validated members in group — skipping group post');
        continue;
      }

      const tags = inGroup.map(m => tagForJid(m.jid)).join(' ');
      const body = `${tags}\n\n${EOD_PROMPT_GROUP_TAIL}`;

      ctx.outbound.enqueue({
        toJid: groupJid,
        body,
        mentions: inGroup.map(m => m.jid),
        kind: 'eod_check_in',
        context: {
          groupKey,
          groupJid,
          sessionId: session.id,
          date: today,
          recipients: inGroup.map(m => ({ jid: m.jid, name: m.name || m.jid.split('@')[0] })),
          validated: !!presentJids,
        },
        dedupKey: `eod_check_in_group:${today}:${groupKey}`,
      });
      queued++;
      ctx.logger.info({ groupKey, groupJid, recipients: inGroup.length, validated: !!presentJids, fellBack: notInGroup.length }, 'EOD kickoff group post queued');
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, queued, sessionId: session.id, dms: dmRecipients.length, groups: byGroupKey.size }, 'EodKickoffJob done');
  }
}
