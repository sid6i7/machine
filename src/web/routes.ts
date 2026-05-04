import type { FastifyInstance } from 'fastify';
import type { JobContext } from '../jobs/Job.js';
import type { Scheduler } from '../scheduler/Scheduler.js';
import type { BacklogSource, BacklogItem } from '../db/repos/BacklogRepo.js';
import { istDateString, weekStartDate, workingDaysInRange, workingHoursBetween } from '../utils/time.js';
import { mdToWhatsApp, renderMarkdown } from '../utils/markdown.js';
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
  outboundCard, outboundSentRow, outboundSkippedRow,
  approvalsPage, sheetEditCard, sheetEditAppliedRow, sheetEditSkippedRow,
  reviewLaunchModal, suggestionsPage, suggestionCard,
  backlogResultsPartial,
  taskDetailPage, type TaskReviewSummary,
  summaryPage, evaluationsPage, evaluationRow,
  chatModal, chatHistoryEntry,
  adminJobsPage, jobRunResult, aboutPage,
  actionablesPanel, actionableRow,
  type AdminJobRun,
} from './views.js';
import { computePhase, seedIfEmpty, PHASES } from '../lib/phase.js';
import type { Phase, ActionableTarget } from '../db/repos/BacklogActionableRepo.js';
import { applySheetEdit, SheetEditSkipped } from '../integrations/sheets/applySheetEdit.js';
import { linkMrUrlToSheetTask } from '../lib/sheetMrLink.js';
import { startReview, cancelReview, activeReviewCount } from '../integrations/mr-review/ClaudeCodeReviewer.js';
import { applyAndPush } from '../integrations/mr-review/applyAndPush.js';
import { WorktreeManager, projectPathFromMrUrl } from '../integrations/mr-review/WorktreeManager.js';
import {
  answerItemQuestionSystem,
  answerItemQuestionSchema,
  buildAnswerItemQuestionUser,
  type AnswerItemQuestionOutput,
} from '../llm/prompts/answerItemQuestion.js';

// Default assignee substring for `mine=1` filter. Sourced from team.json's
// userJid → member name once on bootstrap; falls back to env override.
const MY_ASSIGNEE_NAME = process.env.MY_SHEET_ASSIGNEE || 'Siddhant';

const VALID_SOURCES: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];

