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

function renderEodPanel(p: EodPanelData): string {
  const responded = p.members.filter(m => m.responded);
  const missing = p.members.filter(m => !m.responded);
  const blockerLines = responded
    .filter(m => m.blockers && m.blockers.trim())
    .map(m => `<li class="text-sm"><span class="font-medium">${escapeHtml(m.name)}:</span> ${escapeHtml(m.blockers)}</li>`)
    .join('');

  return `
  <div class="mb-4 bg-white border rounded-lg p-4">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500">🌙 EOD recap — ${escapeHtml(p.date)}</h2>
      <span class="text-xs text-slate-500">${responded.length}/${p.members.length} responded</span>
    </div>
    ${blockerLines ? `
      <div class="mb-3">
        <div class="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">🚧 Blockers</div>
        <ul class="space-y-1 ml-1">${blockerLines}</ul>
      </div>` : '<div class="text-xs text-emerald-700 mb-3">No blockers reported. ✓</div>'}
    <details class="text-xs">
      <summary class="cursor-pointer text-slate-600 hover:text-slate-900">Show all responses</summary>
      <div class="mt-2 space-y-3">
        ${responded.map(m => `<div class="border-l-2 border-slate-200 pl-3">
          <div class="font-medium text-sm">${escapeHtml(m.name)}</div>
          ${m.done ? `<div class="mt-0.5"><span class="text-emerald-700 font-medium">Done:</span> ${escapeHtml(m.done)}</div>` : ''}
          ${m.left ? `<div class="mt-0.5"><span class="text-amber-700 font-medium">Left:</span> ${escapeHtml(m.left)}</div>` : ''}
        </div>`).join('')}
        ${missing.length ? `<div class="text-slate-400 italic">No EOD: ${missing.map(m => escapeHtml(m.name)).join(', ')}</div>` : ''}
      </div>
    </details>
  </div>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(opts: { title: string; body: string; active?: 'home' | 'backlog' | 'messages' | 'outbound' | 'plan'; selectedDate?: string }): string {
  const navLink = (href: string, label: string, key: string, kbd?: string) => {
    const cls = opts.active === key
      ? 'px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm font-medium'
      : 'px-3 py-1.5 rounded-md text-slate-600 hover:bg-slate-200 text-sm font-medium';
    const kbdHtml = kbd ? `<kbd class="ml-1.5 px-1 py-0 text-[9px] font-mono bg-slate-200/60 text-slate-500 rounded border border-slate-300/40">${kbd}</kbd>` : '';
    return `<a href="${href}" class="${cls}" data-nav="${key}">${label}${kbdHtml}</a>`;
  };
  const today = istDateStringNow();
  const sel = opts.selectedDate || today;
  const datePicker = opts.active === 'home'
    ? `<form action="/" method="get" class="ml-2 flex items-center gap-1">
         <input type="date" name="date" value="${sel}" onchange="this.form.submit()"
                class="text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700">
         ${sel !== today ? `<a href="/" class="text-xs text-slate-400 hover:text-slate-700" title="Back to today">today</a>` : ''}
       </form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)} · machine</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/htmx.org@2.0.3"></script>
  <style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif} kbd{line-height:1}</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <header class="border-b bg-white sticky top-0 z-10">
    <div class="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <a href="/" class="font-semibold text-lg">machine</a>
        ${datePicker}
      </div>
      <nav class="flex gap-1.5 items-center">
        ${navLink('/', 'Today', 'home', 'g h')}
        ${navLink('/plan', 'Plan', 'plan', 'g p')}
        ${navLink('/backlog', 'Backlog', 'backlog', 'g b')}
        ${navLink('/outbound', 'Outbound', 'outbound', 'g o')}
        ${navLink('/messages', 'Messages', 'messages', 'g m')}
      </nav>
    </div>
  </header>
  <main class="max-w-6xl mx-auto px-4 py-5">
    ${opts.body}
  </main>
  <script>
    // Tiny keyboard shortcuts: 'g' then nav letter, '/' to focus search.
    (function(){
      let pendingG = false; let gTimer = null;
      const isTyping = e => ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
      document.addEventListener('keydown', e => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === '/' && !isTyping(e)) {
          const s = document.querySelector('input[type=search]');
          if (s) { e.preventDefault(); s.focus(); }
          return;
        }
        if (isTyping(e)) return;
        if (e.key === 'g') {
          pendingG = true;
          clearTimeout(gTimer);
          gTimer = setTimeout(() => { pendingG = false; }, 800);
          return;
        }
        if (pendingG) {
          pendingG = false; clearTimeout(gTimer);
          const map = { h: '/', p: '/plan', b: '/backlog', o: '/outbound', m: '/messages' };
          const dest = map[e.key];
          if (dest) { e.preventDefault(); location.href = dest; }
        }
      });
    })();
  </script>
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
  includeBackfill?: boolean;
  pendingOutboundCount: number;
  todaysConnects: BacklogItem[];
  myMissingEtaCount: number;
  eodPanel: EodPanelData | null;
  topBacklogScored: TopBacklogEntry[];   // already filtered (no signals) + scored
  todaysPlan: BacklogItem[];             // pinned for today
}

