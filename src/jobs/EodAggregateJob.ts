import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import {
  compareDoneVsPlanSystem,
  compareDoneVsPlanSchema,
  buildCompareDoneVsPlanUser,
  type CompareDoneVsPlanOutput
} from '../llm/prompts/compareDoneVsPlan.js';
import {
  aggregateEodSummarySystem,
  aggregateEodSummarySchema,
  buildAggregateEodSummaryUser,
  type AggregateEodOutput,
  type MemberInput
} from '../llm/prompts/aggregateEodSummary.js';

export class EodAggregateJob implements Job {
  name = 'EodAggregateJob';
  schedule = '30 20 * * 1-5';
  description = 'At 20:30 IST weekdays, aggregate EOD answers, post summary to meetings group + DM the user.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();
    const session = ctx.eod.getSession(today);
    if (!session) {
      ctx.logger.info({ today }, 'no EOD session today; skipping');
      return;
    }
    if (session.posted_at) {
      ctx.logger.info({ today, sessionId: session.id }, 'already posted; skipping');
      return;
    }

    const members = ctx.team.getMembers().filter(m => !m.excludeFromEod);
    const memberInputs: MemberInput[] = [];
    const smartModel = process.env.LLM_MODEL_SMART || 'gemini-2.5-pro';

    for (const member of members) {
      const answers = ctx.eod.getMemberAnswers(session.id, member.jid);
      const responded = answers.length > 0;
      const done = answers.find(a => a.question_idx === 0)?.text || '';
      const remaining = answers.find(a => a.question_idx === 1)?.text || '';
      const blockers = answers.find(a => a.question_idx === 2)?.text || '';

      const tasklist = ctx.tasklists.getForMemberDate(member.jid, today);
      const plan: string[] = tasklist
        ? (JSON.parse(tasklist.items_json) as { text: string }[]).map(it => it.text)
        : [];

      let comparison: CompareDoneVsPlanOutput | null = null;
      if (responded && plan.length > 0 && done) {
        try {
          const cmp = await ctx.gemini.classify<CompareDoneVsPlanOutput>({
            system: compareDoneVsPlanSystem,
            user: buildCompareDoneVsPlanUser({ plan, done }),
            schema: compareDoneVsPlanSchema,
          });
          comparison = cmp.data;
        } catch (err) {
          ctx.logger.error({ err, member: member.jid }, 'compareDoneVsPlan failed');
        }
      }

      memberInputs.push({
        name: member.name || member.jid,
        plan,
        done,
        remaining,
        blockers,
        comparison,
        responded,
      });
    }

    const summary = await ctx.gemini.classify<AggregateEodOutput>({
      system: aggregateEodSummarySystem,
      user: buildAggregateEodSummaryUser(memberInputs),
      schema: aggregateEodSummarySchema,
      model: smartModel,
    });
    const out = summary.data;

    let summaryMd = `*EOD Summary — ${today}*\n\n${out.team_overview}\n`;
    if (out.top_blockers.length) {
      summaryMd += `\n*Top blockers*\n` + out.top_blockers.map(b => `• ${b}`).join('\n') + '\n';
    }
    summaryMd += `\n*Per member*\n`;
    for (const block of out.member_blocks) {
      summaryMd += `\n_${block.name}_\n${block.markdown}\n`;
    }

    if (ctx.inboundService) {
      // Short post in meetings group: overview + blockers only.
      const meetingsJid = ctx.team.getGroupJid('meetings');
      if (meetingsJid) {
        let groupMsg = `*EOD ${today}*\n\n${out.team_overview}`;
        if (out.top_blockers.length) {
          groupMsg += `\n\n*Top blockers:*\n` + out.top_blockers.map(b => `• ${b}`).join('\n');
        }
        try {
          await ctx.inboundService.sendMessage(meetingsJid, groupMsg);
        } catch (err) {
          ctx.logger.error({ err }, 'failed to post EOD summary to meetings group');
        }
      } else {
        ctx.logger.warn('no meetings group configured in team.json; skipping group post');
      }

      // Full breakdown DMed to the PM (userJid).
      try {
        await ctx.inboundService.sendMessage(ctx.team.getUserJid(), summaryMd);
      } catch (err) {
        ctx.logger.error({ err }, 'failed to DM EOD summary to user');
      }
    } else {
      ctx.logger.warn({ job: this.name }, 'no inboundService; will not post but will still mark session');
    }

    ctx.eod.markPosted(session.id, summaryMd);
    ctx.logger.info(
      { today, sessionId: session.id, memberCount: memberInputs.length, blockers: out.top_blockers.length },
      'EodAggregateJob done'
    );
  }
}
