import type { FastifyInstance } from 'fastify';
import type { JobContext } from '../jobs/Job.js';
import type { BacklogSource, BacklogItem } from '../db/repos/BacklogRepo.js';
import { istDateString } from '../utils/time.js';
import { layout, dashboard, backlogPage, backlogRow, resolvedRow, messagesPage } from './views.js';

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

    const topBacklog = allOpen.slice(0, 10);

    const body = dashboard({
      date: today,
      members,
      submittedJids,
      eodSession,
      eodAnswers,
      backlogBySource,
      topBacklog,
      includeBackfill,
    });
    reply.type('text/html').send(layout({ title: `Today (${today})`, body, active: 'home' }));
  });

  app.get('/backlog', async (req, reply) => {
    const q = req.query as { source?: string; dev?: string; backfill?: string };
    const sourceParam = q.source;
    const devOnly = q.dev === '1';
    const includeBackfill = q.backfill === '1';

    let items: BacklogItem[];
    if (sourceParam && VALID_SOURCES.includes(sourceParam as BacklogSource)) {
      items = ctx.backlog.listOpenBySource(sourceParam as BacklogSource, { includeBackfill });
    } else {
      items = ctx.backlog.listAllOpen({ includeBackfill });
    }
    if (devOnly) items = items.filter(i => i.is_dev_task === 1);

    const body = backlogPage({
      items,
      source: (sourceParam as BacklogSource) || 'all',
      devOnly,
      includeBackfill,
    });
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
