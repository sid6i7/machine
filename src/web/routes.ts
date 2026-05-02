import type { FastifyInstance } from 'fastify';
import type { JobContext } from '../jobs/Job.js';
import type { BacklogSource, BacklogItem } from '../db/repos/BacklogRepo.js';
import { istDateString, weekStartDate, workingDaysInRange, workingHoursBetween } from '../utils/time.js';
import type { TopBacklogEntry, TopBadge, EodPanelData, EvalRow } from './views.js';

const SLA_HOURS = Number(process.env.MENTION_REPLY_SLA_HOURS || '4');
const MR_STALE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Heuristic parse for sheet ETA strings like '04/Feb' or '4-Mar-26'. Returns
// midnight-of-day timestamp in local time, or null if the format is unfamiliar.
function parseSheetEta(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/[\/-]+/g, ' ');
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) return null;
  const day = Number(parts[0]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const month = MONTH_NAMES[parts[1].toLowerCase().slice(0, 3)];
  if (month === undefined) return null;
  const yearRaw = parts[2] ? Number(parts[2]) : null;
  const year = yearRaw ? (yearRaw < 100 ? 2000 + yearRaw : yearRaw) : new Date().getFullYear();
  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

// Human-readable reasons for /plan, derived from the same heuristic as scoreItem.
function explainItem(i: BacklogItem, now: number, myAssignee: string): string[] {
  const reasons: string[] = [];
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};

  if (i.source === 'wa_mention_unreplied') {
    const overdue = workingHoursBetween(i.created_at, now);
    if (overdue >= SLA_HOURS) reasons.push(`mention ${Math.round(overdue)}h past SLA`);
    else reasons.push('unreplied mention');
  } else if (i.source === 'sheet') {
    const etaMs = parseSheetEta(meta.ETA ? String(meta.ETA) : null);
    const assignee = meta['Allotted to'] ? String(meta['Allotted to']) : '';
    if (etaMs !== null && etaMs < now) {
      const daysPast = Math.floor((now - etaMs) / MS_PER_DAY);
      reasons.push(`ETA ${daysPast}d past`);
    }
    if (assignee.toLowerCase().includes(myAssignee.toLowerCase())) reasons.push('assigned to you');
    if (!meta.ETA || !String(meta.ETA).trim()) reasons.push('no ETA set');
    const pri = (meta['New Priority'] || meta.Priority) ? String(meta['New Priority'] || meta.Priority).trim() : '';
    if (pri === '1') reasons.push('P1');
  } else if (i.source === 'gitlab') {
    const updatedAt = meta.updated_at ? Date.parse(String(meta.updated_at)) : NaN;
    if (!isNaN(updatedAt)) {
      const daysOld = Math.floor((now - updatedAt) / MS_PER_DAY);
      if (daysOld > MR_STALE_DAYS) reasons.push(`MR stale ${daysOld}d`);
      else reasons.push('open MR');
    } else {
      reasons.push('open MR');
    }
  } else if (i.source === 'wa_task') {
    const ageDays = Math.floor((now - i.created_at) / MS_PER_DAY);
    reasons.push(`WA task${i.is_dev_task ? ' (dev)' : ''}${ageDays === 0 ? ' today' : `, ${ageDays}d old`}`);
  } else if (i.source === 'wa_connect') {
    reasons.push('connect to schedule');
  }
  return reasons.length ? reasons : ['open'];
}

