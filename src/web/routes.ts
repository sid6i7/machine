import type { FastifyInstance } from 'fastify';
import type { JobContext } from '../jobs/Job.js';
import type { BacklogSource, BacklogItem } from '../db/repos/BacklogRepo.js';
import { istDateString, workingHoursBetween } from '../utils/time.js';
import type { TopBacklogEntry, TopBadge, EodPanelData } from './views.js';

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
  outboundPage, outboundCard, outboundSentRow, outboundSkippedRow,
  backlogResultsPartial,
} from './views.js';

// Default assignee substring for `mine=1` filter. Sourced from team.json's
// userJid → member name once on bootstrap; falls back to env override.
const MY_ASSIGNEE_NAME = process.env.MY_SHEET_ASSIGNEE || 'Siddhant';

const VALID_SOURCES: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];

export function registerRoutes(app: FastifyInstance, ctx: JobContext): void {
  app.get('/', async (req, reply) => {
    const today = istDateString();
    const includeBackfill = (req.query as { backfill?: string }).backfill === '1';
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];

    const submittedJids = new Set<string>(
      ctx.tasklists.getForDate(today).map(t => t.member_jid)
    );

    const eodSession = ctx.eod.getSession(today) || null;
    const eodAnswers = eodSession ? ctx.eod.listAnswers(eodSession.id) : [];

    const allOpen = ctx.backlog.listAllOpen({ includeBackfill });
    const backlogBySource: Record<BacklogSource, number> = {
      sheet: 0, gitlab: 0, wa_task: 0, wa_connect: 0, wa_task_update: 0, wa_status_check: 0, wa_mention_unreplied: 0,
    };
    for (const i of allOpen) backlogBySource[i.source]++;

    // Top-10 with scoring + badges; signals (task_update, status_check) excluded.
    const now = Date.now();
    const scoreable = allOpen.filter(i => i.source !== 'wa_task_update' && i.source !== 'wa_status_check');
    const topBacklogScored: TopBacklogEntry[] = scoreable
      .map(item => ({ item, ...scoreItem(item, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ item, badges }) => ({ item, badges }));

    // Connects strip: all open wa_connect, prioritized for "today's calendar"
    const todaysConnects = ctx.backlog.listOpen({ source: 'wa_connect', includeBackfill });

    // ETA-missing count for me only
    const myMissingEta = ctx.backlog.listOpen({
      source: 'sheet',
      mineName: MY_ASSIGNEE_NAME,
      missingEta: true,
      includeBackfill,
    });

    // Most recent EOD session (today's if it exists, else last session with replies)
    const eodForPanel = eodSession || ctx.eod.getMostRecentSession() || null;
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

    const body = dashboard({
      date: today,
      members,
      submittedJids,
      eodSession,
      eodAnswers,
      backlogBySource,
      includeBackfill,
      pendingOutboundCount: ctx.outbound.pendingCount(),
      todaysConnects,
      myMissingEtaCount: myMissingEta.length,
      eodPanel,
      topBacklogScored,
    });
    reply.type('text/html').send(layout({ title: `Today (${today})`, body, active: 'home' }));
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
    reply.type('text/html').send(layout({ title: 'Backlog', body, active: 'backlog' }));
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
    reply.type('text/html').send(layout({ title: 'Messages', body, active: 'messages' }));
  });

  app.get('/outbound', async (_req, reply) => {
    const pending = ctx.outbound.listPending();
    const recent = ctx.outbound.listRecent(50);
    const members = ctx.team.exists() ? ctx.team.getMembers() : [];
    const body = outboundPage({ pending, recent, members });
    reply.type('text/html').send(layout({ title: 'Outbound', body, active: 'outbound' }));
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
