import type { Job, JobContext } from './Job.js';
import { istDateString, weekStartDate, workingDaysInRange } from '../utils/time.js';
import {
  weeklyMemberSummarySystem,
  weeklyMemberSummarySchema,
  buildWeeklyMemberSummaryUser,
  type WeeklyMemberSummaryInput,
  type WeeklyMemberSummaryOutput,
} from '../llm/prompts/weeklyMemberSummary.js';
import {
  weeklyTeamSummarySystem,
  weeklyTeamSummarySchema,
  buildWeeklyTeamSummaryUser,
  type WeeklyTeamSummaryInput,
  type WeeklyTeamSummaryOutput,
} from '../llm/prompts/weeklyTeamSummary.js';

export interface WeeklyTeamSummaryOpts {
  // Force regenerating a specific week (Monday YYYY-MM-DD). Bypasses the
  // daily_runs guard. When unset, runs for the current week and respects
  // the guard.
  weekStart?: string;
}

export async function runWeeklyTeamSummary(ctx: JobContext, opts: WeeklyTeamSummaryOpts = {}): Promise<void> {
    const jobName = 'WeeklyTeamSummaryJob';
    const explicit = opts.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(opts.weekStart) ? opts.weekStart : undefined;
    // CLI fallback: --week=YYYY-MM-DD (must be a Monday) for `npm run job …`.
    const argvWeek = explicit ? undefined : process.argv.find(a => a.startsWith('--week='))?.split('=')[1];
    const argvOverride = !!argvWeek && /^\d{4}-\d{2}-\d{2}$/.test(argvWeek);
    const isOverride = !!explicit || argvOverride;

    const today = istDateString();
    if (!isOverride && ctx.dailyRuns.hasRun(today, jobName)) {
      ctx.logger.info({ today, job: jobName }, 'already ran today; skipping');
      return;
    }

    const weekStart = explicit ?? (argvOverride ? argvWeek! : weekStartDate());
    // For overrides, anchor the window at Friday of that Monday so we get a full Mon-Fri range.
    const fridayMs = new Date(weekStart + 'T12:00:00+05:30').getTime() + 4 * 86_400_000;
    const fridayDate = istDateString(fridayMs);
    const rangeEnd = isOverride ? fridayDate : today;
    const workingDays = workingDaysInRange(weekStart, rangeEnd);
    if (workingDays.length === 0) {
      ctx.logger.warn({ today, weekStart }, 'no working days in window; skipping');
      return;
    }
    const weekStartMs = new Date(weekStart + 'T00:00:00+05:30').getTime();
    const weekEndAnchor = isOverride ? fridayDate : today;
    const weekEndMs = new Date(weekEndAnchor + 'T23:59:59+05:30').getTime();
    const weekEnd = workingDays[workingDays.length - 1];

    const members = ctx.team.getMembers().filter(m => !m.excludeFromEod);
    const memberInputs: WeeklyTeamSummaryInput['members'] = [];

    for (const m of members) {
      const dailies = ctx.summaries.listMemberDays(m.jid, weekStart, today);
      const dailyMap = new Map(dailies.map(d => [d.period_start, d.summary_md]));

      // Weekly stats (cheap counts).
      const tasklistsSubmitted = workingDays.filter(d => ctx.tasklists.hasSubmittedToday(m.jid, d)).length;
      const monitoredJids = ctx.team.getMonitoredGroupJids();
      const placeholders = monitoredJids.map(() => '?').join(',') || "''";
      const eodSubmitted = workingDays.filter(d => {
        const s = ctx.eod.getSession(d);
        return s ? !!ctx.eod.getReply(s.id, m.jid) : false;
      }).length;
      const startSec = Math.floor(weekStartMs / 1000);
      const endSec = Math.floor(weekEndMs / 1000);
      const upd = monitoredJids.length ? ctx.db.prepare(`
        SELECT COUNT(*) c FROM messages
        WHERE classified_intent='task_update' AND participant_jid=? AND ts >= ? AND ts <= ?
          AND remote_jid IN (${placeholders})
      `).get(m.jid, startSec, endSec, ...monitoredJids) as { c: number } : { c: 0 };
      const selfInitiated = upd.c;
      const memberName = (m.name || '').trim();
      const merged = memberName ? ctx.db.prepare(`
        SELECT COUNT(*) c FROM gitlab_merged_log WHERE author=? AND merged_at >= ? AND merged_at <= ?
      `).get(memberName, weekStartMs, weekEndMs) as { c: number } : { c: 0 };

      const input: WeeklyMemberSummaryInput = {
        name: m.name || m.jid.split('@')[0],
        weekStart,
        dailySummaries: workingDays.map(d => ({ date: d, summary_md: dailyMap.get(d) || '• (no daily summary captured)' })),
        weekStats: {
          tasklistsSubmitted,
          eodSubmitted,
          selfInitiatedUpdates: selfInitiated,
          mrsMerged: merged.c,
          sheetItemsAdvanced: 0,        // intentionally not tracked v1
          workingDays: workingDays.length,
        },
      };

      let memberWeekly: WeeklyMemberSummaryOutput;
      try {
        const r = await ctx.gemini.classify<WeeklyMemberSummaryOutput>({
          system: weeklyMemberSummarySystem,
          user: buildWeeklyMemberSummaryUser(input),
          schema: weeklyMemberSummarySchema,
        });
        memberWeekly = r.data;
      } catch (err) {
        ctx.logger.error({ err, member: m.jid }, 'weeklyMemberSummary LLM failed; using fallback');
        memberWeekly = {
          summary_md: input.dailySummaries.map(d => `*${d.date}*\n${d.summary_md}`).join('\n'),
          themes: [],
          notable_blockers: [],
        };
      }

      ctx.summaries.upsertMember({
        member_jid: m.jid,
        period_kind: 'week',
        period_start: weekStart,
        summary_md: memberWeekly.summary_md,
        evidence_json: JSON.stringify({ ...input, themes: memberWeekly.themes, notable_blockers: memberWeekly.notable_blockers }),
      });

      memberInputs.push({
        name: input.name,
        summary_md: memberWeekly.summary_md,
        themes: memberWeekly.themes,
        notable_blockers: memberWeekly.notable_blockers,
      });
    }

    // "Made live" — MRs merged within the working-day window.
    const mergedThisWeek = ctx.mergedMrs.listInWindow(weekStartMs, weekEndMs + 1);
    const madeLive = mergedThisWeek.map(mr => ({
      author: mr.author || 'unknown',
      title: mr.title,
      url: mr.url || '',
      targetBranch: mr.target_branch,
    }));

    const teamInput: WeeklyTeamSummaryInput = { weekStart, weekEnd, members: memberInputs, madeLive };
    let teamOut: WeeklyTeamSummaryOutput;
    const smartModel = process.env.LLM_MODEL_SMART || 'gemini-2.5-pro';
    try {
      const r = await ctx.gemini.classify<WeeklyTeamSummaryOutput>({
        system: weeklyTeamSummarySystem,
        user: buildWeeklyTeamSummaryUser(teamInput),
        schema: weeklyTeamSummarySchema,
        model: smartModel,
      });
      teamOut = r.data;
    } catch (err) {
      ctx.logger.error({ err }, 'weeklyTeamSummary LLM failed; using minimal fallback');
      teamOut = {
        team_overview_md: memberInputs.map(mi => `**${mi.name}**\n${mi.summary_md}`).join('\n\n'),
        made_live_md: madeLive.length
          ? madeLive.map(mr => `• [${mr.author}] ${mr.title} (${mr.url})`).join('\n')
          : '_Nothing merged this week._',
        top_themes: [],
        top_blockers: [],
      };
    }

    ctx.summaries.upsertTeam({
      period_kind: 'week',
      period_start: weekStart,
      summary_md: teamOut.team_overview_md,
      made_live_md: teamOut.made_live_md,
      evidence_json: JSON.stringify({ ...teamInput, top_themes: teamOut.top_themes, top_blockers: teamOut.top_blockers }),
    });

    // Queue weekly DM to Sid for approval (per outbound rule).
    const dmBody = [
      `*Weekly summary — ${weekStart} → ${weekEnd}*`,
      '',
      teamOut.team_overview_md,
      '',
      '*Made live this week*',
      teamOut.made_live_md,
      '',
      teamOut.top_blockers.length ? `*Top blockers*\n` + teamOut.top_blockers.map(b => `• ${b}`).join('\n') : '',
    ].filter(Boolean).join('\n');

    ctx.outbound.enqueue({
      toJid: ctx.team.getUserJid(),
      body: dmBody,
      kind: 'weekly_summary_dm',
      context: { weekStart, weekEnd },
      dedupKey: `weekly_summary:${weekStart}`,
    });

    if (!isOverride) ctx.dailyRuns.recordRun(today, jobName);
    ctx.logger.info({ today, weekStart, members: members.length, mergedThisWeek: madeLive.length, override: isOverride }, 'WeeklyTeamSummaryJob done');
}

export class WeeklyTeamSummaryJob implements Job {
  name = 'WeeklyTeamSummaryJob';
  schedule = '0 21 * * 5';
  description = 'Friday 21:00 IST: roll up the week — per-member weekly summaries + team-level summary + made-live MRs. Queues a DM digest for approval.';

  async run(ctx: JobContext): Promise<void> {
    await runWeeklyTeamSummary(ctx);
  }
}