function scoreItem(i: BacklogItem, now: number): { score: number; badges: TopBadge[] } {
  const badges: TopBadge[] = [];
  let score = 0;
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};

  if (i.source === 'wa_mention_unreplied') {
    const overdue = workingHoursBetween(i.created_at, now);
    if (overdue >= SLA_HOURS) {
      score += 1000 + Math.min(overdue, 48);
      badges.push({ label: `${Math.round(overdue)}h overdue`, color: 'red' });
    } else {
      score += 100;
    }
  } else if (i.source === 'sheet') {
    const etaMs = parseSheetEta(meta.ETA ? String(meta.ETA) : null);
    if (etaMs !== null && etaMs < now) {
      const daysPast = Math.floor((now - etaMs) / MS_PER_DAY);
      score += 800 + Math.min(daysPast, 60);
      badges.push({ label: `ETA ${daysPast}d past`, color: 'amber' });
    }
  } else if (i.source === 'gitlab') {
    const updatedAt = meta.updated_at ? Date.parse(String(meta.updated_at)) : NaN;
    if (!isNaN(updatedAt)) {
      const daysOld = Math.floor((now - updatedAt) / MS_PER_DAY);
      if (daysOld > MR_STALE_DAYS) {
        score += 400 + daysOld;
        badges.push({ label: `stale ${daysOld}d`, color: 'blue' });
      } else {
        score += 200;
      }
    } else {
      score += 200;
    }
  } else if (i.source === 'wa_task') {
    score += 150 + (i.is_dev_task ? 30 : 0);
  } else if (i.source === 'wa_connect') {
    score += 90;
  }

  // Recency tiebreaker: a more recent item beats an older one within the same band.
  score += (i.created_at / 1e10);
  return { score, badges };
}
import {
  layout, dashboard, backlogPage, backlogRow, resolvedRow, messagesPage,
  outboundPage, outboundCard, outboundSentRow, outboundSkippedRow,
  backlogResultsPartial,
  planPage, planList, planRow, type PlanRow,
  summaryPage, evaluationsPage, evaluationRow,
} from './views.js';

// Default assignee substring for `mine=1` filter. Sourced from team.json's
// userJid → member name once on bootstrap; falls back to env override.
const MY_ASSIGNEE_NAME = process.env.MY_SHEET_ASSIGNEE || 'Siddhant';

const VALID_SOURCES: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];

