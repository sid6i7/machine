import type { BacklogItem, BacklogSource } from '../db/repos/BacklogRepo.js';
import type { TasklistRow } from '../db/repos/TasklistsRepo.js';
import type { TeamMember } from '../db/repos/TeamRepo.js';
import type { EodSession, EodAnswer } from '../db/repos/EodRepo.js';
import type { PendingOutbound, OutboundKind } from '../db/repos/OutboundQueueRepo.js';

const SOURCE_LABEL: Record<BacklogSource, string> = {
  sheet: '📋 Sheet',
  gitlab: '🔀 GitLab',
  wa_task: '✅ WA Task',
  wa_connect: '📞 Connect',
  wa_task_update: '🔁 Update',
  wa_status_check: '❓ Status?',
  wa_mention_unreplied: '🔔 Unreplied',
};

const SOURCE_COLOR: Record<BacklogSource, string> = {
  sheet: 'bg-blue-100 text-blue-800',
  gitlab: 'bg-orange-100 text-orange-800',
  wa_task: 'bg-green-100 text-green-800',
  wa_connect: 'bg-purple-100 text-purple-800',
  wa_task_update: 'bg-amber-100 text-amber-800',
  wa_status_check: 'bg-pink-100 text-pink-800',
  wa_mention_unreplied: 'bg-red-100 text-red-800',
};

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(opts: { title: string; body: string; active?: 'home' | 'backlog' | 'messages' | 'outbound' }): string {
  const navLink = (href: string, label: string, key: string) => {
    const cls = opts.active === key
      ? 'px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm font-medium'
      : 'px-3 py-1.5 rounded-md text-slate-600 hover:bg-slate-200 text-sm font-medium';
    return `<a href="${href}" class="${cls}">${label}</a>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)} · machine</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/htmx.org@2.0.3"></script>
  <style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <header class="border-b bg-white sticky top-0 z-10">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="font-semibold text-lg">machine</a>
      <nav class="flex gap-2">
        ${navLink('/', 'Today', 'home')}
        ${navLink('/backlog', 'Backlog', 'backlog')}
        ${navLink('/outbound', 'Outbound', 'outbound')}
        ${navLink('/messages', 'Messages', 'messages')}
      </nav>
    </div>
  </header>
  <main class="max-w-6xl mx-auto px-4 py-6">
    ${opts.body}
  </main>
</body>
</html>`;
}

export interface DashboardData {
  date: string;
  members: TeamMember[];
  submittedJids: Set<string>;
  eodSession: EodSession | null;
  eodAnswers: EodAnswer[];
  backlogBySource: Record<BacklogSource, number>;
  topBacklog: BacklogItem[];
  includeBackfill?: boolean;
  pendingOutboundCount: number;
}

export function dashboard(d: DashboardData): string {
  const totalMembers = d.members.filter(m => !m.excludeFromTasklist).length;
  const submittedCount = d.members.filter(m => !m.excludeFromTasklist && d.submittedJids.has(m.jid)).length;
  const pendingMembers = d.members.filter(m => !m.excludeFromTasklist && !d.submittedJids.has(m.jid));

  const eodMembers = d.members.filter(m => !m.excludeFromEod);
  const respondedJids = new Set<string>();
  if (d.eodSession) {
    for (const a of d.eodAnswers) respondedJids.add(a.member_jid);
  }
  const eodResponded = eodMembers.filter(m => respondedJids.has(m.jid)).length;

  const backlogTotal = Object.values(d.backlogBySource).reduce((a, b) => a + b, 0);

  const memberPill = (m: TeamMember) =>
    `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-200 text-slate-700">${escapeHtml(m.name || m.jid.split('@')[0])}</span>`;

  const sourceCard = (src: BacklogSource) => {
    const n = d.backlogBySource[src] || 0;
    return `<a href="/backlog?source=${src}" class="block px-3 py-2 rounded-md ${SOURCE_COLOR[src]} hover:opacity-80">
      <div class="text-xs">${SOURCE_LABEL[src]}</div>
      <div class="text-2xl font-semibold">${n}</div>
    </a>`;
  };
  const allSources: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];

  const topItems = d.topBacklog.slice(0, 10).map(i => `
    <li class="py-2 flex items-start gap-3">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]}">${SOURCE_LABEL[i.source]}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">${escapeHtml(i.title)}</div>
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
      </div>
    </li>`).join('');

  const backfillToggle = `<div class="mb-4 text-xs">
    <a href="?${d.includeBackfill ? '' : 'backfill=1'}" class="inline-flex items-center px-2 py-1 rounded ${d.includeBackfill ? 'bg-amber-200 text-amber-900' : 'bg-slate-200 text-slate-700'}">
      ${d.includeBackfill ? '✓ Including backfill' : 'Backfill hidden'}
    </a>
  </div>`;

  const outboundBanner = d.pendingOutboundCount > 0
    ? `<a href="/outbound" class="block mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-300 hover:bg-amber-100 flex items-center justify-between">
        <span class="text-sm text-amber-900"><span class="font-semibold">${d.pendingOutboundCount}</span> message${d.pendingOutboundCount === 1 ? '' : 's'} pending your approval</span>
        <span class="text-xs text-amber-700">Review →</span>
      </a>`
    : '';

  return `
  ${outboundBanner}
  ${backfillToggle}
  <div class="grid md:grid-cols-3 gap-4 mb-6">
    <div class="bg-white rounded-lg border p-4">
      <div class="text-xs uppercase tracking-wide text-slate-500">Tasklists today (${d.date})</div>
      <div class="mt-1 text-3xl font-semibold">${submittedCount}/${totalMembers}</div>
      ${pendingMembers.length ? `<div class="mt-3 text-xs text-slate-500">Pending:</div><div class="mt-1 flex flex-wrap gap-1">${pendingMembers.map(memberPill).join('')}</div>` : '<div class="mt-3 text-xs text-emerald-600">All in ✓</div>'}
    </div>
    <div class="bg-white rounded-lg border p-4">
      <div class="text-xs uppercase tracking-wide text-slate-500">EOD standup</div>
      ${d.eodSession
        ? `<div class="mt-1 text-3xl font-semibold">${eodResponded}/${eodMembers.length}</div>
           <div class="mt-1 text-xs text-slate-500">${d.eodSession.posted_at ? 'Posted ✓' : 'Open'}</div>`
        : `<div class="mt-1 text-sm text-slate-500">Not started yet (kicks off 19:00 IST).</div>`}
    </div>
    <div class="bg-white rounded-lg border p-4">
      <div class="text-xs uppercase tracking-wide text-slate-500">Backlog</div>
      <div class="mt-1 text-3xl font-semibold">${backlogTotal}</div>
      <div class="mt-1 text-xs text-slate-500">open across all sources</div>
    </div>
  </div>

  <div class="grid grid-cols-2 md:grid-cols-7 gap-2 mb-6">
    ${allSources.map(sourceCard).join('')}
  </div>

  <div class="bg-white rounded-lg border">
    <div class="px-4 py-3 border-b flex items-center justify-between">
      <h2 class="text-sm font-semibold">Top backlog</h2>
      <a href="/backlog" class="text-xs text-blue-600 hover:underline">See all →</a>
    </div>
    <ul class="divide-y px-4">${topItems || '<li class="py-6 text-sm text-slate-500 text-center">Backlog is empty 🎉</li>'}</ul>
  </div>`;
}

