import type { Job, JobContext } from './Job.js';
import { istDateString, weekStartDate, workingDaysInRange } from '../utils/time.js';

// Heuristic prefill for the weekly rubric. PM edits + finalizes via /evaluations.
// Once a row's saved_at is non-null, this job leaves it alone.
//
// Score math (deliberately simple — these are starting points, not authoritative):
//   score_properly  (0-6): days with EOD reply / working days × 6
//   score_on_time   (0-6): days with BOTH tasklist + EOD / working days × 6
//   score_updates   (0-6): (tasklist + EOD + ≥1 self-initiated update per day, max 3/day) / (3 × workingDays) × 6
//   score_feedback  (0-1): default 1; PM eyeballs against last week's feedback_text shown in UI
export class WeeklyEvaluationPrefillJob implements Job {
  name = 'WeeklyEvaluationPrefillJob';
  schedule = '5 21 * * 5';
  description = 'Friday 21:05 IST: pre-fill weekly evaluation rubric for each member from raw signals; PM edits + finalizes in /evaluations.';

  async run(ctx: JobContext): Promise<void> {
    const today = istDateString();
    if (ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today; skipping');
      return;
    }

    const weekStart = weekStartDate();
    const workingDays = workingDaysInRange(weekStart, today);
    if (workingDays.length === 0) {
      ctx.logger.warn({ today, weekStart }, 'no working days; skipping');
      return;
    }
    const wd = workingDays.length;

    const members = ctx.team.getMembers().filter(m => !m.excludeFromEod);
    const monitoredJids = ctx.team.getMonitoredGroupJids();
    const placeholders = monitoredJids.map(() => '?').join(',') || "''";

    let touched = 0;
    let skipped = 0;
    for (const m of members) {
      const existing = ctx.evaluations.get(weekStart, m.jid);
      if (existing && existing.saved_at) { skipped++; continue; }

      // Per-day signals
      const perDay = workingDays.map(d => {
        const tasklist = ctx.tasklists.hasSubmittedToday(m.jid, d);
        const session = ctx.eod.getSession(d);
        const eod = session ? !!ctx.eod.getReply(session.id, m.jid) : false;
        const dayStartSec = Math.floor(new Date(d + 'T00:00:00+05:30').getTime() / 1000);
        const dayEndSec = dayStartSec + 86400;
        const updRow = monitoredJids.length ? ctx.db.prepare(`
          SELECT COUNT(*) c FROM messages
          WHERE classified_intent='task_update' AND participant_jid=? AND ts >= ? AND ts < ?
            AND remote_jid IN (${placeholders})
        `).get(m.jid, dayStartSec, dayEndSec, ...monitoredJids) as { c: number } : { c: 0 };
        return { date: d, tasklist, eod, selfInitiatedUpdates: updRow.c };
      });

      const eodCount = perDay.filter(p => p.eod).length;
      const tasklistCount = perDay.filter(p => p.tasklist).length;
      const bothCount = perDay.filter(p => p.eod && p.tasklist).length;
      const updateBoolSum = perDay.reduce((acc, p) =>
        acc + (p.tasklist ? 1 : 0) + (p.eod ? 1 : 0) + (p.selfInitiatedUpdates > 0 ? 1 : 0), 0);

      const scoreProperly = Math.round((eodCount / wd) * 6);
      const scoreOnTime   = Math.round((bothCount / wd) * 6);
      const scoreUpdates  = Math.round((updateBoolSum / (3 * wd)) * 6);

      const lastSaved = ctx.evaluations.getLatestSaved(m.jid, weekStart);
      const lastFeedback = lastSaved?.feedback_text || '';
      // Default to 1; PM eyeballs against the surfaced last_feedback in UI.
      const scoreFeedback = 1;

      const evidence = {
        weekStart, workingDays, perDay,
        derived: { eodCount, tasklistCount, bothCount, updateBoolSum, updatesMax: 3 * wd },
        lastFeedback,
        notes: 'Heuristic prefill — PM edits before saving. score_properly/on_time use compliance counts as a proxy; score_updates aggregates the 3 daily signals.',
      };

      ctx.evaluations.upsert({
        weekStartDate: weekStart,
        memberJid: m.jid,
        scoreProperly,
        scoreOnTime,
        scoreUpdates,
        scoreFeedback,
        feedbackText: existing?.feedback_text ?? null,
        evidence,
      });
      touched++;
    }

    ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, weekStart, touched, skipped }, 'WeeklyEvaluationPrefillJob done');
  }
}