// Local escape — views.ts owns its own escapeHtml; we don't want a circular
// import dependency for one tiny helper used in inline route handlers.
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function registerRoutes(app: FastifyInstance, ctx: JobContext, scheduler: Scheduler): void {
  // Sticky-rail context applied to every layout call. One shared helper so
  // adding a new page can't accidentally drop the pinned-rail / outbound-banner.
  const railCtx = () => ({
    pinnedToday: ctx.backlog.listPinnedForDate(istDateString()),
    pendingApprovalsCount: ctx.outbound.pendingCount() + ctx.sheetEdits.pendingCount() + ctx.mrReviews.pendingApprovalCount(),
  });

  app.get('/', async (req, reply) => {
    const today = istDateString();
    const q = req.query as { backfill?: string; date?: string };
    const selectedDate = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : today;
    const includeBackfill = q.backfill === '1';
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];

    const tasklistRows = ctx.tasklists.getForDate(selectedDate);
    const submittedJids = new Set<string>(tasklistRows.map(t => t.member_jid));
    const tasklistsByJid = new Map(tasklistRows.map(t => [t.member_jid, t]));

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
    const pendingApprovalsCount = ctx.outbound.pendingCount() + ctx.sheetEdits.pendingCount() + ctx.mrReviews.pendingApprovalCount();
    const pinnedToday = ctx.backlog.listPinnedForDate(today);

    const body = dashboard({
      date: selectedDate,
      members,
      submittedJids,
      tasklistsByJid,
      eodSession,
      eodAnswers,
      backlogBySource,
      includeBackfill,
      pendingApprovalsCount,
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
    reply.type('text/html').send(layout({ title, body, active: 'home', selectedDate, pinnedToday, pendingApprovalsCount }));
  });

  app.get('/backlog', async (req, reply) => {
    const q = req.query as { source?: string; dev?: string; backfill?: string; mine?: string; q?: string; missing_eta?: string; sort?: string; snoozed?: string };
    const sourceParam = q.source && VALID_SOURCES.includes(q.source as BacklogSource) ? (q.source as BacklogSource) : undefined;
    const devOnly = q.dev === '1';
    const includeBackfill = q.backfill === '1';
    const mine = q.mine === '1';
    const missingEta = q.missing_eta === '1';
    const search = (q.q || '').trim();
    const sort = (q.sort && ['recent','oldest','eta','priority'].includes(q.sort)) ? q.sort : undefined;
    const includeSnoozed = q.snoozed === '1';

    let items = ctx.backlog.listOpen({
      source: sourceParam,
      includeBackfill,
      q: search || undefined,
      mineName: mine ? MY_ASSIGNEE_NAME : undefined,
      missingEta: missingEta || undefined,
      includeSnoozed,
      sort,
    } as Parameters<typeof ctx.backlog.listOpen>[0]);
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
      sort,
      showSnoozed: includeSnoozed,
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
    ctx.backlogEvents.insert(id, 'resolved', 'Marked resolved');
    const after = ctx.db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(id) as BacklogItem;
    reply.type('text/html').send(resolvedRow(after));
  });

  app.get('/messages', async (req, reply) => {
    const q = req.query as { intent?: string; linked?: string; q?: string };
    const intent = q.intent && ['task','task_update','connect','status_check','noise'].includes(q.intent) ? q.intent : undefined;
    const linkedOnly = q.linked === '1';
    const search = (q.q || '').trim();

    const conds: string[] = [];
    const params: unknown[] = [];
    if (intent) { conds.push('m.classified_intent = ?'); params.push(intent); }
    if (linkedOnly) conds.push('b.id IS NOT NULL');
    if (search) {
      conds.push('LOWER(m.text) LIKE ?');
      params.push(`%${search.toLowerCase()}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = ctx.db.prepare(`
      SELECT m.id, m.remote_jid, m.participant_jid, m.text, m.ts, m.push_name, m.classified_intent,
             b.id AS linked_backlog_id, b.title AS linked_backlog_title, b.source AS linked_backlog_source
      FROM messages m
      LEFT JOIN backlog_items b ON b.origin_msg_id = m.id
      ${where}
      ORDER BY m.ts DESC LIMIT 200
    `).all(...params) as MessagesPageRow[];

    const body = messagesPage({ rows, intent, linkedOnly, q: search });
    if (req.headers['hx-request'] === 'true') {
      reply.type('text/html').send(body);
      return;
    }
    reply.type('text/html').send(layout({ title: 'Messages', body, active: 'messages', ...railCtx() }));
  });

  app.get('/approvals', async (req, reply) => {
    const q = req.query as { kind?: string };
    const filter: 'all' | 'outbound' | 'sheet' | 'review' =
      q.kind === 'outbound' ? 'outbound' :
      q.kind === 'sheet'    ? 'sheet'    :
      q.kind === 'review'   ? 'review'   : 'all';
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    const finishedReviews = ctx.mrReviews.list({ status: 'finished', limit: 50 });
    const pendingReviews = finishedReviews.map(r => {
      const sugs = ctx.mrReviews.listSuggestions(r.id);
      const sevCounts: Record<string, number> = {};
      for (const s of sugs) sevCounts[s.severity] = (sevCounts[s.severity] || 0) + 1;
      return { review: r, suggestionCount: sugs.length, severityCounts: sevCounts };
    });
    const body = approvalsPage({
      pendingOutbound:   ctx.outbound.listPending(),
      pendingSheetEdits: ctx.sheetEdits.listPending(),
      pendingReviews,
      recentOutbound:    ctx.outbound.listRecent(50),
      recentSheetEdits:  ctx.sheetEdits.listRecent(50),
      recentReviews:     ctx.mrReviews.list({ limit: 50 }),
      members,
      filter,
    });
    reply.type('text/html').send(layout({ title: 'Approvals', body, active: 'approvals', ...railCtx() }));
  });

  // Back-compat: old /outbound URL → unified /approvals filtered to WA messages.
  app.get('/outbound', async (_req, reply) => reply.redirect('/approvals?kind=outbound', 302));

  // ----- /sheet-edits/:id/* -----

  app.post<{ Params: { id: string }; Body: { append_text?: string } }>('/sheet-edits/:id/approve', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.sheetEdits.getById(id);
    if (!row) return reply.code(404).send('not found');
    if (row.status === 'applied') return reply.code(409).send('already applied');

    const editedText = (req.body && req.body.append_text) ? String(req.body.append_text) : row.append_text;
    if (editedText !== row.append_text) ctx.sheetEdits.updateAppendText(id, editedText);

    try {
      const fresh = ctx.sheetEdits.getById(id)!;
      await applySheetEdit(fresh);
      ctx.sheetEdits.markApplied(id);
      const after = ctx.sheetEdits.getById(id)!;
      reply.type('text/html').send(sheetEditAppliedRow(after));
    } catch (err) {
      if (err instanceof SheetEditSkipped) {
        ctx.sheetEdits.markSkipped(id);
        const after = ctx.sheetEdits.getById(id)!;
        return reply.type('text/html').send(sheetEditSkippedRow(after, err.message));
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.sheetEdits.markError(id, msg);
      const after = ctx.sheetEdits.getById(id)!;
      reply.type('text/html').send(sheetEditCard(after));
    }
  });

  app.post<{ Params: { id: string } }>('/sheet-edits/:id/skip', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.sheetEdits.getById(id);
    if (!row) return reply.code(404).send('not found');
    ctx.sheetEdits.markSkipped(id);
    const after = ctx.sheetEdits.getById(id)!;
    reply.type('text/html').send(sheetEditSkippedRow(after));
  });

  // ----- /mr-reviews — Claude Code MR review -----

  const DEFAULT_MODEL = process.env.MR_REVIEW_DEFAULT_MODEL || 'claude-sonnet-4-6';
  const DEFAULT_LEVEL = process.env.MR_REVIEW_DEFAULT_LEVEL || 'critical_only';
  const MAX_CONCURRENT = Number(process.env.MR_REVIEW_MAX_CONCURRENT || '3');

  app.get<{ Querystring: { backlog_id?: string } }>('/mr-reviews/new', async (req, reply) => {
    const id = Number(req.query.backlog_id);
    const item = id ? ctx.backlog.findById(id) : undefined;
    if (!item || item.source !== 'gitlab') return reply.code(404).send('not a gitlab MR');
    const html = reviewLaunchModal({
      backlogItem: item,
      defaultModel: DEFAULT_MODEL,
      defaultLevel: DEFAULT_LEVEL,
      activeReviewCount: activeReviewCount(),
      maxConcurrent: MAX_CONCURRENT,
    });
    reply.type('text/html').send(html);
  });

  app.post<{ Body: { backlog_id?: string; model?: string; level?: string } }>('/mr-reviews', async (req, reply) => {
    const id = Number(req.body?.backlog_id);
    const item = id ? ctx.backlog.findById(id) : undefined;
    if (!item || item.source !== 'gitlab' || !item.url) return reply.code(400).send('bad backlog_id');
    const meta = item.metadata_json ? JSON.parse(item.metadata_json) as Record<string, unknown> : {};
    const sourceBranch = String(meta.source_branch || '');
    if (!sourceBranch) return reply.code(400).send('MR has no source_branch in metadata');
    // target_branch lives in the title prefix "[<target>] …" — extract it.
    const tm = item.title.match(/^\[([^\]]+)\]/);
    const targetBranch = tm ? tm[1] : 'staging';
    const projectPath = projectPathFromMrUrl(item.url);
    if (!projectPath) return reply.code(400).send('cannot derive project path from MR url');

    const model = req.body?.model || DEFAULT_MODEL;
    const level = req.body?.level || DEFAULT_LEVEL;

    const review = ctx.mrReviews.create({
      mrBacklogId: item.id,
      mrExternalId: item.external_id,
      mrUrl: item.url,
      mrTitle: item.title,
      sourceBranch,
      targetBranch,
      projectPath,
      model,
      level,
    });

    try {
      await startReview({ logger: ctx.logger, reviews: ctx.mrReviews }, review.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.mrReviews.setStatus(review.id, 'failed', { error: msg });
      ctx.logger.error({ err, reviewId: review.id }, 'startReview failed');
    }
    reply.redirect(`/mr-reviews/${review.id}`, 302);
  });

  app.get<{ Params: { id: string }; Querystring: { _partial?: string } }>('/mr-reviews/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const review = ctx.mrReviews.getById(id);
    if (!review) return reply.code(404).send('not found');
    const suggestions = ctx.mrReviews.listSuggestions(id);
    const body = suggestionsPage({ review, suggestions });
    if (req.query._partial === '1') {
      // For htmx polling: return full body, swap into <body>. Keeps layout chrome stable across polls.
      return reply.type('text/html').send(layout({ title: `Review #${id}`, body, active: 'approvals', ...railCtx() }));
    }
    reply.type('text/html').send(layout({ title: `Review #${id}`, body, active: 'approvals', ...railCtx() }));
  });

  app.post<{ Params: { id: string } }>('/mr-reviews/:id/cancel', async (req, reply) => {
    const id = Number(req.params.id);
    const review = ctx.mrReviews.getById(id);
    if (!review) return reply.code(404).send('not found');
    cancelReview(id);
    ctx.mrReviews.setStatus(id, 'cancelled');
    return reply.redirect(`/mr-reviews/${id}`, 302);
  });

  app.post<{ Params: { id: string } }>('/mr-reviews/:id/discard', async (req, reply) => {
    const id = Number(req.params.id);
    const review = ctx.mrReviews.getById(id);
    if (!review) return reply.code(404).send('not found');
    if (review.worktree_path) {
      try {
        const projectId = Number(review.mr_external_id.split(':')[0]);
        await new WorktreeManager().removeWorktree(projectId, review.worktree_path);
      } catch (err) { ctx.logger.warn({ err, reviewId: id }, 'worktree cleanup failed'); }
    }
    ctx.mrReviews.setStatus(id, 'discarded');
    return reply.redirect('/approvals?kind=review', 302);
  });

  app.post<{ Params: { id: string } }>('/mr-reviews/:id/submit', async (req, reply) => {
    const id = Number(req.params.id);
    const review = ctx.mrReviews.getById(id);
    if (!review) return reply.code(404).send('not found');
    if (review.status !== 'finished') return reply.code(409).send(`review status is ${review.status}, not finished`);
    ctx.mrReviews.setStatus(id, 'submitting');
    try {
      const fresh = ctx.mrReviews.getById(id)!;
      const result = await applyAndPush(ctx.mrReviews, fresh);
      if (result.applied === 0) {
        ctx.mrReviews.setStatus(id, 'failed', { error: 'no suggestions applied (all rejected or apply_failed)' });
      } else {
        ctx.mrReviews.setStatus(id, 'submitted', { push_commit_sha: result.pushCommitSha });
        // Cleanup worktree post-push.
        if (review.worktree_path) {
          try {
            const projectId = Number(review.mr_external_id.split(':')[0]);
            await new WorktreeManager().removeWorktree(projectId, review.worktree_path);
          } catch (err) { ctx.logger.warn({ err, reviewId: id }, 'post-push worktree cleanup failed'); }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ err, reviewId: id }, 'applyAndPush failed');
      ctx.mrReviews.setStatus(id, 'failed', { error: msg });
    }
    return reply.redirect(`/mr-reviews/${id}`, 302);
  });

  app.post<{ Params: { sid: string } }>('/mr-reviews/sugs/:sid/accept', async (req, reply) => {
    const sid = Number(req.params.sid);
    const sug = ctx.mrReviews.getSuggestionById(sid);
    if (!sug) return reply.code(404).send('not found');
    ctx.mrReviews.setSuggestionStatus(sid, 'accepted');
    reply.type('text/html').send(suggestionCard(ctx.mrReviews.getSuggestionById(sid)!));
  });

  app.post<{ Params: { sid: string } }>('/mr-reviews/sugs/:sid/reject', async (req, reply) => {
    const sid = Number(req.params.sid);
    const sug = ctx.mrReviews.getSuggestionById(sid);
    if (!sug) return reply.code(404).send('not found');
    ctx.mrReviews.setSuggestionStatus(sid, 'rejected');
    reply.type('text/html').send(suggestionCard(ctx.mrReviews.getSuggestionById(sid)!));
  });

  app.post<{ Params: { sid: string } }>('/mr-reviews/sugs/:sid/reset', async (req, reply) => {
    const sid = Number(req.params.sid);
    const sug = ctx.mrReviews.getSuggestionById(sid);
    if (!sug) return reply.code(404).send('not found');
    if (sug.status === 'applied' || sug.status === 'apply_failed') return reply.code(409).send('cannot reset applied/failed suggestions');
    ctx.db.prepare(`UPDATE mr_review_suggestions SET status = 'pending', decided_at = NULL, apply_error = NULL WHERE id = ?`).run(sid);
    reply.type('text/html').send(suggestionCard(ctx.mrReviews.getSuggestionById(sid)!));
  });

  app.post<{ Params: { id: string }; Body: { body?: string; body_tail?: string; selected_jids?: string | string[] } }>('/outbound/:id/approve', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.outbound.getById(id);
    if (!row) return reply.code(404).send('not found');
    if (row.status === 'sent') return reply.code(409).send('already sent');

    let editedBody = (req.body && req.body.body) ? String(req.body.body) : row.body;
    let editedMentions: string[] | undefined = row.mentions_json ? JSON.parse(row.mentions_json) as string[] : undefined;

    // Special handling for tasklist_nudge: rebuild tag line + mentions from
    // checkbox selection, append the freeform body_tail.
    if (row.kind === 'tasklist_nudge' && req.body && (req.body.body_tail !== undefined || req.body.selected_jids !== undefined)) {
      const raw = req.body.selected_jids;
      const selected = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      if (selected.length === 0) {
        return reply.code(400).type('text/plain').send('Select at least one person to tag.');
      }
      const tail = String(req.body.body_tail ?? '').trim();
      const tags = selected.map(jid => `@${String(jid).split('@')[0]}`).join(' ');
      editedBody = tail ? `${tags}\n\n${tail}` : tags;
      editedMentions = selected;
      ctx.outbound.updateBodyAndMentions(id, editedBody, editedMentions);
    } else if (editedBody !== row.body) {
      ctx.outbound.updateBody(id, editedBody);
    }

    if (!ctx.inboundService) {
      ctx.outbound.markError(id, 'inbound service not available (running from CLI?)');
      const after = ctx.outbound.getById(id)!;
      const members = ctx.team.exists() ? ctx.team.getMembers() : [];
      return reply.type('text/html').send(outboundCard(after, members));
    }

    try {
      await ctx.inboundService.sendMessage(row.to_jid, mdToWhatsApp(editedBody), editedMentions && editedMentions.length ? { mentions: editedMentions } : undefined);
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

  app.post<{ Params: { id: string } }>('/outbound/:id/resend', async (req, reply) => {
    const id = Number(req.params.id);
    const row = ctx.outbound.getById(id);
    if (!row) return reply.code(404).send('not found');
    const mentions = row.mentions_json ? JSON.parse(row.mentions_json) as string[] : undefined;
    const context = row.context_json ? JSON.parse(row.context_json) as Record<string, unknown> : undefined;
    if (context) delete (context as Record<string, unknown>).dedupKey;
    const cloned = ctx.outbound.enqueue({
      toJid: row.to_jid,
      body: row.body,
      kind: row.kind,
      mentions,
      context,
    });
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    reply.type('text/html').send(outboundCard(cloned, members));
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
        await ctx.inboundService.sendMessage(row.to_jid, mdToWhatsApp(row.body), mentions ? { mentions } : undefined);
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

  // Inline fragment for the task detail page's pin/unpin status block. Keeps
  // pin/unpin handlers self-contained — no need to import view helpers here.
  function taskStatusFragment(item: BacklogItem, isPinnedToday: boolean): string {
    const btn = isPinnedToday
      ? `<button hx-post="/backlog/${item.id}/unpin" hx-target="#task-status-${item.id}" hx-swap="outerHTML"
                class="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200">📌 Unpin from today</button>`
      : `<button hx-post="/backlog/${item.id}/pin" hx-target="#task-status-${item.id}" hx-swap="outerHTML"
                class="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">📌 Pin to today</button>`;
    const sourceLink = item.url
      ? `<a href="${esc(item.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">source ↗</a>`
      : '';
    return `<div id="task-status-${item.id}" class="flex flex-col items-end gap-2 shrink-0">${btn}${sourceLink}</div>`;
  }

  app.post<{ Params: { id: string } }>('/backlog/:id/pin', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    ctx.backlog.pin(id, istDateString());
    ctx.backlogEvents.insert(id, 'pinned', `Pinned to ${istDateString()}`);
    const after = ctx.backlog.findById(id)!;
    const tgt = req.headers['hx-target']?.toString() || '';
    if (tgt.startsWith('task-status-')) {
      reply.type('text/html').send(taskStatusFragment(after, true));
    } else {
      reply.type('text/html').send(backlogRow(after));
    }
  });

  app.post<{ Params: { id: string } }>('/backlog/:id/unpin', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    ctx.backlog.unpin(id);
    ctx.backlogEvents.insert(id, 'unpinned', 'Unpinned');
    const after = ctx.backlog.findById(id)!;
    const tgt = req.headers['hx-target']?.toString() || '';
    if (tgt.startsWith('tp-')) {
      // Today's-plan widget swap=delete: empty body removes the row.
      reply.type('text/html').send('');
    } else if (tgt.startsWith('task-status-')) {
      reply.type('text/html').send(taskStatusFragment(after, false));
    } else {
      reply.type('text/html').send(backlogRow(after));
    }
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

  // ----- Notes / snooze / link / timeline -----

  app.post<{ Params: { id: string }; Body: { note?: string } }>('/backlog/:id/note', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const prev = item.pm_note || '';
    const next = String(req.body?.note || '').trim();
    ctx.backlog.setNote(id, next || null);
    if (prev !== next) {
      ctx.backlogEvents.insert(id, 'note_saved', next ? `PM note updated` : `PM note cleared`);
    }
    const after = ctx.backlog.findById(id)!;
    const tgt = req.headers['hx-target']?.toString() || '';
    if (tgt.startsWith('task-note-')) {
      // Re-render the inline note form on /task/:id with the freshly saved value.
      reply.type('text/html').send(`
        <form hx-post="/backlog/${after.id}/note" hx-target="#task-note-${after.id}" hx-swap="outerHTML"
              id="task-note-${after.id}" class="mt-3 flex gap-2 items-start">
          <textarea name="note" rows="2" placeholder="PM note (free text)…"
                    class="flex-1 text-xs border rounded px-2 py-1 outline-none focus:border-slate-400">${esc(after.pm_note || '')}</textarea>
          <button type="submit" class="text-xs px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">Save note</button>
        </form>`);
    } else {
      reply.type('text/html').send(backlogRow(after));
    }
  });

  app.post<{ Params: { id: string }; Body: { expected_outcome?: string; proof_url?: string } }>('/backlog/:id/goal-proof', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const goal = String(req.body?.expected_outcome || '').trim();
    const proof = String(req.body?.proof_url || '').trim();
    const prevGoal = item.expected_outcome || '';
    const prevProof = item.proof_url || '';
    ctx.backlog.setExpectedOutcome(id, goal || null);
    ctx.backlog.setProofUrl(id, proof || null);
    if (goal !== prevGoal) {
      ctx.backlogEvents.insert(id, 'goal_set', goal ? 'End-goal updated' : 'End-goal cleared');
    }
    if (proof !== prevProof) {
      ctx.backlogEvents.insert(id, 'proof_set', proof ? `Proof URL → ${proof}` : 'Proof URL cleared', { proof_url: proof || null });
    }
    const after = ctx.backlog.findById(id)!;
    // Re-render the goal/proof section via the same fragment used in taskDetailPage.
    reply.type('text/html').send(`
      <section class="bg-white border rounded-lg p-4 mb-4" id="goal-proof-${after.id}">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🎯 Goal &amp; proof</h2>
        <form hx-post="/backlog/${after.id}/goal-proof" hx-target="#goal-proof-${after.id}" hx-swap="outerHTML"
              class="grid grid-cols-1 sm:grid-cols-[1fr_18rem] gap-3 items-start">
          <div>
            <label class="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">End-goal expectation</label>
            <textarea name="expected_outcome" rows="3"
                      placeholder="What does &quot;done&quot; look like? Markdown ok."
                      class="w-full text-xs border rounded px-2 py-1 outline-none focus:border-slate-400 font-mono">${esc(after.expected_outcome || '')}</textarea>
            ${after.expected_outcome ? `<div class="mt-2 text-xs text-slate-700 prose-sm">${renderMarkdown(after.expected_outcome)}</div>` : ''}
          </div>
          <div>
            <label class="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Verifiable proof (URL)</label>
            <input type="url" name="proof_url" value="${esc(after.proof_url || '')}"
                   placeholder="https://… (demo video, screenshot, doc)"
                   class="w-full text-xs border rounded px-2 py-1 outline-none focus:border-slate-400 font-mono">
            ${after.proof_url ? `<a href="${esc(after.proof_url)}" target="_blank" class="mt-1 inline-block text-xs text-blue-600 hover:underline truncate max-w-full">↗ ${esc(after.proof_url)}</a>` : ''}
            <button type="submit" class="mt-2 text-xs px-3 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">Save</button>
          </div>
        </form>
      </section>`);
  });

  app.post<{ Params: { id: string }; Querystring: { hours?: string } }>('/backlog/:id/snooze', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const hours = Number(req.query.hours || '24');
    ctx.backlog.snooze(id, hours);
    ctx.backlogEvents.insert(id, 'snoozed', hours > 0 ? `Snoozed for ${hours}h` : 'Snooze cleared', { hours });
    const after = ctx.backlog.findById(id)!;
    reply.type('text/html').send(backlogRow(after));
  });

  // Manual-link modal: search for a candidate parent / child
  app.get<{ Params: { id: string } }>('/backlog/:id/link-modal', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    reply.type('text/html').send(`
      <div id="link-modal" class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
           onclick="if (event.target === this) document.getElementById('chat-modal-mount').innerHTML=''">
        <div class="bg-white border rounded-lg shadow-2xl w-full max-w-2xl">
          <div class="px-4 py-3 border-b flex items-center justify-between">
            <div class="text-sm font-semibold">Link "${esc(item.title.slice(0, 80))}" to…</div>
            <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
          </div>
          <input type="text" name="q" placeholder="Search any other backlog item…" autofocus autocomplete="off"
                 hx-get="/backlog/${id}/link-search" hx-trigger="input changed delay:200ms"
                 hx-target="#link-results" hx-swap="innerHTML"
                 class="w-full px-4 py-2 text-sm border-b outline-none focus:border-slate-400">
          <div id="link-results" class="max-h-80 overflow-y-auto p-1"><div class="px-3 py-2 text-xs text-slate-400 italic">Type to search…</div></div>
        </div>
      </div>`);
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/backlog/:id/link-search', async (req, reply) => {
    const id = Number(req.params.id);
    const q = String(req.query.q || '').trim();
    if (!q) { reply.type('text/html').send('<div class="px-3 py-2 text-xs text-slate-400 italic">Type to search…</div>'); return; }
    const items = ctx.backlog.listOpen({ q }).filter(it => it.id !== id).slice(0, 25);
    if (items.length === 0) { reply.type('text/html').send('<div class="px-3 py-2 text-xs text-slate-400 italic">No matches.</div>'); return; }
    const safe = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const html = items.map(it => `
      <button hx-post="/backlog/${id}/link?other=${it.id}" hx-target="#link-modal" hx-swap="outerHTML"
              class="w-full text-left flex items-center gap-2 px-3 py-2 rounded hover:bg-slate-100 text-sm text-slate-700">
        <span class="text-[10px] text-slate-400 uppercase shrink-0 w-12">${safe(it.source.replace('wa_',''))}</span>
        <span class="flex-1 truncate">${safe(it.title)}</span>
      </button>`).join('');
    reply.type('text/html').send(html);
  });

  app.post<{ Params: { id: string }; Querystring: { other?: string } }>('/backlog/:id/link', async (req, reply) => {
    const id = Number(req.params.id);
    const otherId = Number(req.query.other);
    const a = ctx.backlog.findById(id);
    const b = ctx.backlog.findById(otherId);
    if (!a || !b) return reply.code(404).send('one of the items not found');
    // Pick parent vs child based on source: sheet/wa_task → parent, gitlab/wa_task_update/wa_status_check → child
    const parentSources = new Set(['sheet', 'wa_task']);
    const aIsParent = parentSources.has(a.source);
    const bIsParent = parentSources.has(b.source);
    let parent = a, child = b;
    if (!aIsParent && bIsParent) { parent = b; child = a; }
    ctx.backlog.addLink(parent.id, child.id, 'manual', 'manual', 1.0);
    const linkText = `Linked → ${child.title.slice(0, 100)}`;
    const reverseText = `Linked ← ${parent.title.slice(0, 100)}`;
    ctx.backlogEvents.insert(parent.id, 'link_added', linkText, { other_id: child.id, role: 'parent' });
    ctx.backlogEvents.insert(child.id, 'link_added', reverseText, { other_id: parent.id, role: 'child' });
    reply.type('text/html').send(`
      <div class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-24"
           onclick="document.getElementById('chat-modal-mount').innerHTML=''">
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg shadow-2xl px-6 py-4 text-sm text-emerald-800">
          ✓ Linked. <span class="text-xs text-emerald-600">(click to close)</span>
        </div>
      </div>`);
  });

  // Manual MR-link modal: paste an MR URL to link it to this sheet task.
  // Mirrors the sheet_mr flow done by SyncGitlabMrsJob's LLM matcher.
  app.get<{ Params: { id: string } }>('/backlog/:id/link-mr-modal', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    if (item.source !== 'sheet') return reply.code(400).send('only sheet tasks can have MRs linked manually');
    reply.type('text/html').send(`
      <div id="link-mr-modal" class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
           onclick="if (event.target === this) document.getElementById('chat-modal-mount').innerHTML=''">
        <div class="bg-white border rounded-lg shadow-2xl w-full max-w-xl">
          <div class="px-4 py-3 border-b flex items-center justify-between">
            <div class="text-sm font-semibold">Link MR to "${esc(item.title.slice(0, 80))}"</div>
            <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
          </div>
          <form hx-post="/backlog/${id}/link-mr" hx-target="#link-mr-result" hx-swap="innerHTML"
                class="px-4 py-3 space-y-2">
            <label class="block text-xs text-slate-500">GitLab MR URL</label>
            <input type="url" name="mr_url" required autofocus autocomplete="off"
                   placeholder="https://gitlab.com/group/repo/-/merge_requests/123"
                   class="w-full px-3 py-2 text-sm border rounded outline-none focus:border-slate-400 font-mono">
            <div class="flex items-center justify-end gap-2 pt-1">
              <button type="button" onclick="document.getElementById('chat-modal-mount').innerHTML=''"
                      class="text-xs px-3 py-1.5 rounded text-slate-600 hover:bg-slate-100">Cancel</button>
              <button type="submit" class="text-xs px-3 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-900">Link &amp; queue sheet edit</button>
            </div>
            <div id="link-mr-result" class="text-xs"></div>
          </form>
        </div>
      </div>`);
  });

  app.post<{ Params: { id: string }; Body: { mr_url?: string } }>('/backlog/:id/link-mr', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const mrUrl = String(req.body?.mr_url || '').trim();
    if (!mrUrl) {
      return reply.type('text/html').send(`<div class="text-red-700">Paste an MR URL.</div>`);
    }
    const r = await linkMrUrlToSheetTask(ctx, item, mrUrl);
    if (!r.ok) {
      return reply.type('text/html').send(`<div class="text-red-700">✗ ${esc(r.error)}</div>`);
    }
    if (!r.alreadyLinked) {
      ctx.backlogEvents.insert(id, 'mr_linked', `MR linked: ${mrUrl}`, { mr_url: mrUrl });
    }
    const linkMsg = r.alreadyLinked ? 'Already linked' : 'Linked';
    let sheetMsg: string;
    switch (r.sheetEdit.status) {
      case 'enqueued':
        sheetMsg = 'sheet edit queued for approval';
        break;
      case 'deduped':
        sheetMsg = 'sheet edit already pending for this MR';
        break;
      case 'skipped_already_in_cell':
        sheetMsg = 'MR URL already in the sheet row — nothing to append';
        break;
      case 'skipped_bad_external_id':
        sheetMsg = 'could not derive sheet row index — sheet edit skipped';
        break;
    }
    return reply.type('text/html').send(
      `<div class="text-emerald-700">✓ ${linkMsg}. ${esc(sheetMsg)}.</div>`
    );
  });

  // Per-item timeline drawer — shows linked discussions + MRs + chat history chronologically.
  app.get<{ Params: { id: string } }>('/backlog/:id/timeline', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');

    const children = ctx.backlog.getChildrenOf(id);
    const parents = ctx.backlog.getParentsOf(id);
    const linkedByMeta = ctx.db.prepare(`
      SELECT id, source, title, created_at, metadata_json FROM backlog_items
      WHERE source IN ('wa_task_update','wa_status_check')
        AND json_extract(metadata_json, '$.linked_backlog_id') = ?
    `).all(id) as Array<{ id: number; source: string; title: string; created_at: number; metadata_json: string | null }>;
    const chats = ctx.itemChat.listForItem(id);
    const logged = ctx.backlogEvents.listForBacklog(id);

    type Event = { ts: number; kind: string; text: string; sub?: string; url?: string };
    const events: Event[] = [];
    events.push({ ts: item.created_at, kind: 'created', text: `Item created (${item.source})` });
    for (const c of children) {
      const m = c.metadata_json ? JSON.parse(c.metadata_json) as Record<string, unknown> : {};
      events.push({ ts: c.created_at, kind: c.source, text: c.title, sub: m.author ? String(m.author) : (m.sender ? String(m.sender) : undefined), url: c.url ?? undefined });
    }
    for (const p of parents) {
      events.push({ ts: p.created_at, kind: `parent:${p.source}`, text: p.title, url: p.url ?? undefined });
    }
    for (const r of linkedByMeta) {
      const m = r.metadata_json ? JSON.parse(r.metadata_json) as Record<string, unknown> : {};
      events.push({ ts: r.created_at, kind: r.source, text: r.title, sub: m.sender ? String(m.sender) : undefined });
    }
    for (const c of chats) {
      events.push({ ts: c.created_at, kind: 'chat', text: `Q: ${c.question}`, sub: c.answer.slice(0, 200) });
    }
    // Action log: snooze, pin, link, actionable add/remove/toggle, note, goal/proof, etc.
    for (const e of logged) {
      const meta = e.metadata_json ? JSON.parse(e.metadata_json) as Record<string, unknown> : {};
      const url = typeof meta.mr_url === 'string' ? meta.mr_url
                : typeof meta.proof_url === 'string' ? meta.proof_url
                : undefined;
      events.push({ ts: e.created_at, kind: e.kind, text: e.text, url });
    }
    events.sort((a, b) => a.ts - b.ts);

    const safe = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const rows = events.map(e => `
      <div class="flex gap-3 py-2">
        <div class="text-[10px] text-slate-400 w-32 shrink-0 font-mono">${new Date(e.ts).toLocaleString()}</div>
        <div class="flex-1 min-w-0">
          <div class="text-xs"><span class="text-slate-500">${safe(e.kind)}</span> · ${safe(e.text)}</div>
          ${e.sub ? `<div class="text-[10px] text-slate-500 mt-0.5 line-clamp-2">${safe(e.sub)}</div>` : ''}
          ${e.url ? `<a href="${safe(e.url)}" target="_blank" class="text-[10px] text-blue-600 hover:underline">open ↗</a>` : ''}
        </div>
      </div>`).join('');

    reply.type('text/html').send(`
      <div id="timeline-modal" class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
           onclick="if (event.target === this) document.getElementById('chat-modal-mount').innerHTML=''">
        <div class="bg-white border rounded-lg shadow-2xl w-full max-w-3xl flex flex-col max-h-[80vh]">
          <div class="px-4 py-3 border-b flex items-center justify-between">
            <div class="text-sm font-semibold truncate">📜 Timeline · ${esc(item.title.slice(0, 80))}</div>
            <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
          </div>
          <div class="flex-1 overflow-y-auto px-4 py-2 divide-y divide-slate-100">${rows || '<div class="py-6 text-center text-sm text-slate-400">No linked events yet.</div>'}</div>
          <div class="px-4 py-2 border-t text-[10px] text-slate-400 flex justify-between">
            <span>${events.length} event${events.length === 1 ? '' : 's'}</span>
            <span>linked: ${children.length} child · ${parents.length} parent · ${linkedByMeta.length} discussion · ${chats.length} chat</span>
          </div>
        </div>
      </div>`);
  });

  // ----- SDLC phase + per-task actionables -----

  // Build LinkedMrSummary[] for an item's children. Sheet/wa_task items get
  // their MR children's branch + open/merged-to-prod state. gitlab items get
  // an empty list (their phase derives from their own title prefix).
  function summarizeMrChildren(itemId: number): Array<{ target_branch: string | null; is_open: boolean; is_merged_to_prod: boolean }> {
    const children = ctx.backlog.getChildrenOf(itemId).filter(c => c.source === 'gitlab');
    return children.map(c => {
      const tm = c.title.match(/^\[([^\]]+)\]/);
      const target = tm ? tm[1] : null;
      const merged = ctx.db.prepare(
        `SELECT target_branch FROM gitlab_merged_log WHERE external_id = ?`
      ).get(c.external_id) as { target_branch: string } | undefined;
      return {
        target_branch: target,
        is_open: c.status === 'open',
        is_merged_to_prod: merged?.target_branch === 'prod',
      };
    });
  }

  function computePhaseForItem(itemId: number): Phase {
    const item = ctx.backlog.findById(itemId)!;
    return computePhase({ item, linkedMrs: summarizeMrChildren(itemId) });
  }

  function renderActionablesPanel(itemId: number): string {
    const item = ctx.backlog.findById(itemId)!;
    const phase = computePhaseForItem(itemId);
    seedIfEmpty(ctx.actionables, itemId, item.source, phase);
    const actionables = ctx.actionables.listForBacklog(itemId);
    const outboundIds = actionables.map(a => a.pending_outbound_id).filter((x): x is number => x != null);
    const outboundStatusById: Record<number, string> = {};
    for (const oid of outboundIds) {
      const ob = ctx.outbound.getById(oid);
      if (ob) outboundStatusById[oid] = ob.status;
    }
    return actionablesPanel({
      itemId,
      source: item.source,
      currentPhase: phase,
      actionables,
      outboundStatusById,
    });
  }

  app.get<{ Params: { id: string } }>('/backlog/:id/actionables-panel', async (req, reply) => {
    const id = Number(req.params.id);
    if (!ctx.backlog.findById(id)) return reply.code(404).send('not found');
    reply.type('text/html').send(renderActionablesPanel(id));
  });

  // ----- /task/:id detail page -----
  app.get<{ Params: { id: string } }>('/task/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).type('text/plain').send('not found');

    const children = ctx.backlog.getChildrenOf(id);
    const parents  = ctx.backlog.getParentsOf(id);

    // Code reviews live against the gitlab MR backlog id. For sheet/wa_task
    // items, walk to any linked MR children to surface their reviews here too.
    const reviewBacklogIds = item.source === 'gitlab'
      ? [id]
      : children.filter(c => c.source === 'gitlab').map(c => c.id);
    const reviews: TaskReviewSummary[] = [];
    for (const bid of reviewBacklogIds) {
      const titleFor = bid === id ? item.title : (children.find(c => c.id === bid)?.title || `MR #${bid}`);
      for (const r of ctx.mrReviews.listByMrBacklogId(bid)) {
        reviews.push({ id: r.id, status: r.status, mrTitle: titleFor, mrBacklogId: bid });
      }
    }

    const body = taskDetailPage({
      item,
      links: { children, parents },
      actionablesPanelHtml: renderActionablesPanel(id),
      reviews,
    });
    reply.type('text/html').send(layout({
      title: item.title.slice(0, 60),
      body,
      active: 'home',
      ...railCtx(),
    }));
  });

  app.post<{ Params: { id: string }; Body: { text?: string; phase?: string; target?: string } }>('/backlog/:id/actionable', async (req, reply) => {
    const id = Number(req.params.id);
    if (!ctx.backlog.findById(id)) return reply.code(404).send('not found');
    const text = String(req.body?.text || '').trim();
    if (!text) return reply.code(400).send('empty text');
    const phase = (req.body?.phase && PHASES.includes(req.body.phase as Phase) ? req.body.phase : computePhaseForItem(id)) as Phase;
    const target = (['self', 'owner', 'mr_author'].includes(String(req.body?.target)) ? req.body!.target : 'self') as ActionableTarget;
    ctx.actionables.insert({ backlogId: id, phase, text, target });
    ctx.backlogEvents.insert(id, 'actionable_added', `Added checklist item: ${text.slice(0, 120)}`, { phase, target });
    reply.type('text/html').send(renderActionablesPanel(id));
  });

  app.post<{ Params: { id: string; aid: string } }>('/backlog/:id/actionable/:aid/toggle', async (req, reply) => {
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    const a = ctx.actionables.getById(aid);
    if (!a || a.backlog_id !== id) return reply.code(404).send('not found');
    const newDone = !a.is_done;
    ctx.actionables.setDone(aid, newDone);
    ctx.backlogEvents.insert(id, newDone ? 'actionable_done' : 'actionable_undone',
      `${newDone ? '✓' : '↺'} ${a.text.slice(0, 120)}`);
    const fresh = ctx.actionables.getById(aid)!;
    const ob = fresh.pending_outbound_id ? ctx.outbound.getById(fresh.pending_outbound_id) : null;
    reply.type('text/html').send(actionableRow(fresh, ob?.status));
  });

  app.delete<{ Params: { id: string; aid: string } }>('/backlog/:id/actionable/:aid', async (req, reply) => {
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    const a = ctx.actionables.getById(aid);
    if (!a || a.backlog_id !== id) return reply.code(404).send('not found');
    ctx.actionables.delete(aid);
    ctx.backlogEvents.insert(id, 'actionable_removed', `Removed checklist item: ${a.text.slice(0, 120)}`, {
      phase: a.phase, template_key: a.template_key,
    });
    reply.type('text/html').send('');
  });

  // Resolve a JID for the given target. Returns { jid, recipientName } or null
  // if we can't figure it out (caller should surface a friendly error).
  function resolveTargetJid(itemId: number, target: ActionableTarget): { jid: string; name: string } | null {
    const item = ctx.backlog.findById(itemId)!;
    const meta = item.metadata_json ? JSON.parse(item.metadata_json) as Record<string, unknown> : {};
    let name = '';
    if (target === 'mr_author') {
      // Direct gitlab item: meta.author. Sheet/wa_task: walk to the gitlab child.
      if (item.source === 'gitlab') {
        name = meta.author ? String(meta.author) : '';
      } else {
        const mrChild = ctx.backlog.getChildrenOf(itemId).find(c => c.source === 'gitlab');
        if (mrChild) {
          const cm = mrChild.metadata_json ? JSON.parse(mrChild.metadata_json) as Record<string, unknown> : {};
          name = cm.author ? String(cm.author) : '';
        }
      }
    } else if (target === 'owner') {
      if (item.source === 'sheet') {
        name = meta['Allotted to'] ? String(meta['Allotted to']) : '';
      } else if (item.source === 'gitlab') {
        name = meta.author ? String(meta.author) : '';
      }
    }
    if (!name) return null;
    const member = ctx.team.findMemberByName(name);
    if (!member) return null;
    return { jid: member.jid, name: member.name };
  }

  app.post<{ Params: { id: string; aid: string } }>('/backlog/:id/actionable/:aid/send', async (req, reply) => {
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    const a = ctx.actionables.getById(aid);
    if (!a || a.backlog_id !== id) return reply.code(404).send('not found');
    if (a.target === 'self') return reply.code(400).send('actionable target=self cannot be sent');
    if (a.pending_outbound_id) return reply.code(409).send('already queued');
    const resolved = resolveTargetJid(id, a.target as ActionableTarget);
    if (!resolved) {
      return reply.code(400).type('text/plain').send(
        `Could not resolve recipient for target=${a.target}. ` +
        `Make sure the source item has the assignee/author populated and a matching member in team.json.`
      );
    }
    const item = ctx.backlog.findById(id)!;
    const body = `Hey ${resolved.name.split(' ')[0]} 👋\n\nRe: ${item.title}\n\n${a.text}`;
    const outbound = ctx.outbound.enqueue({
      toJid: resolved.jid,
      body,
      kind: 'task_actionable',
      context: { backlogId: id, actionableId: aid },
    });
    ctx.actionables.attachOutbound(aid, outbound.id);
    const fresh = ctx.actionables.getById(aid)!;
    reply.type('text/html').send(actionableRow(fresh, outbound.status));
  });

  app.post<{ Params: { id: string }; Querystring: { phase?: string } }>('/backlog/:id/phase-override', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const phaseRaw = String(req.query.phase || '');
    const phase = PHASES.includes(phaseRaw as Phase) ? phaseRaw : null;
    ctx.db.prepare('UPDATE backlog_items SET phase_override = ?, updated_at = ? WHERE id = ?')
      .run(phase, Date.now(), id);
    ctx.backlogEvents.insert(id, 'phase_override',
      phase ? `Phase override → ${phase}` : 'Phase override cleared', { phase });
    reply.type('text/html').send(renderActionablesPanel(id));
  });

  // ----- Bulk actions on /backlog -----
  app.post<{ Body: { ids?: string | string[]; op?: string; hours?: string } }>('/backlog/bulk', async (req, reply) => {
    const raw = req.body?.ids;
    const ids = (Array.isArray(raw) ? raw : (raw ? [raw] : []))
      .flatMap(s => String(s).split(','))
      .map(s => Number(s.trim()))
      .filter(Number.isFinite);
    const op = String(req.body?.op || '');
    const today = istDateString();
    let n = 0;
    for (const id of ids) {
      const item = ctx.backlog.findById(id);
      if (!item) continue;
      if (op === 'pin')      { ctx.backlog.pin(id, today); n++; }
      else if (op === 'resolve') { ctx.backlog.markResolved(item.source, item.external_id); n++; }
      else if (op === 'snooze')  { ctx.backlog.snooze(id, Number(req.body?.hours || '24')); n++; }
    }
    reply.type('text/html').send(`<div class="text-xs text-emerald-700">✓ ${op} applied to ${n} item${n === 1 ? '' : 's'}. <a href="/backlog">Refresh →</a></div>`);
  });

  // ----- Per-item chat (Phase 7B) -----

  app.get<{ Params: { id: string } }>('/backlog/:id/chat', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const history = ctx.itemChat.listForItem(id);
    reply.type('text/html').send(chatModal(item, history));
  });

  app.post<{ Params: { id: string }; Body: { question?: string } }>('/backlog/:id/chat', async (req, reply) => {
    const id = Number(req.params.id);
    const item = ctx.backlog.findById(id);
    if (!item) return reply.code(404).send('not found');
    const question = String(req.body?.question || '').trim();
    if (!question) return reply.code(400).send('empty question');

    // Gather context: linked children + parents + recent linked WA messages
    const children = ctx.backlog.getChildrenOf(id);
    const parents = ctx.backlog.getParentsOf(id);
    const linkedMrs = children.filter(c => c.source === 'gitlab').map(c => {
      const m = c.metadata_json ? JSON.parse(c.metadata_json) as Record<string, unknown> : {};
      return {
        title: c.title,
        author: m.author ? String(m.author) : undefined,
        url: c.url ?? undefined,
        sourceBranch: m.source_branch ? String(m.source_branch) : undefined,
        targetBranch: m.target_branch ? String(m.target_branch) : undefined,
        updatedAt: m.updated_at ? String(m.updated_at) : undefined,
      };
    });
    const linkedDiscussions = children.filter(c => c.source === 'wa_task_update' || c.source === 'wa_status_check').map(c => {
      const m = c.metadata_json ? JSON.parse(c.metadata_json) as Record<string, unknown> : {};
      return { kind: c.source, title: c.title, sender: m.sender ? String(m.sender) : undefined, ts: c.created_at };
    });

    // Discussions with metadata.linked_backlog_id pointing back to this item (the
    // task_update linkage we wrote in ClassifyWaInboxJob isn't represented as a
    // backlog_links row, so getChildrenOf misses it).
    const linkedByMeta = ctx.db.prepare(`
      SELECT id, source, title, created_at, metadata_json
      FROM backlog_items
      WHERE source IN ('wa_task_update','wa_status_check')
        AND status = 'open'
        AND json_extract(metadata_json, '$.linked_backlog_id') = ?
    `).all(id) as Array<{ id: number; source: string; title: string; created_at: number; metadata_json: string | null }>;
    for (const r of linkedByMeta) {
      const m = r.metadata_json ? JSON.parse(r.metadata_json) as Record<string, unknown> : {};
      linkedDiscussions.push({ kind: r.source as BacklogSource, title: r.title, sender: m.sender ? String(m.sender) : undefined, ts: r.created_at });
    }

    // Recent WA messages tied to this item's origin (best-effort; only useful for wa_* items)
    let recentMessages: { sender: string; ts: number; text: string }[] = [];
    if (item.origin_jid && !item.origin_jid.startsWith('backfill:')) {
      const msgs = ctx.db.prepare(`
        SELECT participant_jid, ts, text FROM messages
        WHERE remote_jid = ? AND text IS NOT NULL
        ORDER BY ts DESC LIMIT 20
      `).all(item.origin_jid) as Array<{ participant_jid: string; ts: number; text: string }>;
      recentMessages = msgs.reverse().map(m => ({
        sender: m.participant_jid.split('@')[0],
        ts: m.ts,
        text: (m.text || '').slice(0, 300),
      }));
    }

    const meta = item.metadata_json ? JSON.parse(item.metadata_json) as Record<string, unknown> : undefined;
    try {
      const r = await ctx.gemini.classify<AnswerItemQuestionOutput>({
        system: answerItemQuestionSystem,
        user: buildAnswerItemQuestionUser({
          item: {
            source: item.source,
            title: item.title,
            description: item.description ?? undefined,
            url: item.url ?? undefined,
            status: item.status,
            metadata: meta,
          },
          linkedMrs,
          linkedDiscussions,
          parentTasks: parents.map(p => ({ source: p.source, title: p.title, url: p.url ?? undefined })),
          recentMessages,
          question,
        }),
        schema: answerItemQuestionSchema,
      });
      const entry = ctx.itemChat.insert(id, question, r.data.answer);
      ctx.backlogEvents.insert(id, 'chat_created', `Q: ${question.slice(0, 120)}`);
      reply.type('text/html').send(chatHistoryEntry(entry));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const entry = ctx.itemChat.insert(id, question, `[error answering: ${msg}]`);
      reply.type('text/html').send(chatHistoryEntry(entry));
    }
  });

  // ----- Cmd+K palette: backlog item search -----
  app.get('/palette/search', async (req, reply) => {
    const q = String((req.query as { q?: string }).q || '').trim();
    if (!q) {
      reply.type('text/html').send('<div class="px-3 py-2 italic">Type to search…</div>');
      return;
    }
    const items = ctx.backlog.listOpen({ q }).slice(0, 20);
    if (items.length === 0) {
      reply.type('text/html').send(`<div class="px-3 py-2 italic">No matches for "${q.replace(/[<>&]/g, '')}".</div>`);
      return;
    }
    const html = items.map(i => {
      const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
      const assignee = i.source === 'sheet' && meta['Allotted to'] ? ` · ${String(meta['Allotted to'])}` : '';
      const safe = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return `<a href="/backlog?source=${i.source}#b-${i.id}" class="flex items-center gap-2 px-3 py-2 rounded text-sm text-slate-700 hover:bg-slate-100">
        <span class="text-[10px] text-slate-400 uppercase shrink-0 w-12">${safe(i.source.replace('wa_',''))}</span>
        <span class="flex-1 truncate">${safe(i.title)}</span>
        <span class="text-[10px] text-slate-400 shrink-0">${safe(assignee)}</span>
      </a>`;
    }).join('');
    reply.type('text/html').send(html);
  });

  app.get('/healthz', async () => ({ ok: true }));

  // ──────────── Admin: jobs ────────────
  // List loaded scheduler jobs and recent run history. POST /admin/jobs/:name/run
  // invokes Scheduler.runOnce synchronously (mirrors `npm run job <name>`).
  app.get('/admin/jobs', async (_req, reply) => {
    const loaded = scheduler.list().map(j => ({
      name: j.name, schedule: j.schedule, description: j.description,
    }));
    const loadedNames = new Set(loaded.map(j => j.name));
    const enabled = (process.env.ENABLED_JOBS || '').split(',').map(s => s.trim()).filter(Boolean);
    const enabledMissing = enabled.filter(n => !loadedNames.has(n));
    const recentRuns = ctx.db.prepare(
      'SELECT job_name, ran_at, ok, error FROM scheduler_runs ORDER BY ran_at DESC LIMIT 50'
    ).all() as AdminJobRun[];

    const body = adminJobsPage({ jobs: loaded, recentRuns, enabledMissing });
    reply.type('text/html').send(layout({
      title: 'Admin · Jobs', body, active: 'admin', ...railCtx(),
    }));
  });

  app.post<{ Params: { name: string } }>('/admin/jobs/:name/run', async (req, reply) => {
    const name = req.params.name;
    const startedAt = Date.now();
    try {
      await scheduler.runOnce(name);
      reply.type('text/html').send(jobRunResult({ name, ok: true, ms: Date.now() - startedAt }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err.stack || err.message) : String(err);
      reply.type('text/html').send(jobRunResult({ name, ok: false, ms: Date.now() - startedAt, error: msg }));
    }
  });

  // ──────────── About / changelog ────────────
  app.get('/about', async (_req, reply) => {
    const body = aboutPage();
    reply.type('text/html').send(layout({
      title: 'About', body, active: 'about', ...railCtx(),
    }));
  });

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
  linked_backlog_id: number | null;
  linked_backlog_title: string | null;
  linked_backlog_source: string | null;
}
