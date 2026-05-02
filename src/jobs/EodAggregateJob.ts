import type { Job, JobContext } from './Job.js';
import { istDateString } from '../utils/time.js';
import {
  parseEodReplySystem,
  parseEodReplySchema,
  buildParseEodReplyUser,
  type ParseEodReplyOutput,
} from '../llm/prompts/parseEodReply.js';
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
  description = 'At 20:30 IST weekdays: parse each member\'s raw EOD reply, compare vs morning plan, queue summary for approval.';

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
      const reply = ctx.eod.getReply(session.id, member.jid);
      const responded = !!reply;

      let done = '';
      let remaining = '';
      let blockers = '';

      if (reply) {
        // Parse first if not already parsed (last-reply-wins clears parsed_*).
        if (reply.parsed_done == null) {
          try {
            const parsed = await ctx.gemini.classify<ParseEodReplyOutput>({
              system: parseEodReplySystem,
              user: buildParseEodReplyUser({
                senderName: member.name || member.jid,
                reply: reply.raw_reply,
              }),
              schema: parseEodReplySchema,
            });
            ctx.eod.setParsed(session.id, member.jid, parsed.data.done, parsed.data.left, parsed.data.blockers);
            done = parsed.data.done;
            remaining = parsed.data.left;
            blockers = parsed.data.blockers;
          } catch (err) {
            ctx.logger.error({ err, member: member.jid }, 'parseEodReply failed; using raw');
            done = reply.raw_reply;
          }
        } else {
          done = reply.parsed_done || '';
          remaining = reply.parsed_left || '';
          blockers = reply.parsed_blockers || '';
        }
      }

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

    // Group post: queue for approval (non-Sid recipient).
    const meetingsJid = ctx.team.getGroupJid('meetings');
    if (meetingsJid) {
      let groupMsg = `*EOD ${today}*\n\n${out.team_overview}`;
      if (out.top_blockers.length) {
        groupMsg += `\n\n*Top blockers:*\n` + out.top_blockers.map(b => `• ${b}`).join('\n');
      }
      ctx.outbound.enqueue({
        toJid: meetingsJid,
        body: groupMsg,
        kind: 'eod_summary',
        context: { sessionId: session.id, date: today },
        dedupKey: `eod_summary:${today}`,
      });
    } else {
      ctx.logger.warn('no meetings group configured in team.json; skipping group queue');
    }

    // DM to Sid (himself) — auto-send, doesn't need approval.
    if (ctx.inboundService) {
      try {
        await ctx.inboundService.sendMessage(ctx.team.getUserJid(), summaryMd);
      } catch (err) {
        ctx.logger.error({ err }, 'failed to DM EOD summary to user');
      }
    }

    ctx.eod.markPosted(session.id, summaryMd);
    ctx.logger.info(
      { today, sessionId: session.id, memberCount: memberInputs.length, blockers: out.top_blockers.length },
      'EodAggregateJob done — group post queued for approval'
    );
  }
}