export interface TopBacklogEntry {
  item: BacklogItem;
  badges: TopBadge[];
}

export interface TopBadge {
  label: string;
  color: 'red' | 'amber' | 'blue' | 'slate';
}

export interface EodPanelData {
  date: string;                                 // session date
  members: Array<{
    name: string;
    responded: boolean;
    done: string;
    left: string;
    blockers: string;
  }>;
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

  const badgeClass: Record<TopBadge['color'], string> = {
    red:   'bg-red-100 text-red-800',
    amber: 'bg-amber-100 text-amber-800',
    blue:  'bg-blue-100 text-blue-800',
    slate: 'bg-slate-100 text-slate-600',
  };
  const topItems = d.topBacklogScored.slice(0, 10).map(({ item: i, badges }) => `
    <li class="py-2 flex items-start gap-3">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">${escapeHtml(i.title)}</div>
        <div class="mt-0.5 flex items-center gap-1.5 flex-wrap">
          ${badges.map(b => `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${badgeClass[b.color]}">${escapeHtml(b.label)}</span>`).join('')}
          ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
        </div>
      </div>
    </li>`).join('');

  // Today's connects strip
  const connectsStrip = d.todaysConnects.length ? `
    <div class="mb-4 bg-white border rounded-lg p-3">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500">📞 Connects waiting (${d.todaysConnects.length})</h2>
        <a href="/backlog?source=wa_connect" class="text-xs text-blue-600 hover:underline">All →</a>
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1">
        ${d.todaysConnects.slice(0, 6).map(c => {
          const meta = c.metadata_json ? JSON.parse(c.metadata_json) as Record<string, unknown> : {};
          const proposed = meta.proposed_time ? String(meta.proposed_time) : '';
          return `<div class="shrink-0 w-72 border rounded-lg p-2.5 bg-purple-50">
            <div class="text-sm font-medium line-clamp-2">${escapeHtml(c.title)}</div>
            ${proposed ? `<div class="text-xs text-purple-800 mt-1">⏰ ${escapeHtml(proposed)}</div>` : '<div class="text-xs text-slate-500 mt-1 italic">no time set</div>'}
            <div class="mt-2 flex gap-2">
              ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" class="text-xs px-2 py-1 rounded bg-purple-600 text-white hover:bg-purple-700">📅 Add to Calendar</a>` : ''}
              <button hx-post="/backlog/${c.id}/resolve" hx-target="closest div" hx-swap="outerHTML" class="text-xs px-2 py-1 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Done</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // ETA-missing panel (mine only)
  const etaPanel = d.myMissingEtaCount > 0 ? `
    <a href="/backlog?source=sheet&mine=1&missing_eta=1" class="block mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 hover:bg-amber-100 flex items-center justify-between">
      <span class="text-sm text-amber-900"><span class="font-semibold">${d.myMissingEtaCount}</span> task${d.myMissingEtaCount === 1 ? '' : 's'} assigned to you missing an ETA</span>
      <span class="text-xs text-amber-700">Fill them in →</span>
    </a>` : '';

  // Yesterday's (or last) EOD blockers panel
  const eodPanelHtml = d.eodPanel ? renderEodPanel(d.eodPanel) : '';

  // Today's plan — pinned items (or CTA to plan)
  const todaysPlanHtml = d.todaysPlan.length ? `
    <div class="mb-4 bg-emerald-50 border border-emerald-200 rounded-lg p-4">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-emerald-700">📌 Today's plan (${d.todaysPlan.length})</h2>
        <a href="/plan" class="text-xs text-emerald-700 hover:underline">Re-plan →</a>
      </div>
      <ul id="todays-plan-list" class="divide-y divide-emerald-200">
        ${d.todaysPlan.map(i => todaysPlanRow(i)).join('')}
      </ul>
    </div>` : `
    <a href="/plan" class="block mb-4 px-4 py-3 rounded-lg bg-slate-50 border border-slate-200 hover:bg-slate-100 text-center">
      <span class="text-sm text-slate-700">📌 Nothing pinned for today. <span class="font-medium text-emerald-700">Plan my day →</span></span>
    </a>`;

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
  ${todaysPlanHtml}
  ${connectsStrip}
  ${etaPanel}
  ${eodPanelHtml}
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
  q?: string;
  mine?: boolean;
  missingEta?: boolean;
}

function buildBacklogQs(d: BacklogData, override: Partial<{
  source: string; dev: string; backfill: string; mine: string; q: string; missing_eta: string;
}> = {}): string {
  const params: Record<string, string> = {};
  if (d.source !== 'all') params.source = d.source;
  if (d.devOnly) params.dev = '1';
  if (d.includeBackfill) params.backfill = '1';
  if (d.mine) params.mine = '1';
  if (d.q) params.q = d.q;
  if (d.missingEta) params.missing_eta = '1';
  for (const [k, v] of Object.entries(override)) {
    if (v === '' || v === '0' || v === undefined) delete params[k];
    else params[k] = v;
  }
  const qs = new URLSearchParams(params).toString();
  return qs ? `?${qs}` : '';
}

export function backlogPage(d: BacklogData): string {
  const filterChip = (val: string, label: string, active: boolean) => {
    const cls = active
      ? 'px-3 py-1 rounded-full text-xs bg-slate-900 text-white'
      : 'px-3 py-1 rounded-full text-xs bg-slate-200 text-slate-700 hover:bg-slate-300';
    const qs = buildBacklogQs(d, { source: val === 'all' ? '' : val });
    return `<a href="/backlog${qs}" class="${cls}">${label}</a>`;
  };
  const devChip = `<a href="/backlog${buildBacklogQs(d, { dev: d.devOnly ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.devOnly ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">Dev only</a>`;
  const backfillChip = `<a href="/backlog${buildBacklogQs(d, { backfill: d.includeBackfill ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.includeBackfill ? 'bg-amber-200 text-amber-900' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.includeBackfill ? '✓ Backfill' : '+ Backfill'}</a>`;
  const mineChip = `<a href="/backlog${buildBacklogQs(d, { mine: d.mine ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.mine ? 'bg-sky-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.mine ? '✓ Mine' : 'Mine only'}</a>`;
  const missingEtaChip = `<a href="/backlog${buildBacklogQs(d, { missing_eta: d.missingEta ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.missingEta ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.missingEta ? '✓ No ETA' : '⚠ No ETA'}</a>`;

  // HTMX search input drives only the results region; chips do full navigates.
  const searchInputUrl = `/backlog${buildBacklogQs(d, { q: '' })}`;
  const searchBar = `
    <div class="mb-3">
      <input type="search" name="q" value="${escapeHtml(d.q || '')}"
             placeholder="Search title, description, metadata…"
             hx-get="${searchInputUrl}"
             hx-trigger="input changed delay:250ms, search"
             hx-target="#backlog-results"
             hx-swap="outerHTML"
             hx-push-url="true"
             autocomplete="off"
             class="w-full px-3 py-2 text-sm border rounded-lg bg-white focus:outline-none focus:border-slate-400">
    </div>`;

  return `
  ${searchBar}
  <div class="mb-4 flex items-center gap-2 flex-wrap">
    ${filterChip('all', 'All', d.source === 'all')}
    ${filterChip('sheet', SOURCE_LABEL.sheet, d.source === 'sheet')}
    ${filterChip('gitlab', SOURCE_LABEL.gitlab, d.source === 'gitlab')}
    ${filterChip('wa_task', SOURCE_LABEL.wa_task, d.source === 'wa_task')}
    ${filterChip('wa_connect', SOURCE_LABEL.wa_connect, d.source === 'wa_connect')}
    ${filterChip('wa_task_update', SOURCE_LABEL.wa_task_update, d.source === 'wa_task_update')}
    ${filterChip('wa_status_check', SOURCE_LABEL.wa_status_check, d.source === 'wa_status_check')}
    ${filterChip('wa_mention_unreplied', SOURCE_LABEL.wa_mention_unreplied, d.source === 'wa_mention_unreplied')}
    <span class="ml-2">${mineChip}</span>
    <span>${missingEtaChip}</span>
    <span>${devChip}</span>
    <span>${backfillChip}</span>
  </div>
  ${backlogResultsPartial(d)}`;
}

export function backlogResultsPartial(d: BacklogData): string {
  return `<div id="backlog-results">
    <div class="mb-2 text-xs text-slate-500">${d.items.length} item${d.items.length === 1 ? '' : 's'}${d.q ? ` matching "${escapeHtml(d.q)}"` : ''}</div>
    <div class="bg-white rounded-lg border">
      <ul class="divide-y" id="backlog-list">
        ${d.items.length ? d.items.map(i => backlogRow(i, d.linksByItemId?.get(i.id))).join('') : '<li class="px-4 py-8 text-sm text-slate-500 text-center">No items match.</li>'}
      </ul>
    </div>
  </div>`;
}

export interface BacklogRowLinks {
  children?: BacklogItem[];   // for parent items (sheet, wa_task) — linked MRs
  parents?: BacklogItem[];    // for child items (gitlab) — parent tasks
}

// Returns the most recent dated entry in the sheet's "Task Updates" column.
// Format we see in real data: dated bullets, newest on top, separated by blank lines.
function latestSheetUpdate(meta: Record<string, unknown>): string {
  const updateKey = Object.keys(meta).find(k => k.startsWith('Task Updates'));
  if (!updateKey) return '';
  const v = meta[updateKey];
  if (typeof v !== 'string') return '';
  for (const raw of v.split('\n')) {
    const line = raw.trim();
    if (line && line.length > 3) return line;
  }
  return '';
}

const PRIORITY_COLOR: Record<string, string> = {
  '1': 'bg-red-600 text-white',
  '2': 'bg-amber-500 text-white',
  '3': 'bg-emerald-600 text-white',
};

export function backlogRow(i: BacklogItem, links?: BacklogRowLinks): string {
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
  const devBadge = i.is_dev_task === 1
    ? '<span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">dev</span>'
    : '';

  // Source-specific metadata pills.
  const pills: string[] = [];
  if (i.source === 'sheet') {
    const assignee = meta['Allotted to'] ? String(meta['Allotted to']) : '';
    const eta = meta.ETA ? String(meta.ETA).trim() : '';
    const sprint = meta.Sprint ? String(meta.Sprint).trim() : '';
    const priority = (meta['New Priority'] || meta.Priority) ? String(meta['New Priority'] || meta.Priority).trim() : '';
    const status = meta.Status ? String(meta.Status).trim() : '';

    if (priority && PRIORITY_COLOR[priority]) {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${PRIORITY_COLOR[priority]}">P${priority}</span>`);
    }
    if (assignee) {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-sky-100 text-sky-800">👤 ${escapeHtml(assignee)}</span>`);
    } else {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-500 italic">unassigned</span>`);
    }
    if (eta) {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-800">📅 ${escapeHtml(eta)}</span>`);
    } else {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">⚠ no ETA</span>`);
    }
    if (sprint) {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600">🏃 ${escapeHtml(sprint)}</span>`);
    }
    if (status && status.toUpperCase() !== 'DELAYED') {
      pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600">${escapeHtml(status)}</span>`);
    }
  } else if (i.source === 'gitlab') {
    if (meta.author) pills.push(`<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">👤 ${escapeHtml(String(meta.author))}</span>`);
    if (meta.source_branch) pills.push(`<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">${escapeHtml(String(meta.source_branch))}</span>`);
  }

  const latestUpdate = i.source === 'sheet' ? latestSheetUpdate(meta) : '';

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

  const isPinnedToday = i.pinned_for_date === istDateStringNow();
  const pinBtn = isPinnedToday
    ? `<button hx-post="/backlog/${i.id}/unpin" hx-target="#b-${i.id}" hx-swap="outerHTML"
              title="Unpin from today"
              class="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200 shrink-0">📌 Today</button>`
    : `<button hx-post="/backlog/${i.id}/pin" hx-target="#b-${i.id}" hx-swap="outerHTML"
              title="Pin to today's plan"
              class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 shrink-0">📌</button>`;

  return `
  <li id="b-${i.id}" class="px-4 py-3 flex items-start gap-3 ${isPinnedToday ? 'bg-emerald-50/40' : ''}">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium">${escapeHtml(i.title)}${devBadge}</div>
      ${pills.length ? `<div class="mt-1 flex items-center gap-1.5 flex-wrap">${pills.join('')}</div>` : ''}
      ${i.description ? `<div class="text-xs text-slate-500 mt-1 line-clamp-2">${escapeHtml(i.description.slice(0, 240))}</div>` : ''}
      ${latestUpdate ? `<div class="text-xs text-slate-600 mt-1 italic line-clamp-1">↪ ${escapeHtml(latestUpdate.slice(0, 200))}</div>` : ''}
      <div class="mt-1.5 flex items-center gap-2 flex-wrap">
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
      </div>
      ${linkChips.length ? `<div class="mt-2 flex flex-wrap gap-1">${linkChips.join('')}</div>` : ''}
    </div>
    <div class="flex items-center gap-1 shrink-0">
      ${pinBtn}
      <button hx-post="/backlog/${i.id}/resolve" hx-target="#b-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">Resolve</button>
    </div>
  </li>`;
}

// Cheap helper — mirrors istDateString() from utils/time.ts but inlined to
// avoid pulling Node-side env config into the view module.
function istDateStringNow(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now);
}

export function todaysPlanRow(i: BacklogItem): string {
  return `
  <li id="tp-${i.id}" class="py-2 flex items-start gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium">${escapeHtml(i.title)}</div>
      ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
    </div>
    <button hx-post="/backlog/${i.id}/unpin" hx-target="#tp-${i.id}" hx-swap="delete"
            title="Remove from today's plan"
            class="text-xs px-2 py-1 rounded bg-slate-200 text-slate-600 hover:bg-slate-300">✕</button>
  </li>`;
}

// ----- /plan page -----

export interface PlanRow {
  item: BacklogItem;
  score: number;
  reasons: string[];
  pinned: boolean;
}

export function planPage(d: { rows: PlanRow[]; date: string; pinnedCount: number }): string {
  return `
  <div class="mb-4 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold">Plan for ${escapeHtml(d.date)}</h1>
      <p class="text-xs text-slate-500 mt-0.5">Heuristic ranking — pin the items you want to work on. Re-runs on demand; the score is just a guess to save you time.</p>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-xs text-slate-500"><span class="font-semibold">${d.pinnedCount}</span> pinned</span>
      <button hx-post="/plan/refresh" hx-target="#plan-list" hx-swap="outerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">↻ Recompute</button>
      <button hx-post="/plan/pin-top" hx-target="#plan-list" hx-swap="outerHTML"
              class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">Pin top 7 →</button>
    </div>
  </div>
  ${planList(d.rows)}`;
}

export function planList(rows: PlanRow[]): string {
  if (!rows.length) return `<div id="plan-list" class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">Backlog is empty 🎉</div>`;
  return `<div id="plan-list" class="bg-white border rounded-lg divide-y">
    ${rows.map((r, idx) => planRow(r, idx)).join('')}
  </div>`;
}

export function planRow(r: PlanRow, idx: number): string {
  const i = r.item;
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
  const assignee = i.source === 'sheet' && meta['Allotted to'] ? String(meta['Allotted to']) : '';
  const pinBtn = r.pinned
    ? `<button hx-post="/backlog/${i.id}/unpin" hx-target="#pr-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200">📌 Pinned</button>`
    : `<button hx-post="/backlog/${i.id}/pin" hx-target="#pr-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">📌 Pin</button>`;
  return `
  <div id="pr-${i.id}" class="px-4 py-3 flex items-start gap-3 ${r.pinned ? 'bg-emerald-50/40' : ''}">
    <div class="text-xs font-mono text-slate-400 w-6 text-right shrink-0">${idx + 1}</div>
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium">${escapeHtml(i.title)}</div>
      ${assignee ? `<div class="text-[10px] text-slate-500 mt-0.5">👤 ${escapeHtml(assignee)}</div>` : ''}
      <div class="mt-1 text-xs text-slate-600">${r.reasons.map(rs => `<span class="italic">${escapeHtml(rs)}</span>`).join(' • ')}</div>
    </div>
    <div class="flex items-center gap-1 shrink-0">
      ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600 hover:bg-slate-200">↗</a>` : ''}
      ${pinBtn}
    </div>
  </div>`;
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