export interface BacklogData {
  items: BacklogItem[];
  source: BacklogSource | 'all';
  devOnly: boolean;
  includeBackfill?: boolean;
  linksByItemId?: Map<number, BacklogRowLinks>;
}

export function backlogPage(d: BacklogData): string {
  const bfQs = d.includeBackfill ? '&backfill=1' : '';
  const filterChip = (val: string, label: string, active: boolean) => {
    const cls = active
      ? 'px-3 py-1 rounded-full text-xs bg-slate-900 text-white'
      : 'px-3 py-1 rounded-full text-xs bg-slate-200 text-slate-700 hover:bg-slate-300';
    return `<a href="/backlog?source=${val}${d.devOnly ? '&dev=1' : ''}${bfQs}" class="${cls}">${label}</a>`;
  };
  const devChipUrl = d.source === 'all' ? '' : `&source=${d.source}`;
  const devChip = `<a href="/backlog?dev=${d.devOnly ? '0' : '1'}${devChipUrl}${bfQs}" class="px-3 py-1 rounded-full text-xs ${d.devOnly ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">Dev only</a>`;
  const backfillChip = `<a href="/backlog?${d.source !== 'all' ? `source=${d.source}&` : ''}${d.devOnly ? 'dev=1&' : ''}backfill=${d.includeBackfill ? '0' : '1'}" class="px-3 py-1 rounded-full text-xs ${d.includeBackfill ? 'bg-amber-200 text-amber-900' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.includeBackfill ? '✓ Backfill' : '+ Backfill'}</a>`;

  return `
  <div class="mb-4 flex items-center gap-2 flex-wrap">
    ${filterChip('all', 'All', d.source === 'all')}
    ${filterChip('sheet', SOURCE_LABEL.sheet, d.source === 'sheet')}
    ${filterChip('gitlab', SOURCE_LABEL.gitlab, d.source === 'gitlab')}
    ${filterChip('wa_task', SOURCE_LABEL.wa_task, d.source === 'wa_task')}
    ${filterChip('wa_connect', SOURCE_LABEL.wa_connect, d.source === 'wa_connect')}
    ${filterChip('wa_task_update', SOURCE_LABEL.wa_task_update, d.source === 'wa_task_update')}
    ${filterChip('wa_status_check', SOURCE_LABEL.wa_status_check, d.source === 'wa_status_check')}
    ${filterChip('wa_mention_unreplied', SOURCE_LABEL.wa_mention_unreplied, d.source === 'wa_mention_unreplied')}
    <span class="ml-2">${devChip}</span>
    <span>${backfillChip}</span>
    <span class="ml-auto text-xs text-slate-500">${d.items.length} item${d.items.length === 1 ? '' : 's'}</span>
  </div>
  <div class="bg-white rounded-lg border">
    <ul class="divide-y" id="backlog-list">
      ${d.items.length ? d.items.map(i => backlogRow(i, d.linksByItemId?.get(i.id))).join('') : '<li class="px-4 py-8 text-sm text-slate-500 text-center">No items match this filter.</li>'}
    </ul>
  </div>`;
}