export function registerRoutes(app: FastifyInstance, ctx: JobContext): void {
  // Sticky-rail context applied to every layout call. One shared helper so
  // adding a new page can't accidentally drop the pinned-rail / outbound-banner.
  const railCtx = () => ({
    pinnedToday: ctx.backlog.listPinnedForDate(istDateString()),
    pendingOutboundCount: ctx.outbound.pendingCount(),
  });

  app.get('/', async (req, reply) => {
    const today = istDateString();
    const q = req.query as { backfill?: string; date?: string };
    const selectedDate = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : today;
    const includeBackfill = q.backfill === '1';
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];

    const submittedJids = new Set<string>(
      ctx.tasklists.getForDate(selectedDate).map(t => t.member_jid)
    );

    const eodSession = ctx.eod.getSession(selectedDate) || null;
    const eodAnswers = eodSession ? ctx.eod.listAnswers(eodSession.id) : [];

    const allOpen = ctx.backlog.listAllOpen({ includeBackfill });
    const backlogBySource: Record<BacklogSource, number> = {
      sheet: 0, gitlab: 0, wa_task: 0, wa_connect: 0, wa_task_update: 0, wa_status_check: 0, wa_mention_unreplied: 0,
    };
    for (const i of allOpen) backlogBySource[i.source]++;

    // Top with scoring + badges; signals (task_update, status_check) excluded.
    // We score the WHOLE scoreable set so we can split Mine vs Team blockers
    // without losing the urgent items in the long tail.
    const now = Date.now();
    const scoreable = allOpen.filter(i => i.source !== 'wa_task_update' && i.source !== 'wa_status_check');
    const myLower = MY_ASSIGNEE_NAME.toLowerCase();
    const isMine = (i: BacklogItem): boolean => {
      const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
      if (i.source === 'sheet') {
        const a = meta['Allotted to'] ? String(meta['Allotted to']).toLowerCase() : '';
        return a.includes(myLower);
      }
      if (i.source === 'gitlab') {
        const a = meta.author ? String(meta.author).toLowerCase() : '';
        return a.includes(myLower);
      }
      return false;       // wa_* sources default to "team" — refine later
    };
    const topBacklogScored: TopBacklogEntry[] = scoreable
      .map(item => ({ item, mine: isMine(item), ...scoreItem(item, now) }))
      .sort((a, b) => b.score - a.score)
      .map(({ item, mine, badges }) => ({ item, mine, badges }));

    // Connects strip: all open wa_connect, prioritized for "today's calendar"
    const todaysConnects = ctx.backlog.listOpen({ source: 'wa_connect', includeBackfill });

    // ETA-missing count for me only
    const myMissingEta = ctx.backlog.listOpen({
      source: 'sheet',
      mineName: MY_ASSIGNEE_NAME,
      missingEta: true,
      includeBackfill,
    });

    // EOD recap: when viewing today, fall back to the most recent session if
    // none for today yet (gives morning context). When viewing a historical
    // date explicitly, show only that date's session (or empty).
    const eodForPanel = selectedDate === today
      ? (eodSession || ctx.eod.getMostRecentSession() || null)
      : eodSession;
    let eodPanel: EodPanelData | null = null;
    if (eodForPanel) {
      const sessionMembers = members.filter(m => !m.excludeFromEod);
      eodPanel = {
        date: eodForPanel.date,
        members: sessionMembers.map(m => {
          const reply = ctx.eod.getReply(eodForPanel.id, m.jid);
          return {
            name: m.name || m.jid.split('@')[0],
            responded: !!reply,
            done: (reply?.parsed_done ?? reply?.raw_reply ?? '').slice(0, 400),
            left: (reply?.parsed_left ?? '').slice(0, 400),
            blockers: (reply?.parsed_blockers ?? '').slice(0, 400),
          };
        }),
      };
    }

    const isPartial = (req.query as { _partial?: string })._partial === '1';
    const pendingOutboundCount = ctx.outbound.pendingCount();
    const pinnedToday = ctx.backlog.listPinnedForDate(today);

    const body = dashboard({
      date: selectedDate,
      members,
      submittedJids,
      eodSession,
      eodAnswers,
      backlogBySource,
      includeBackfill,
      pendingOutboundCount,
      todaysConnects,
      myMissingEtaCount: myMissingEta.length,
      eodPanel,
      topBacklogScored,
      todaysPlan: ctx.backlog.listPinnedForDate(selectedDate),
      partial: isPartial,
      selectedDate,
      isToday: selectedDate === today,
    });
    if (isPartial) { reply.type('text/html').send(body); return; }
    const title = selectedDate === today ? `Today (${today})` : selectedDate;
    reply.type('text/html').send(layout({ title, body, active: 'home', selectedDate, pinnedToday, pendingOutboundCount }));
  });

  app.get('/backlog', async (req, reply) => {
    const q = req.query as { source?: string; dev?: string; backfill?: string; mine?: string; q?: string; missing_eta?: string };
    const sourceParam = q.source && VALID_SOURCES.includes(q.source as BacklogSource) ? (q.source as BacklogSource) : undefined;
    const devOnly = q.dev === '1';
    const includeBackfill = q.backfill === '1';
    const mine = q.mine === '1';
    const missingEta = q.missing_eta === '1';
    const search = (q.q || '').trim();

    let items = ctx.backlog.listOpen({
      source: sourceParam,
      includeBackfill,
      q: search || undefined,
      mineName: mine ? MY_ASSIGNEE_NAME : undefined,
      missingEta: missingEta || undefined,
    });
    if (devOnly) items = items.filter(i => i.is_dev_task === 1);

    const linksByItemId = new Map<number, { children?: BacklogItem[]; parents?: BacklogItem[] }>();
    for (const item of items) {
      if (item.source === 'sheet' || item.source === 'wa_task') {
        const children = ctx.backlog.getChildrenOf(item.id);
        if (children.length) linksByItemId.set(item.id, { children });
      } else if (item.source === 'gitlab') {
        const parents = ctx.backlog.getParentsOf(item.id);
        if (parents.length) linksByItemId.set(item.id, { parents });
      }
    }

    const data = {
      items,
      source: (sourceParam || 'all') as BacklogSource | 'all',
      devOnly,
      includeBackfill,
      linksByItemId,
      q: search,
      mine,
      missingEta,
    };

    // Partial response for HTMX search input — only swap the results region.
    if (req.headers['hx-request'] === 'true' && req.headers['hx-target'] === 'backlog-results') {
      reply.type('text/html').send(backlogResultsPartial(data));
      return;
    }

    const body = backlogPage(data);
    reply.type('text/html').send(layout({ title: 'Backlog', body, active: 'backlog', ...railCtx() }));
  });

  app.post<{ Params: { id: string } }>('/backlog/:id/resolve', async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send('bad id');
    const item = ctx.db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id) as BacklogItem | undefined;
    if (!item) return reply.code(404).send('not found');
    ctx.backlog.markResolved(item.source, item.external_id);
    const after = ctx.db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id) as BacklogItem;
    reply.type('text/html').send(resolvedRow(after));
  });

  app.get('/messages', async (_req, reply) => {
    const rows = ctx.db.prepare(`
      SELECT id, remote_jid, participant_jid, text, ts, push_name, classified_intent
      FROM messages ORDER BY ts DESC LIMIT 100
    `).all() as MessagesPageRow[];
    const body = messagesPage({ rows });
    reply.type('text/html').send(layout({ title: 'Messages', body, active: 'messages', ...railCtx() }));
  });

  app.get('/outbound', async (_req, reply) => {
    const pending = ctx.outbound.listPending();
    const recent = ctx.outbound.listRecent(50);
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    const body = outboundPage({ pending, recent, members });
    reply.type('text/html').send(layout({ title: 'Outbound', body, active: 'outbound', ...railCtx() }));
  });

  app.post<{ Params: { id: string }; Body: { body?: string } }>('/outbound/:id/approve', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.outbound.getById(id);
    if (!row) return reply.code(404).send('not found');
    if (row.status === 'sent') return reply.code(409).send('already sent');

    const editedBody = (req.body && req.body.body) ? String(req.body.body) : row.body;
    if (editedBody !== row.body) ctx.outbound.updateBody(id, editedBody);

    if (!ctx.inboundService) {
      ctx.outbound.markError(id, 'inbound service not available (running from CLI?)');
      const after = ctx.outbound.getById(id)!;
      const members = ctx.team.exists() ? ctx.team.getMembers() : [];
      return reply.type('text/html').send(outboundCard(after, members));
    }

    const mentions = row.mentions_json ? JSON.parse(row.mentions_json) as string[] : undefined;
    try {
      await ctx.inboundService.sendMessage(row.to_jid, editedBody, mentions ? { mentions } : undefined);
      ctx.outbound.markSent(id);
      const after = ctx.outbound.getById(id)!;
      const members = ctx.team.exists() ? ctx.team.getMembers() : [];
      reply.type('text/html').send(outboundSentRow(after, members));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.outbound.markError(id, msg);
      const after = ctx.outbound.getById(id)!;
      const members = ctx.team.exists() ? ctx.team.getMembers() : [];
      reply.type('text/html').send(outboundCard(after, members));
    }
  });

  app.post<{ Params: { id: string } }>('/outbound/:id/skip', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.outbound.getById(id);
    if (!row) return reply.code(404).send('not found');
    ctx.outbound.markSkipped(id);
    const after = ctx.outbound.getById(id)!;
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    reply.type('text/html').send(outboundSkippedRow(after, members));
  });

  app.post('/outbound/approve-all', async (_req, reply) => {
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    const pending = ctx.outbound.listPending();
    const results: string[] = [];
    for (const row of pending) {
      try {
        if (!ctx.inboundService) throw new Error('inbound service not available');
        const mentions = row.mentions_json ? JSON.parse(row.mentions_json) as string[] : undefined;
        await ctx.inboundService.sendMessage(row.to_jid, row.body, mentions ? { mentions } : undefined);
        ctx.outbound.markSent(row.id);
        results.push(outboundSentRow(ctx.outbound.getById(row.id)!, members));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.outbound.markError(row.id, msg);
        results.push(outboundCard(ctx.outbound.getById(row.id)!, members));
      }
    }
    reply.type('text/html').send(results.join('\n') || '<div class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">Nothing pending. 🌿</div>');
  });

  // ----- pin / unpin -----

  app.post<{ Params: { id: string } }>('/backlog/:id/pin', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    ctx.backlog.pin(id, istDateString());
    const after = ctx.backlog.findById(id)!;
    // If called from /plan, return planRow; otherwise return backlogRow.
    if (req.headers['hx-target']?.toString().startsWith('pr-')) {
      const reasons = explainItem(after, Date.now(), MY_ASSIGNEE_NAME);
      reply.type('text/html').send(planRow({ item: after, score: 0, reasons, pinned: true }, 0));
    } else {
      reply.type('text/html').send(backlogRow(after));
    }
  });

  app.post<{ Params: { id: string } }>('/backlog/:id/unpin', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    ctx.backlog.unpin(id);
    const after = ctx.backlog.findById(id)!;
    // /plan unpin → plan row; /backlog or / unpin → backlog row (or nothing if hx-swap=delete).
    const tgt = req.headers['hx-target']?.toString() || '';
    if (tgt.startsWith('tp-')) {
      // Today's-plan widget swap=delete: empty body removes the row.
      reply.type('text/html').send('');
    } else if (tgt.startsWith('pr-')) {
      const reasons = explainItem(after, Date.now(), MY_ASSIGNEE_NAME);
      reply.type('text/html').send(planRow({ item: after, score: 0, reasons, pinned: false }, 0));
    } else {
      reply.type('text/html').send(backlogRow(after));
    }
  });

  // ----- /plan (heuristic Plan-my-Day) -----

  function buildPlanRows(): PlanRow[] {
    const today = istDateString();
    const items = ctx.backlog.listScoreable();
    const now = Date.now();
    const scored = items.map(item => {
      const { score } = scoreItem(item, now);
      const reasons = explainItem(item, now, MY_ASSIGNEE_NAME);
      const pinned = item.pinned_for_date === today;
      // Pinned items get an artificial boost so they stay near the top.
      return { item, score: pinned ? score + 100000 : score, reasons, pinned };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20);
  }

  app.get('/plan', async (_req, reply) => {
    const today = istDateString();
    const rows = buildPlanRows();
    const pinnedCount = ctx.backlog.listPinnedForDate(today).length;
    const body = planPage({ rows, date: today, pinnedCount });
    reply.type('text/html').send(layout({ title: 'Plan my Day', body, active: 'plan', ...railCtx() }));
  });

  app.post('/plan/refresh', async (_req, reply) => {
    reply.type('text/html').send(planList(buildPlanRows()));
  });

  app.post('/plan/pin-top', async (_req, reply) => {
    const today = istDateString();
    const rows = buildPlanRows();
    for (const r of rows.slice(0, 7)) {
      if (!r.pinned) ctx.backlog.pin(r.item.id, today);
    }
    reply.type('text/html').send(planList(buildPlanRows()));
  });

  // ----- /summary -----

  app.get('/summary', async (req, reply) => {
    const q = req.query as { week?: string };
    const weekStart = q.week && /^\d{4}-\d{2}-\d{2}$/.test(q.week) ? q.week : weekStartDate();
    // Compute Mon-Fri of that week deterministically (don't anchor on today).
    const weekEndProbe = new Date(weekStart + 'T12:00:00+05:30').getTime() + 5 * 86_400_000 - 1;
    const friday = istDateString(weekEndProbe);
    const workingDays = workingDaysInRange(weekStart, friday);
    const members = ctx.team.exists() ? ctx.team.getMembers().filter(m => !m.excludeFromEod) : [];

    const cellByMemberDate = new Map<string, string>();
    const dailies = ctx.summaries.listMembersForPeriod('day', weekStart);
    // dailies for any date in the week
    for (const d of workingDays) {
      const rows = ctx.summaries.listMembersForPeriod('day', d);
      for (const r of rows) cellByMemberDate.set(`${r.member_jid}|${d}`, r.summary_md);
    }
    void dailies;

    const weeklyByMember = new Map<string, string>();
    for (const m of members) {
      const wk = ctx.summaries.getMember(m.jid, 'week', weekStart);
      if (wk) weeklyByMember.set(m.jid, wk.summary_md);
    }

    const team = ctx.summaries.getTeam('week', weekStart);

    const prevWeek = istDateString(new Date(weekStart + 'T12:00:00+05:30').getTime() - 7 * 86_400_000);
    const nextWeek = istDateString(new Date(weekStart + 'T12:00:00+05:30').getTime() + 7 * 86_400_000);

    const body = summaryPage({
      weekStart, workingDays, members,
      cellByMemberDate, weeklyByMember,
      teamSummary: team?.summary_md ?? null,
      madeLive: team?.made_live_md ?? null,
      prevWeek, nextWeek,
    });
    reply.type('text/html').send(layout({ title: `Summary ${weekStart}`, body, active: 'summary', ...railCtx() }));
  });

  // ----- /evaluations -----

  function buildEvalRows(weekStart: string): EvalRow[] {
    const members = ctx.team.exists() ? ctx.team.getMembers().filter(m => !m.excludeFromEod) : [];
    const rows: EvalRow[] = [];
    for (const m of members) {
      const e = ctx.evaluations.get(weekStart, m.jid);
      const lastSaved = ctx.evaluations.getLatestSaved(m.jid, weekStart);
      const evidence = e?.evidence_json ? JSON.parse(e.evidence_json) as Record<string, unknown> : {};
      rows.push({
        member: m,
        scoreProperly: e?.score_properly ?? null,
        scoreOnTime:   e?.score_on_time ?? null,
        scoreUpdates:  e?.score_updates ?? null,
        scoreFeedback: e?.score_feedback ?? null,
        feedbackText:  e?.feedback_text ?? '',
        evidence,
        saved: !!e?.saved_at,
        lastWeekFeedback: lastSaved?.feedback_text ?? '',
      });
    }
    return rows;
  }

  app.get('/evaluations', async (req, reply) => {
    const q = req.query as { week?: string };
    const weekStart = q.week && /^\d{4}-\d{2}-\d{2}$/.test(q.week) ? q.week : weekStartDate();
    const prevWeek = istDateString(new Date(weekStart + 'T12:00:00+05:30').getTime() - 7 * 86_400_000);
    const nextWeek = istDateString(new Date(weekStart + 'T12:00:00+05:30').getTime() + 7 * 86_400_000);
    const rows = buildEvalRows(weekStart);
    const body = evaluationsPage({ weekStart, rows, prevWeek, nextWeek });
    reply.type('text/html').send(layout({ title: `Evaluations ${weekStart}`, body, active: 'evaluations', ...railCtx() }));
  });

  app.post<{ Params: { jid: string }; Body: Record<string, string> }>('/evaluations/:jid/save', async (req, reply) => {
    const memberJid = decodeURIComponent(req.params.jid);
    const b = req.body || {};
    const weekStart = String(b.week_start_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return reply.code(400).send('bad week_start_date');
    const num = (k: string, max: number) => {
      const n = Number(b[k]);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(max, Math.round(n)));
    };
    ctx.evaluations.finalize(weekStart, memberJid, {
      scoreProperly: num('score_properly', 6),
      scoreOnTime:   num('score_on_time', 6),
      scoreUpdates:  num('score_updates', 6),
      scoreFeedback: num('score_feedback', 1),
      feedbackText:  String(b.feedback_text || ''),
    });
    const rows = buildEvalRows(weekStart);
    const row = rows.find(r => r.member.jid === memberJid);
    if (!row) return reply.code(404).send('not found');
    reply.type('text/html').send(evaluationRow(weekStart, row));
  });

  app.get('/healthz', async () => ({ ok: true }));

  // Single-row HTMX refresh (in case we want it later from JS).
  app.get<{ Params: { id: string } }>('/backlog/:id/row', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id) as BacklogItem | undefined;
    if (!item) return reply.code(404).send('not found');
    reply.type('text/html').send(item.status === 'open' ? backlogRow(item) : resolvedRow(item));
  });
}

interface MessagesPageRow {
  id: string;
  remote_jid: string;
  participant_jid: string;
  text: string | null;
  ts: number;
  push_name: string | null;
  classified_intent: string | null;
}
