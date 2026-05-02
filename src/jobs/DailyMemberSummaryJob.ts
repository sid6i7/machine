import type { Job, JobContext } from './Job.js';
import { istDateString, isWorkingDay } from '../utils/time.js';
import {
  dailyMemberSummarySystem,
  dailyMemberSummarySchema,
  buildDailyMemberSummaryUser,
  type DailyMemberSummaryOutput,
  type DailyMemberSummaryInput,
} from '../llm/prompts/dailyMemberSummary.js';

const MAX_UPDATE_SAMPLES = 5;

export class DailyMemberSummaryJob implements Job {
  name = 'DailyMemberSummaryJob';
  schedule = '0 21 * * 1-5';
  description = 'At 21:00 IST weekdays (after EOD aggregate), build a per-member day recap from tasklist + EOD + self-initiated updates + MR/sheet activity.';

  async run(ctx: JobContext): Promise<void> {
    // CLI override: --date=YYYY-MM-DD lets us regenerate any past day. Bypasses
    // the daily_runs guard and skips the working-day check.
    const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
    const today = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : istDateString();
    const isOverride = !!dateArg;

    if (!isOverride && !isWorkingDay(Date.now())) {
      ctx.logger.info({ today, job: this.name }, 'not a working day; skipping');
      return;
    }
    if (!isOverride && ctx.dailyRuns.hasRun(today, this.name)) {
      ctx.logger.info({ today, job: this.name }, 'already ran today; skipping');
      return;
    }

    const members = ctx.team.getMembers().filter(m => !m.excludeFromEod);
    const monitoredJids = ctx.team.getMonitoredGroupJids();
    if (isOverride) {
      ctx.logger.info({ today, job: this.name }, 'CLI date override; daily_runs guard bypassed');
    }
    const dayStartMs = new Date(today + 'T00:00:00+05:30').getTime();
    const dayEndMs = dayStartMs + 86_400_000;
    const dayStartSec = Math.floor(dayStartMs / 1000);
    const dayEndSec = Math.floor(dayEndMs / 1000);

    let written = 0;
    for (const m of members) {
      // Tasklist
      const tasklistRow = ctx.tasklists.getForMemberDate(m.jid, today);
      const tasklistItems: string[] = tasklistRow
        ? (JSON.parse(tasklistRow.items_json) as { text: string }[]).map(i => i.text)
        : [];

      // EOD reply (use parsed if available, else raw)
      const session = ctx.eod.getSession(today);
      const reply = session ? ctx.eod.getReply(session.id, m.jid) : undefined;
      const eod = reply ? {
        done:     reply.parsed_done    ?? reply.raw_reply,
        left:     reply.parsed_left    ?? '',
        blockers: reply.parsed_blockers ?? '',
      } : null;

      // Self-initiated updates: count + a small sample
      const monitoredPlaceholders = monitoredJids.map(() => '?').join(',') || "''";
      const updateRows = monitoredJids.length ? ctx.db.prepare(`
        SELECT text FROM messages
        WHERE classified_intent = 'task_update'
          AND participant_jid = ?
          AND ts >= ? AND ts < ?
          AND remote_jid IN (${monitoredPlaceholders})
        ORDER BY ts ASC LIMIT ?
      `).all(m.jid, dayStartSec, dayEndSec, ...monitoredJids, MAX_UPDATE_SAMPLES) as { text: string | null }[] : [];
      const updateCountRow = monitoredJids.length ? ctx.db.prepare(`
        SELECT COUNT(*) c FROM messages
        WHERE classified_intent = 'task_update'
          AND participant_jid = ?
          AND ts >= ? AND ts < ?
          AND remote_jid IN (${monitoredPlaceholders})
      `).get(m.jid, dayStartSec, dayEndSec, ...monitoredJids) as { c: number } | undefined : { c: 0 };
      const selfInitiatedCount = updateCountRow?.c ?? 0;
      const selfInitiatedUpdates = updateRows
        .map(r => (r.text || '').slice(0, 160))
        .filter(Boolean);

      // MRs touched today: open MRs whose metadata.author matches AND metadata.updated_at falls today,
      // plus merged_log rows from today.
      const memberName = (m.name || '').trim();
      const openMrs = memberName ? ctx.db.prepare(`
        SELECT title, url, json_extract(metadata_json,'$.updated_at') as upd
        FROM backlog_items WHERE source='gitlab' AND status='open'
          AND json_extract(metadata_json,'$.author') = ?
      `).all(memberName) as { title: string; url: string; upd: string }[] : [];
      const openMrsToday = openMrs.filter(mr => {
        const t = mr.upd ? Date.parse(mr.upd) : NaN;
        return !isNaN(t) && t >= dayStartMs && t < dayEndMs;
      }).map(mr => ({ title: mr.title, url: mr.url, merged: false }));
      const mergedToday = memberName ? ctx.db.prepare(`
        SELECT title, url FROM gitlab_merged_log
        WHERE author = ? AND merged_at >= ? AND merged_at < ?
      `).all(memberName, dayStartMs, dayEndMs) as { title: string; url: string }[] : [];
      const mrsTouched = [
        ...openMrsToday,
        ...mergedToday.map(mr => ({ title: mr.title, url: mr.url, merged: true })),
      ];

      // Sheet items advanced today: rows where Allotted to includes member's name AND updated_at falls today.
      // updated_at gets touched every sync, so this is noisy — restrict to status changes is hard without
      // history, so instead we just surface the titles when there's a non-default Status.
      const sheetItemsAdvanced: string[] = []; // intentionally empty in v1; add when we snapshot history

      const evidence: DailyMemberSummaryInput = {
        name: m.name || m.jid.split('@')[0],
        date: today,
        tasklist: tasklistItems,
        eod,
        selfInitiatedUpdates,
        selfInitiatedCount,
        mrsTouched,
        sheetItemsAdvanced,
      };

      // Skip the LLM call if there's truly nothing to summarize.
      const hasAnything = tasklistItems.length > 0 || eod || selfInitiatedCount > 0 || mrsTouched.length > 0;
      let summaryMd: string;
      if (!hasAnything) {
        summaryMd = '• No activity captured for this day.';
      } else {
        try {
          const r = await ctx.gemini.classify<DailyMemberSummaryOutput>({
            system: dailyMemberSummarySystem,
            user: buildDailyMemberSummaryUser(evidence),
            schema: dailyMemberSummarySchema,
          });
          summaryMd = r.data.summary_md;
        } catch (err) {
          ctx.logger.error({ err, member: m.jid }, 'dailyMemberSummary LLM failed; using raw fallback');
          const parts: string[] = [];
          if (eod?.done) parts.push(`• Done: ${eod.done.slice(0, 200)}`);
          if (eod?.left) parts.push(`• Left: ${eod.left.slice(0, 200)}`);
          if (eod?.blockers) parts.push(`• Blockers: ${eod.blockers.slice(0, 200)}`);
          if (selfInitiatedCount > 0) parts.push(`• ${selfInitiatedCount} self-initiated update(s) in groups.`);
          summaryMd = parts.join('\n') || '• No activity captured for this day.';
        }
      }

      ctx.summaries.upsertMember({
        member_jid: m.jid,
        period_kind: 'day',
        period_start: today,
        summary_md: summaryMd,
        evidence_json: JSON.stringify(evidence),
      });
      written++;
    }

    if (!isOverride) ctx.dailyRuns.recordRun(today, this.name);
    ctx.logger.info({ today, written, members: members.length, override: isOverride }, 'DailyMemberSummaryJob done');
  }
}