export interface BacklogRowLinks {
  children?: BacklogItem[];   // for parent items (sheet, wa_task) — linked MRs
  parents?: BacklogItem[];    // for child items (gitlab) — parent tasks
}

export function backlogRow(i: BacklogItem, links?: BacklogRowLinks): string {
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
  const tags: string[] = [];
  if (i.source === 'sheet') {
    if (meta.Status) tags.push(String(meta.Status));
    if (meta['Allotted to']) tags.push(String(meta['Allotted to']));
    if (meta.ETA) tags.push(`ETA ${String(meta.ETA)}`);
  } else if (i.source === 'gitlab') {
    if (meta.author) tags.push(String(meta.author));
  }
  const devBadge = i.is_dev_task === 1
    ? '<span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">dev</span>'
    : '';

  const linkChips: string[] = [];
  if (links?.children?.length) {
    for (const c of links.children) {
      const label = c.source === 'gitlab' ? '🔀 MR' : SOURCE_LABEL[c.source];
      linkChips.push(`<a href="${c.url ? escapeHtml(c.url) : '#'}" target="_blank" title="${escapeHtml(c.title)}" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-orange-50 text-orange-700 hover:bg-orange-100">${label}: ${escapeHtml(c.title.slice(0, 60))}</a>`);
    }
  }
  if (links?.parents?.length) {
    for (const p of links.parents) {
      const label = p.source === 'sheet' ? '📋 Task' : SOURCE_LABEL[p.source];
      linkChips.push(`<a href="/backlog?source=${p.source}#b-${p.id}" title="${escapeHtml(p.title)}" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 hover:bg-blue-100">↩ ${label}: ${escapeHtml(p.title.slice(0, 60))}</a>`);
    }
  }

  return `
  <li id="b-${i.id}" class="px-4 py-3 flex items-start gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]}">${SOURCE_LABEL[i.source]}</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium">${escapeHtml(i.title)}${devBadge}</div>
      ${i.description ? `<div class="text-xs text-slate-500 mt-0.5 line-clamp-2">${escapeHtml(i.description.slice(0, 240))}</div>` : ''}
      <div class="mt-1 flex items-center gap-2 flex-wrap">
        ${tags.map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">${escapeHtml(t)}</span>`).join('')}
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
      </div>
      ${linkChips.length ? `<div class="mt-2 flex flex-wrap gap-1">${linkChips.join('')}</div>` : ''}
    </div>
    <button hx-post="/backlog/${i.id}/resolve" hx-target="#b-${i.id}" hx-swap="outerHTML"
            class="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">Resolve</button>
  </li>`;
}

export function resolvedRow(i: BacklogItem): string {
  return `<li id="b-${i.id}" class="px-4 py-3 text-sm text-slate-400 italic">✓ Resolved: ${escapeHtml(i.title)}</li>`;
}

export interface MessagesData {
  rows: Array<{ id: string; remote_jid: string; participant_jid: string; text: string | null; ts: number; push_name: string | null; classified_intent: string | null; }>;
}

const KIND_LABEL: Record<OutboundKind, string> = {
  tasklist_nudge:  '📋 Tasklist nudge',
  eod_check_in:    '🌙 EOD check-in',
  eod_summary:     '📣 EOD summary (group)',
  eod_summary_dm:  '📨 EOD summary (DM)',
};
const KIND_COLOR: Record<OutboundKind, string> = {
  tasklist_nudge:  'bg-blue-100 text-blue-800',
  eod_check_in:    'bg-indigo-100 text-indigo-800',
  eod_summary:     'bg-purple-100 text-purple-800',
  eod_summary_dm:  'bg-purple-100 text-purple-800',
};

function recipientLabel(p: PendingOutbound, members: TeamMember[]): string {
  const m = members.find(mm => mm.jid === p.to_jid);
  if (m) return m.name || p.to_jid;
  // group jid? show last 6 chars of digit prefix to keep it short
  return p.to_jid.split('@')[0];
}

export interface OutboundPageData {
  pending: PendingOutbound[];
  recent: PendingOutbound[];
  members: TeamMember[];
}

export function outboundPage(d: OutboundPageData): string {
  const pendingCards = d.pending.map(p => outboundCard(p, d.members)).join('');
  const recentRows = d.recent
    .filter(r => r.status !== 'pending')
    .slice(0, 30)
    .map(r => outboundHistoryRow(r, d.members)).join('');

  return `
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-lg font-semibold">Pending approvals (${d.pending.length})</h1>
    ${d.pending.length > 1 ? `<button hx-post="/outbound/approve-all" hx-target="#outbound-list" hx-swap="innerHTML"
            class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">Approve all</button>` : ''}
  </div>
  <div id="outbound-list" class="space-y-3">
    ${pendingCards || '<div class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">Nothing pending. The bot will queue here before sending anything to anyone but you. 🌿</div>'}
  </div>
  ${recentRows ? `
    <h2 class="mt-8 mb-2 text-sm font-semibold text-slate-600">Recent (last 30)</h2>
    <div class="bg-white rounded-lg border divide-y">${recentRows}</div>
  ` : ''}`;
}

export function outboundCard(p: PendingOutbound, members: TeamMember[]): string {
  const recipient = recipientLabel(p, members);
  const ageMin = Math.max(0, Math.round((Date.now() - p.created_at) / 60000));
  const errorBanner = p.status === 'error' && p.error
    ? `<div class="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">⚠ ${escapeHtml(p.error)}</div>`
    : '';
  const ctx = p.context_json ? JSON.parse(p.context_json) as Record<string, unknown> : {};
  const ctxLine = Object.keys(ctx).length
    ? `<div class="text-[10px] text-slate-400 mt-1">${escapeHtml(Object.entries(ctx).filter(([k]) => k !== 'dedupKey').map(([k, v]) => `${k}=${v}`).join(' • '))}</div>`
    : '';

  return `
  <div id="ob-${p.id}" class="bg-white border rounded-lg p-4">
    ${errorBanner}
    <div class="flex items-start justify-between mb-2 gap-3">
      <div>
        <div class="text-sm font-medium">→ ${escapeHtml(recipient)} <span class="text-xs text-slate-400 font-normal">${escapeHtml(p.to_jid)}</span></div>
        <div class="mt-1 flex items-center gap-2">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${KIND_COLOR[p.kind]}">${KIND_LABEL[p.kind]}</span>
          <span class="text-[10px] text-slate-400">${ageMin === 0 ? 'just now' : `${ageMin} min ago`}</span>
        </div>
        ${ctxLine}
      </div>
    </div>
    <form hx-post="/outbound/${p.id}/approve" hx-target="#ob-${p.id}" hx-swap="outerHTML">
      <textarea name="body" rows="${Math.min(12, Math.max(3, (p.body.match(/\n/g) || []).length + 2))}"
                class="w-full text-sm font-mono border rounded p-2 bg-slate-50 focus:bg-white focus:border-slate-400 outline-none">${escapeHtml(p.body)}</textarea>
      <div class="mt-2 flex items-center gap-2">
        <button type="submit"
                class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">${p.status === 'error' ? 'Retry & send' : 'Approve & send'}</button>
        <button type="button" hx-post="/outbound/${p.id}/skip" hx-target="#ob-${p.id}" hx-swap="outerHTML"
                class="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Skip</button>
      </div>
    </form>
  </div>`;
}

export function outboundHistoryRow(p: PendingOutbound, members: TeamMember[]): string {
  const recipient = recipientLabel(p, members);
  const when = p.sent_at || p.approved_at || p.created_at;
  const statusColor =
    p.status === 'sent' ? 'text-emerald-700' :
    p.status === 'skipped' ? 'text-slate-500' :
    'text-red-700';
  return `
  <div class="px-4 py-2 flex items-center gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${KIND_COLOR[p.kind]}">${KIND_LABEL[p.kind]}</span>
    <span class="text-xs text-slate-500 w-32 shrink-0">${new Date(when).toLocaleString()}</span>
    <span class="text-xs flex-1 truncate">→ ${escapeHtml(recipient)}: ${escapeHtml(p.body.slice(0, 80))}</span>
    <span class="text-[10px] ${statusColor} font-medium uppercase">${p.status}</span>
  </div>`;
}

export function outboundSentRow(p: PendingOutbound, members: TeamMember[]): string {
  return `<div id="ob-${p.id}" class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
    ✓ Sent to ${escapeHtml(recipientLabel(p, members))} — ${KIND_LABEL[p.kind]}
  </div>`;
}

export function outboundSkippedRow(p: PendingOutbound, members: TeamMember[]): string {
  return `<div id="ob-${p.id}" class="bg-slate-100 border border-slate-200 rounded-lg p-3 text-sm text-slate-500 italic">
    Skipped — ${KIND_LABEL[p.kind]} to ${escapeHtml(recipientLabel(p, members))}
  </div>`;
}

export function messagesPage(d: MessagesData): string {
  return `
  <div class="bg-white rounded-lg border">
    <div class="px-4 py-3 border-b flex items-center justify-between">
      <h2 class="text-sm font-semibold">Recent messages (last 100)</h2>
      <span class="text-xs text-slate-500">${d.rows.length} rows</span>
    </div>
    <ul class="divide-y">
      ${d.rows.length ? d.rows.map(r => `
        <li class="px-4 py-2 flex items-start gap-3">
          <div class="text-xs text-slate-500 shrink-0 w-32">${new Date(r.ts * 1000).toLocaleString()}</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs text-slate-500">${escapeHtml(r.push_name || r.participant_jid)} <span class="text-slate-300">→</span> ${escapeHtml(r.remote_jid)}${r.classified_intent ? `<span class="ml-2 inline-flex items-center px-1 rounded text-[10px] bg-slate-200">${r.classified_intent}</span>` : ''}</div>
            <div class="text-sm">${escapeHtml((r.text || '<media>').slice(0, 240))}</div>
          </div>
        </li>`).join('') : '<li class="px-4 py-6 text-center text-sm text-slate-500">No messages yet.</li>'}
    </ul>
  </div>`;
}
