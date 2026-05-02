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

// Visual restraint: only external systems (sheet, gitlab) get color since
// they map to mental models the PM already has. WA-derived sources all share
// neutral slate; emoji + label do the work of distinguishing them.
const SOURCE_COLOR: Record<BacklogSource, string> = {
  sheet:                'bg-blue-50 text-blue-800 border border-blue-200',
  gitlab:               'bg-orange-50 text-orange-800 border border-orange-200',
  wa_task:              'bg-slate-100 text-slate-700',
  wa_connect:           'bg-slate-100 text-slate-700',
  wa_task_update:       'bg-slate-100 text-slate-700',
  wa_status_check:      'bg-slate-100 text-slate-700',
  wa_mention_unreplied: 'bg-slate-100 text-slate-700',
};

// Universal Cmd+K command palette. Static actions (nav + common ops) are
// listed inline and filtered client-side. The "Backlog items" section fetches
// matching items via HTMX from /palette/search as the user types — bounded
// at 20 results to keep the modal light.
function paletteModal(): string {
  const actions = [
    { label: 'Today',           href: '/',            kbd: 'g h', icon: '🏠' },
    { label: 'Plan my Day',     href: '/plan',        kbd: 'g p', icon: '📌' },
    { label: 'Backlog',         href: '/backlog',     kbd: 'g b', icon: '📋' },
    { label: 'Backlog (mine)',  href: '/backlog?mine=1',          icon: '👤' },
    { label: 'Backlog (sheet)', href: '/backlog?source=sheet',    icon: '📋' },
    { label: 'Backlog (gitlab MRs)', href: '/backlog?source=gitlab', icon: '🔀' },
    { label: 'Connects waiting', href: '/backlog?source=wa_connect', icon: '📞' },
    { label: 'Unreplied mentions', href: '/backlog?source=wa_mention_unreplied', icon: '🔔' },
    { label: 'Summary',         href: '/summary',     kbd: 'g s', icon: '📊' },
    { label: 'Evaluations',     href: '/evaluations', kbd: 'g e', icon: '📝' },
    { label: 'Outbound (pending approval)', href: '/outbound', kbd: 'g o', icon: '📤' },
    { label: 'Messages',        href: '/messages',    kbd: 'g m', icon: '💬' },
  ];
  const actionRows = actions.map((a, i) => `
    <a href="${a.href}" data-palette-row="${i}" class="palette-action flex items-center gap-2 px-3 py-2 rounded text-sm text-slate-700 hover:bg-slate-100" data-search="${escapeHtml(a.label.toLowerCase())}">
      <span class="w-5 text-center">${a.icon}</span>
      <span class="flex-1">${escapeHtml(a.label)}</span>
      ${a.kbd ? `<kbd class="text-[10px] text-slate-400 font-mono">${a.kbd}</kbd>` : ''}
    </a>`).join('');

  return `
  <div id="palette" class="hidden fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm">
    <div class="max-w-2xl mx-auto mt-24 bg-white border rounded-lg shadow-2xl overflow-hidden">
      <input id="palette-input" type="text" placeholder="Type to search backlog or jump to a page…  (esc to close)"
             autocomplete="off" spellcheck="false"
             hx-get="/palette/search" hx-trigger="input changed delay:200ms"
             hx-target="#palette-results" hx-swap="innerHTML" name="q"
             class="w-full px-4 py-3 text-sm outline-none border-b focus:border-slate-400">
      <div id="palette-static" class="max-h-64 overflow-y-auto p-1">${actionRows}</div>
      <div class="border-t">
        <div class="px-3 py-1.5 text-[10px] uppercase tracking-wide text-slate-400">Backlog items (matching)</div>
        <div id="palette-results" class="max-h-64 overflow-y-auto p-1 text-sm text-slate-500"><div class="px-3 py-2 italic">Type to search…</div></div>
      </div>
      <div class="px-3 py-1.5 text-[10px] text-slate-400 border-t flex items-center gap-3 bg-slate-50">
        <span><kbd class="font-mono">↑↓</kbd> navigate</span>
        <span><kbd class="font-mono">↵</kbd> open</span>
        <span><kbd class="font-mono">esc</kbd> close</span>
        <span class="ml-auto"><kbd class="font-mono">⌘K</kbd> from anywhere</span>
      </div>
    </div>
  </div>
  <script>
  (function(){
    const palette  = document.getElementById('palette');
    const input    = document.getElementById('palette-input');
    const staticEl = document.getElementById('palette-static');
    const results  = document.getElementById('palette-results');

    function visibleRows() {
      const allStatic = Array.from(staticEl.querySelectorAll('.palette-action')).filter(el => !el.classList.contains('palette-hidden'));
      const dynamic   = Array.from(results.querySelectorAll('a'));
      return [...allStatic, ...dynamic];
    }
    let cursor = 0;
    function highlight() {
      const rows = visibleRows();
      rows.forEach((r, i) => r.classList.toggle('bg-slate-100', i === cursor));
      const sel = rows[cursor];
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
    function filterStatic() {
      const q = input.value.toLowerCase().trim();
      staticEl.querySelectorAll('.palette-action').forEach(el => {
        const m = !q || (el.dataset.search || '').includes(q);
        el.classList.toggle('palette-hidden', !m);
        el.classList.toggle('hidden', !m);
      });
      cursor = 0; highlight();
    }
    window.openPalette = function() {
      palette.classList.remove('hidden');
      input.value = '';
      filterStatic();
      results.innerHTML = '<div class="px-3 py-2 italic">Type to search…</div>';
      setTimeout(() => input.focus(), 30);
    };
    function closePalette() { palette.classList.add('hidden'); }
    palette.addEventListener('click', e => { if (e.target === palette) closePalette(); });
    document.addEventListener('keydown', e => {
      if (palette.classList.contains('hidden')) return;
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(visibleRows().length - 1, cursor + 1); highlight(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); cursor = Math.max(0, cursor - 1); highlight(); return; }
      if (e.key === 'Enter')     { e.preventDefault(); const sel = visibleRows()[cursor]; if (sel) sel.click(); return; }
    });
    input.addEventListener('input', filterStatic);
    document.body.addEventListener('htmx:afterSwap', e => { if (e.target.id === 'palette-results') { cursor = 0; highlight(); } });
  })();
  </script>`;
}

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

export function layout(opts: { title: string; body: string; active?: 'home' | 'backlog' | 'messages' | 'outbound' | 'plan' | 'summary' | 'evaluations'; selectedDate?: string; pinnedToday?: BacklogItem[]; pendingOutboundCount?: number }): string {
  const pinned = opts.pinnedToday || [];
  const pendingCount = opts.pendingOutboundCount || 0;
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
  // Sticky thin rail of today's pinned items, visible from any page so you
  // never lose sight of what you committed to today.
  const pinnedRail = pinned.length ? `
    <div class="border-b bg-emerald-50/60 sticky top-12 z-[5]">
      <div class="max-w-6xl mx-auto px-4 py-1.5 flex items-center gap-2 overflow-x-auto">
        <span class="text-[10px] uppercase tracking-wide text-emerald-700 shrink-0">📌 Today</span>
        ${pinned.map(i => `<a href="/backlog?source=${i.source}#b-${i.id}" class="shrink-0 text-xs px-2 py-0.5 rounded bg-white border border-emerald-200 text-slate-700 hover:bg-emerald-100" title="${escapeHtml(i.title)}">${escapeHtml(i.title.slice(0, 50))}${i.title.length > 50 ? '…' : ''}</a>`).join('')}
        <a href="/plan" class="shrink-0 text-[10px] text-emerald-700 hover:underline ml-auto">edit</a>
      </div>
    </div>` : '';

  const outboundRail = pendingCount > 0 && opts.active !== 'outbound' ? `
    <div class="border-b bg-amber-50 sticky ${pinned.length ? 'top-[68px]' : 'top-12'} z-[4]">
      <div class="max-w-6xl mx-auto px-4 py-1 text-xs text-amber-900 flex items-center justify-between">
        <span>${pendingCount} message${pendingCount === 1 ? '' : 's'} pending your approval</span>
        <a href="/outbound" class="text-amber-800 hover:underline font-medium">Review →</a>
      </div>
    </div>` : '';

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
        ${navLink('/summary', 'Summary', 'summary', 'g s')}
        ${navLink('/evaluations', 'Evaluations', 'evaluations', 'g e')}
        ${navLink('/outbound', 'Outbound', 'outbound', 'g o')}
        ${navLink('/messages', 'Messages', 'messages', 'g m')}
      </nav>
    </div>
  </header>
  ${pinnedRail}
  ${outboundRail}
  <main class="max-w-6xl mx-auto px-4 py-5">
    ${opts.body}
  </main>
  <div id="chat-modal-mount"></div>
  ${paletteModal()}
  <script>
    // Tiny keyboard shortcuts: 'g' then nav letter, '/' to focus search.
    (function(){
      let pendingG = false; let gTimer = null;
      const isTyping = e => ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
      // Cmd+K / Ctrl+K opens the palette from anywhere (even inside inputs).
      document.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          window.openPalette && window.openPalette();
          return;
        }
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
          if (e.key === 'k') { e.preventDefault(); window.openPalette && window.openPalette(); return; }
          const map = { h: '/', p: '/plan', b: '/backlog', s: '/summary', e: '/evaluations', o: '/outbound', m: '/messages' };
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
  partial?: boolean;                     // when true, dashboard returns inner content only (HTMX poll target)
  selectedDate?: string;                 // for date filter context
  isToday: boolean;                      // selectedDate === today
}

export interface TopBacklogEntry {
  item: BacklogItem;
  badges: TopBadge[];
  mine: boolean;                         // assignee/author matches MY_SHEET_ASSIGNEE
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

  const allSources: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];
  const sourceLine = (src: BacklogSource) => {
    const n = d.backlogBySource[src] || 0;
    return `<a href="/backlog?source=${src}" class="flex items-center justify-between px-2 py-1.5 rounded hover:bg-slate-50">
      <span class="text-xs">${SOURCE_LABEL[src]}</span>
      <span class="text-sm font-semibold tabular-nums ${n > 0 ? 'text-slate-900' : 'text-slate-400'}">${n}</span>
    </a>`;
  };

  const badgeClass: Record<TopBadge['color'], string> = {
    red:   'bg-red-100 text-red-800',
    amber: 'bg-amber-100 text-amber-800',
    blue:  'bg-slate-100 text-slate-600',
    slate: 'bg-slate-100 text-slate-600',
  };
  const renderTopRow = ({ item: i, badges }: TopBacklogEntry) => `
    <li class="py-2 flex items-start gap-3">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">${escapeHtml(i.title)}</div>
        <div class="mt-0.5 flex items-center gap-1.5 flex-wrap">
          ${badges.map(b => `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${badgeClass[b.color]}">${escapeHtml(b.label)}</span>`).join('')}
          ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
          <a href="/backlog?source=${i.source}#b-${i.id}" class="text-xs text-slate-400 hover:text-slate-700">manage</a>
        </div>
      </div>
    </li>`;

  const mine = d.topBacklogScored.filter(e => e.mine).slice(0, 10);
  const team = d.topBacklogScored.filter(e => !e.mine).slice(0, 10);
  const all  = d.topBacklogScored.slice(0, 10);

  // Tabs are pure CSS via the :has(checked) pattern. Three radios with the
  // same name; each tab content lives in a sibling div whose visibility flips
  // on the radio's checked state. No JS round trip.
  const tabRadio = (tabId: string, checked: boolean) =>
    `<input type="radio" name="topbacklog-tab" id="tb-${tabId}" class="hidden tb-radio" data-tab="${tabId}" ${checked ? 'checked' : ''}>`;
  const tabLabel = (tabId: string, label: string, count: number) =>
    `<label for="tb-${tabId}" class="tb-label cursor-pointer px-2.5 py-1 rounded text-xs font-medium text-slate-600 hover:bg-slate-100" data-tab="${tabId}">${label} <span class="opacity-60">${count}</span></label>`;
  const tabContent = (tabId: string, items: TopBacklogEntry[]) =>
    `<ul class="tb-content hidden divide-y" data-tab="${tabId}">${items.length ? items.map(renderTopRow).join('') : `<li class="py-6 text-center text-sm text-slate-400">Nothing here.</li>`}</ul>`;

  // Connects strip — only renders when there's anything to show
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
          return `<div class="shrink-0 w-72 border rounded-lg p-2.5 bg-slate-50">
            <div class="text-sm font-medium line-clamp-2">${escapeHtml(c.title)}</div>
            ${proposed ? `<div class="text-xs text-slate-700 mt-1">⏰ ${escapeHtml(proposed)}</div>` : '<div class="text-xs text-slate-400 mt-1 italic">no time set</div>'}
            <div class="mt-2 flex gap-2">
              ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" class="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">📅 Add to Calendar</a>` : ''}
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

  // Outbound banner now lives in layout's sticky outboundRail (visible on every
  // page, not just /). Keep an empty placeholder here so the dashboard layout
  // doesn't need restructuring further.
  const outboundBanner = '';

  // Compact "team status" sidebar (right column)
  const tasklistCard = `
    <div class="bg-white rounded-lg border p-3">
      <div class="flex items-baseline justify-between">
        <span class="text-xs uppercase tracking-wide text-slate-500">Tasklists${d.isToday ? '' : ` (${escapeHtml(d.date)})`}</span>
        <span class="text-lg font-semibold tabular-nums">${submittedCount}<span class="text-xs text-slate-400">/${totalMembers}</span></span>
      </div>
      ${pendingMembers.length
        ? `<div class="mt-2 flex flex-wrap gap-1">${pendingMembers.map(memberPill).join('')}</div>`
        : '<div class="mt-1 text-xs text-emerald-600">All in ✓</div>'}
    </div>`;

  const eodCard = `
    <div class="bg-white rounded-lg border p-3">
      <div class="flex items-baseline justify-between">
        <span class="text-xs uppercase tracking-wide text-slate-500">EOD standup</span>
        ${d.eodSession
          ? `<span class="text-lg font-semibold tabular-nums">${eodResponded}<span class="text-xs text-slate-400">/${eodMembers.length}</span></span>`
          : '<span class="text-xs text-slate-400">not started</span>'}
      </div>
      ${d.eodSession
        ? `<div class="mt-1 text-xs text-slate-500">${d.eodSession.posted_at ? 'Posted ✓' : 'Open — kicks off 19:00 IST'}</div>`
        : '<div class="mt-1 text-xs text-slate-400">19:00 IST</div>'}
    </div>`;

  const sourceListCard = `
    <div class="bg-white rounded-lg border p-2">
      <div class="px-2 pt-1 pb-2 text-xs uppercase tracking-wide text-slate-500 flex items-center justify-between">
        <span>Backlog by source</span>
        <span class="tabular-nums text-slate-700">${backlogTotal}</span>
      </div>
      <div class="divide-y divide-slate-100">${allSources.map(sourceLine).join('')}</div>
    </div>`;

  const backfillToggle = `<div class="text-xs">
    <a href="?${d.includeBackfill ? '' : 'backfill=1'}" class="inline-flex items-center px-2 py-0.5 rounded ${d.includeBackfill ? 'bg-amber-100 text-amber-900' : 'text-slate-400 hover:text-slate-700'}">
      ${d.includeBackfill ? '✓ Including backfill' : '+ Include backfill'}
    </a>
  </div>`;

  // Wrapped in a div the HTMX poll replaces every 30s
  const inner = `
  <div id="dash" hx-get="/?_partial=1${d.selectedDate && !d.isToday ? `&date=${d.selectedDate}` : ''}${d.includeBackfill ? '&backfill=1' : ''}" hx-trigger="every 30s" hx-swap="outerHTML">
    ${outboundBanner}

    <div class="grid lg:grid-cols-3 gap-4">
      <!-- LEFT: action items (2 cols) -->
      <div class="lg:col-span-2 space-y-4">
        ${todaysPlanHtml}
        ${connectsStrip}
        ${etaPanel}

        <div class="bg-white rounded-lg border" id="topbacklog">
          ${tabRadio('mine', true)}${tabRadio('team', false)}${tabRadio('all', false)}
          <div class="px-4 pt-3 pb-2 flex items-center justify-between border-b">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-semibold">Top backlog</h2>
              ${tabLabel('mine', 'Mine',          mine.length)}
              ${tabLabel('team', 'Team blockers', team.length)}
              ${tabLabel('all',  'All',           all.length)}
            </div>
            <a href="/backlog" class="text-xs text-blue-600 hover:underline">All →</a>
          </div>
          <div class="px-4">
            ${tabContent('mine', mine)}
            ${tabContent('team', team)}
            ${tabContent('all',  all)}
          </div>
          <style>
            #topbacklog:has(#tb-mine:checked) .tb-content[data-tab="mine"],
            #topbacklog:has(#tb-team:checked) .tb-content[data-tab="team"],
            #topbacklog:has(#tb-all:checked)  .tb-content[data-tab="all"]  { display: block; }
            #topbacklog:has(#tb-mine:checked) .tb-label[data-tab="mine"],
            #topbacklog:has(#tb-team:checked) .tb-label[data-tab="team"],
            #topbacklog:has(#tb-all:checked)  .tb-label[data-tab="all"]    { background:#0f172a; color:white; }
          </style>
        </div>
      </div>

      <!-- RIGHT: team status (1 col) -->
      <div class="space-y-3">
        ${tasklistCard}
        ${eodCard}
        ${sourceListCard}
        ${eodPanelHtml}
        ${backfillToggle}
      </div>
    </div>
  </div>`;

  return d.partial ? inner : inner;
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
  sort?: string;
  showSnoozed?: boolean;
}

function buildBacklogQs(d: BacklogData, override: Partial<{
  source: string; dev: string; backfill: string; mine: string; q: string; missing_eta: string; sort: string; snoozed: string;
}> = {}): string {
  const params: Record<string, string> = {};
  if (d.source !== 'all') params.source = d.source;
  if (d.devOnly) params.dev = '1';
  if (d.includeBackfill) params.backfill = '1';
  if (d.mine) params.mine = '1';
  if (d.q) params.q = d.q;
  if (d.missingEta) params.missing_eta = '1';
  if (d.sort) params.sort = d.sort;
  if (d.showSnoozed) params.snoozed = '1';
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

  // Bulk action toolbar — appears when ≥1 row checkbox is checked. Sends ids
  // as a CSV via hidden input and the chosen op via the button's hx-vals.
  const bulkToolbar = `
    <div id="bulk-toolbar" class="hidden mb-3 px-3 py-2 rounded bg-slate-900 text-white flex items-center gap-2 text-sm sticky top-12 z-[6]">
      <span><span id="bulk-count" class="font-semibold">0</span> selected</span>
      <input type="hidden" id="bulk-ids" name="ids" value="">
      <button onclick="window.bulkAction('pin')"     class="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700">📌 Pin today</button>
      <button onclick="window.bulkAction('snooze')"  class="text-xs px-2 py-1 rounded bg-amber-600 hover:bg-amber-700">😴 Snooze 24h</button>
      <button onclick="window.bulkAction('resolve')" class="text-xs px-2 py-1 rounded bg-rose-600 hover:bg-rose-700">✓ Resolve</button>
      <button onclick="document.querySelectorAll('.bulk-checkbox').forEach(c=>c.checked=false); window.updateBulk();" class="ml-auto text-xs text-slate-300 hover:text-white">clear</button>
    </div>
    <script>
      window.updateBulk = function(){
        const checked = Array.from(document.querySelectorAll('.bulk-checkbox:checked'));
        const ids = checked.map(c => c.value).join(',');
        const tb  = document.getElementById('bulk-toolbar');
        const cn  = document.getElementById('bulk-count');
        const hid = document.getElementById('bulk-ids');
        if (!tb) return;
        if (checked.length === 0) tb.classList.add('hidden');
        else tb.classList.remove('hidden');
        if (cn) cn.innerText = checked.length;
        if (hid) hid.value = ids;
      };
      window.bulkAction = function(op){
        const ids = document.getElementById('bulk-ids').value;
        if (!ids) return;
        const fd = new FormData(); fd.set('ids', ids); fd.set('op', op);
        fetch('/backlog/bulk', { method: 'POST', body: new URLSearchParams(fd) })
          .then(r => r.text()).then(() => location.reload());
      };
      document.addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('bulk-checkbox')) window.updateBulk(); });
    </script>`;

  return `
  ${bulkToolbar}
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
    <span class="ml-auto flex items-center gap-1">
      <span class="text-[10px] text-slate-400 uppercase">sort</span>
      ${(['recent','oldest','eta','priority'] as const).map(s => {
        const cls = (d.sort || 'recent') === s ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300';
        return `<a href="/backlog${buildBacklogQs(d, { sort: s === 'recent' ? '' : s })}" class="px-2 py-0.5 rounded-full text-[10px] ${cls}">${s}</a>`;
      }).join('')}
      <a href="/backlog${buildBacklogQs(d, { snoozed: d.showSnoozed ? '' : '1' })}" class="ml-2 px-2 py-0.5 rounded-full text-[10px] ${d.showSnoozed ? 'bg-amber-100 text-amber-900' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">😴 ${d.showSnoozed ? 'incl. snoozed' : 'show snoozed'}</a>
    </span>
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

  // PM note (overwriteable). Visible inline; click to edit.
  const noteBlock = i.pm_note
    ? `<details class="mt-1 text-xs">
         <summary class="cursor-pointer text-slate-600 italic">📝 ${escapeHtml(i.pm_note.slice(0, 80))}${i.pm_note.length > 80 ? '…' : ''}</summary>
         <form hx-post="/backlog/${i.id}/note" hx-target="#b-${i.id}" hx-swap="outerHTML" class="mt-1 flex gap-1">
           <textarea name="note" rows="2" class="flex-1 text-xs border rounded p-1 outline-none focus:border-slate-400">${escapeHtml(i.pm_note)}</textarea>
           <button type="submit" class="text-xs px-2 rounded bg-slate-200 hover:bg-slate-300">Save</button>
         </form>
       </details>`
    : '';

  // Snooze chip when snoozed_until is in the future
  const snoozeChip = i.snoozed_until && i.snoozed_until > Date.now()
    ? `<span class="text-[10px] text-amber-700">😴 until ${new Date(i.snoozed_until).toLocaleDateString()}</span>`
    : '';

  return `
  <li id="b-${i.id}" class="px-4 py-3 flex items-start gap-3 ${isPinnedToday ? 'bg-emerald-50/40' : ''}">
    <input type="checkbox" name="bulk_id" value="${i.id}" class="bulk-checkbox mt-1 shrink-0">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium">${escapeHtml(i.title)}${devBadge}</div>
      ${pills.length ? `<div class="mt-1 flex items-center gap-1.5 flex-wrap">${pills.join('')}${snoozeChip}</div>` : (snoozeChip ? `<div class="mt-1">${snoozeChip}</div>` : '')}
      ${i.description ? `<div class="text-xs text-slate-500 mt-1 line-clamp-2">${escapeHtml(i.description.slice(0, 240))}</div>` : ''}
      ${latestUpdate ? `<div class="text-xs text-slate-600 mt-1 italic line-clamp-1">↪ ${escapeHtml(latestUpdate.slice(0, 200))}</div>` : ''}
      ${noteBlock}
      <div class="mt-1.5 flex items-center gap-2 flex-wrap">
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">open ↗</a>` : ''}
        ${!i.pm_note ? `<button onclick="this.nextElementSibling.classList.toggle('hidden')" class="text-xs text-slate-500 hover:text-slate-800">+ note</button>
          <form hx-post="/backlog/${i.id}/note" hx-target="#b-${i.id}" hx-swap="outerHTML" class="hidden inline-flex gap-1 ml-1">
            <input type="text" name="note" placeholder="add note…" class="text-xs border rounded px-2 py-0.5 w-48 outline-none focus:border-slate-400">
            <button type="submit" class="text-xs px-2 rounded bg-slate-200 hover:bg-slate-300">Save</button>
          </form>` : ''}
      </div>
      ${linkChips.length ? `<div class="mt-2 flex flex-wrap gap-1">${linkChips.join('')}</div>` : ''}
    </div>
    <div class="flex items-center gap-1 shrink-0">
      <button hx-get="/backlog/${i.id}/chat" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              title="Chat about this item"
              class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">💬</button>
      <button hx-get="/backlog/${i.id}/timeline" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              title="Timeline of all linked discussions + MRs"
              class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">📜</button>
      <button hx-get="/backlog/${i.id}/link-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              title="Link to another item"
              class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">🔗</button>
      <button hx-post="/backlog/${i.id}/snooze?hours=24" hx-target="#b-${i.id}" hx-swap="outerHTML"
              title="Snooze 24h"
              class="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">😴</button>
      ${pinBtn}
      <button hx-post="/backlog/${i.id}/resolve" hx-target="#b-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">Resolve</button>
    </div>
  </li>`;
}

// ----- Per-item chat modal -----

import type { ItemChatEntry } from '../db/repos/ItemChatRepo.js';

export function chatModal(item: BacklogItem, history: ItemChatEntry[]): string {
  const meta = item.metadata_json ? JSON.parse(item.metadata_json) as Record<string, unknown> : {};
  const assignee = item.source === 'sheet' && meta['Allotted to'] ? String(meta['Allotted to']) : '';
  return `
  <div id="chat-modal" class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
       onclick="if (event.target === this) document.getElementById('chat-modal-mount').innerHTML=''">
    <div class="bg-white border rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]">
      <div class="px-4 py-3 border-b flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[item.source]} shrink-0">${SOURCE_LABEL[item.source]}</span>
            <h2 class="text-sm font-semibold truncate">${escapeHtml(item.title)}</h2>
          </div>
          ${assignee ? `<div class="text-[10px] text-slate-500 mt-0.5">👤 ${escapeHtml(assignee)}</div>` : ''}
        </div>
        <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
      </div>
      <div id="chat-history" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        ${history.length ? history.map(chatHistoryEntry).join('') : '<div class="text-xs text-slate-400 italic">No questions yet. Ask anything about this item — status, who\'s working on it, what\'s blocked, recent updates.</div>'}
      </div>
      <form class="border-t px-4 py-3" hx-post="/backlog/${item.id}/chat" hx-target="#chat-history" hx-swap="beforeend"
            onkeydown="if (event.key==='Enter' && !event.shiftKey) { event.preventDefault(); this.requestSubmit(); }">
        <div class="flex gap-2 items-end">
          <textarea name="question" rows="1" placeholder="Ask about this item…  (Enter to send)"
                    class="flex-1 text-sm border rounded px-2 py-1.5 outline-none focus:border-slate-400 resize-none" autofocus required></textarea>
          <button type="submit" class="text-xs px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800">Ask</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    // Reset textarea + scroll to bottom after each Q&A swap
    document.body.addEventListener('htmx:afterSwap', e => {
      if (e.target.id === 'chat-history') {
        const ta = document.querySelector('#chat-modal textarea[name=question]');
        if (ta) { ta.value = ''; ta.focus(); }
        e.target.scrollTop = e.target.scrollHeight;
      }
    });
  </script>`;
}

export function chatHistoryEntry(e: ItemChatEntry): string {
  return `
  <div class="space-y-1.5">
    <div class="text-xs"><span class="font-medium text-slate-700">You:</span> <span class="text-slate-600">${escapeHtml(e.question)}</span></div>
    <div class="text-xs bg-slate-50 border border-slate-200 rounded px-2.5 py-2 whitespace-pre-wrap text-slate-800">${escapeHtml(e.answer)}</div>
  </div>`;
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
  rows: Array<{ id: string; remote_jid: string; participant_jid: string; text: string | null; ts: number; push_name: string | null; classified_intent: string | null; linked_backlog_id?: number | null; linked_backlog_title?: string | null; linked_backlog_source?: string | null; }>;
  intent?: string;
  linkedOnly?: boolean;
  q?: string;
}

const KIND_LABEL: Record<OutboundKind, string> = {
  tasklist_nudge:    '📋 Tasklist nudge',
  eod_check_in:      '🌙 EOD check-in',
  eod_summary:       '📣 EOD summary (group)',
  eod_summary_dm:    '📨 EOD summary (DM)',
  weekly_summary_dm: '🗓 Weekly summary (DM)',
};
const KIND_COLOR: Record<OutboundKind, string> = {
  tasklist_nudge:    'bg-blue-100 text-blue-800',
  eod_check_in:      'bg-indigo-100 text-indigo-800',
  eod_summary:       'bg-purple-100 text-purple-800',
  eod_summary_dm:    'bg-purple-100 text-purple-800',
  weekly_summary_dm: 'bg-fuchsia-100 text-fuchsia-800',
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

// ----- /summary -----

export interface SummaryPageData {
  weekStart: string;                              // Monday YYYY-MM-DD
  workingDays: string[];                          // dates in this week
  members: TeamMember[];                          // non-excluded
  cellByMemberDate: Map<string, string>;          // key = `${jid}|${date}`, value = summary_md
  weeklyByMember: Map<string, string>;            // key = jid, value = week summary_md
  teamSummary: string | null;                     // team_overview_md
  madeLive: string | null;                        // made_live_md
  prevWeek: string;
  nextWeek: string;
}

export function summaryPage(d: SummaryPageData): string {
  const headerDates = d.workingDays.map(date => `<th class="px-2 py-1 text-xs font-medium text-slate-500">${escapeHtml(date.slice(5))}</th>`).join('');
  const rows = d.members.map(m => {
    const cells = d.workingDays.map(date => {
      const md = d.cellByMemberDate.get(`${m.jid}|${date}`) || '';
      return `<td class="align-top px-2 py-2 border-l border-slate-100 text-xs text-slate-700 max-w-[180px]">
        ${md ? `<details><summary class="cursor-pointer text-slate-800 line-clamp-3">${escapeHtml(md.slice(0, 140))}</summary><div class="mt-1 whitespace-pre-wrap text-[11px] text-slate-600">${escapeHtml(md)}</div></details>` : '<span class="text-slate-300">—</span>'}
      </td>`;
    }).join('');
    const wk = d.weeklyByMember.get(m.jid) || '';
    return `<tr class="border-t">
      <td class="px-3 py-2 align-top text-sm font-medium w-44">${escapeHtml(m.name || m.jid.split('@')[0])}</td>
      ${cells}
      <td class="px-2 py-2 align-top border-l border-slate-200 text-xs text-slate-700 max-w-[260px]">
        ${wk ? `<details><summary class="cursor-pointer font-medium">Week recap</summary><div class="mt-1 whitespace-pre-wrap text-[11px] text-slate-600">${escapeHtml(wk)}</div></details>` : '<span class="text-slate-300">—</span>'}
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="mb-4 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold">Week of ${escapeHtml(d.weekStart)}</h1>
      <p class="text-xs text-slate-500 mt-0.5">${d.workingDays.length} working days · ${d.members.length} members</p>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <a href="/summary?week=${d.prevWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">← prev week</a>
      <a href="/summary" class="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">this week</a>
      <a href="/summary?week=${d.nextWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">next week →</a>
    </div>
  </div>

  ${d.teamSummary ? `
    <div class="mb-4 bg-white border rounded-lg p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">📊 Team weekly roll-up</h2>
      <div class="prose prose-sm max-w-none whitespace-pre-wrap text-sm">${escapeHtml(d.teamSummary)}</div>
      ${d.madeLive ? `<details class="mt-3"><summary class="cursor-pointer text-xs font-semibold text-slate-600">📦 What we made live</summary><div class="mt-2 whitespace-pre-wrap text-sm text-slate-700">${escapeHtml(d.madeLive)}</div></details>` : ''}
    </div>` : `
    <div class="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
      No team summary for this week yet. Run <code>npm run job WeeklyTeamSummaryJob</code> Friday evening to generate.
    </div>`}

  <div class="bg-white border rounded-lg overflow-x-auto">
    <table class="w-full text-left">
      <thead class="bg-slate-50">
        <tr>
          <th class="px-3 py-2 text-xs font-medium text-slate-500">Member</th>
          ${headerDates}
          <th class="px-2 py-2 text-xs font-medium text-slate-500 border-l border-slate-200">Week</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="99" class="px-4 py-6 text-center text-sm text-slate-500">No members configured.</td></tr>'}</tbody>
    </table>
  </div>`;
}

// ----- /evaluations -----

export interface EvalRow {
  member: TeamMember;
  scoreProperly: number | null;
  scoreOnTime: number | null;
  scoreUpdates: number | null;
  scoreFeedback: number | null;
  feedbackText: string;
  evidence: Record<string, unknown>;
  saved: boolean;
  lastWeekFeedback: string;
}

export interface EvaluationsPageData {
  weekStart: string;
  rows: EvalRow[];
  prevWeek: string;
  nextWeek: string;
}

export function evaluationsPage(d: EvaluationsPageData): string {
  const rows = d.rows.map(r => evaluationRow(d.weekStart, r)).join('');
  return `
  <div class="mb-4 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold">Evaluations — week of ${escapeHtml(d.weekStart)}</h1>
      <p class="text-xs text-slate-500 mt-0.5">Scores prefilled from signals; edit and save per member. Saved rows are not re-prefilled.</p>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <a href="/evaluations?week=${d.prevWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">← prev</a>
      <a href="/evaluations" class="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">this week</a>
      <a href="/evaluations?week=${d.nextWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">next →</a>
    </div>
  </div>
  <div id="eval-list" class="space-y-3">${rows || '<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">No evaluations prefilled yet. Run <code>npm run job WeeklyEvaluationPrefillJob</code>.</div>'}</div>`;
}

function scoreInput(name: string, value: number | null, max: number, prefill: number | null, evidenceTitle: string): string {
  const v = value === null ? '' : String(value);
  const isPrefill = !value && prefill !== null;
  const display = v || (prefill !== null ? String(prefill) : '');
  return `
  <div class="flex flex-col" title="${escapeHtml(evidenceTitle)}">
    <label class="text-[10px] uppercase tracking-wide text-slate-500">${escapeHtml(name)}</label>
    <input type="number" name="${escapeHtml(name)}" min="0" max="${max}" step="1" value="${escapeHtml(display)}"
           class="w-16 mt-0.5 px-2 py-1 text-sm border rounded ${isPrefill ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-white'}">
    ${isPrefill ? '<span class="text-[9px] text-amber-700 mt-0.5">prefill</span>' : ''}
  </div>`;
}

export function evaluationRow(weekStart: string, r: EvalRow): string {
  const ev = r.evidence as { derived?: { eodCount: number; tasklistCount: number; bothCount: number; updateBoolSum: number; updatesMax: number }; perDay?: Array<{ date: string; tasklist: boolean; eod: boolean; selfInitiatedUpdates: number }>; notes?: string };
  const derived = ev.derived;
  const perDay = ev.perDay || [];
  const evidenceTitleProperly  = derived ? `EOD submitted on ${derived.eodCount} day(s)` : '';
  const evidenceTitleOnTime    = derived ? `Both tasklist + EOD on ${derived.bothCount} day(s)` : '';
  const evidenceTitleUpdates   = derived ? `Compliance signals: ${derived.updateBoolSum} / ${derived.updatesMax}` : '';
  const evidenceTitleFeedback  = r.lastWeekFeedback ? `Last week's feedback: ${r.lastWeekFeedback.slice(0, 200)}` : 'No prior feedback recorded';

  const badge = r.saved
    ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">✓ saved</span>'
    : '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">draft</span>';

  return `
  <form id="ev-${escapeHtml(r.member.jid)}" hx-post="/evaluations/${encodeURIComponent(r.member.jid)}/save" hx-target="this" hx-swap="outerHTML"
        class="bg-white border rounded-lg p-4">
    <input type="hidden" name="week_start_date" value="${escapeHtml(weekStart)}">
    <div class="flex items-start justify-between mb-3">
      <div>
        <div class="text-sm font-semibold">${escapeHtml(r.member.name || r.member.jid.split('@')[0])}</div>
        <div class="text-[10px] text-slate-400">${escapeHtml(r.member.jid)}</div>
      </div>
      ${badge}
    </div>
    <div class="flex items-end gap-3 flex-wrap mb-3">
      ${scoreInput('score_properly', r.scoreProperly, 6, r.scoreProperly, evidenceTitleProperly)}
      ${scoreInput('score_on_time',  r.scoreOnTime,   6, r.scoreOnTime,   evidenceTitleOnTime)}
      ${scoreInput('score_updates',  r.scoreUpdates,  6, r.scoreUpdates,  evidenceTitleUpdates)}
      ${scoreInput('score_feedback', r.scoreFeedback, 1, r.scoreFeedback, evidenceTitleFeedback)}
    </div>
    <details class="mb-3">
      <summary class="cursor-pointer text-xs text-slate-500 hover:text-slate-800">Show evidence</summary>
      <div class="mt-2 text-xs text-slate-600 space-y-1">
        ${perDay.length ? `<table class="w-full text-left">
          <thead><tr class="text-slate-400"><th class="font-normal pr-2">Day</th><th class="font-normal px-2">Tasklist</th><th class="font-normal px-2">EOD</th><th class="font-normal pl-2">Updates</th></tr></thead>
          <tbody>
            ${perDay.map(p => `<tr><td class="pr-2">${escapeHtml(p.date.slice(5))}</td><td class="px-2">${p.tasklist ? '✓' : '·'}</td><td class="px-2">${p.eod ? '✓' : '·'}</td><td class="pl-2">${p.selfInitiatedUpdates}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}
        ${r.lastWeekFeedback ? `<div class="mt-2 pt-2 border-t border-slate-100"><div class="text-[10px] uppercase text-slate-500 mb-0.5">Last week's feedback</div><div class="whitespace-pre-wrap text-slate-700">${escapeHtml(r.lastWeekFeedback)}</div></div>` : ''}
        ${ev.notes ? `<div class="text-[10px] text-slate-400 italic mt-1">${escapeHtml(ev.notes)}</div>` : ''}
      </div>
    </details>
    <textarea name="feedback_text" rows="3" placeholder="Feedback for this member, this week…"
              class="w-full text-sm border rounded p-2 bg-slate-50 focus:bg-white focus:border-slate-400 outline-none">${escapeHtml(r.feedbackText)}</textarea>
    <div class="mt-2 flex items-center gap-2">
      <button type="submit" class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">${r.saved ? 'Update' : 'Save'}</button>
    </div>
  </form>`;
}

export function messagesPage(d: MessagesData): string {
  const intents = ['', 'task', 'task_update', 'connect', 'status_check', 'noise'];
  const intentChip = (val: string) => {
    const active = (d.intent || '') === val;
    const label = val || 'all';
    const cls = active ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300';
    const qs = new URLSearchParams();
    if (val) qs.set('intent', val);
    if (d.linkedOnly) qs.set('linked', '1');
    if (d.q) qs.set('q', d.q);
    return `<a href="/messages${qs.toString() ? '?' + qs : ''}" class="px-2.5 py-1 rounded-full text-xs ${cls}">${label}</a>`;
  };
  const linkedToggleQs = new URLSearchParams();
  if (d.intent) linkedToggleQs.set('intent', d.intent);
  if (!d.linkedOnly) linkedToggleQs.set('linked', '1');
  if (d.q) linkedToggleQs.set('q', d.q);

  return `
  <div class="mb-3">
    <input type="search" name="q" value="${escapeHtml(d.q || '')}"
           placeholder="Search messages…"
           hx-get="/messages" hx-trigger="input changed delay:250ms" hx-target="#messages-list" hx-swap="outerHTML"
           hx-push-url="true" autocomplete="off"
           class="w-full px-3 py-2 text-sm border rounded-lg bg-white focus:outline-none focus:border-slate-400">
  </div>
  <div class="mb-3 flex items-center gap-2 flex-wrap">
    ${intents.map(intentChip).join('')}
    <a href="/messages?${linkedToggleQs}" class="ml-2 px-2.5 py-1 rounded-full text-xs ${d.linkedOnly ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.linkedOnly ? '✓ Linked only' : '🔗 Linked only'}</a>
  </div>
  <div id="messages-list" class="bg-white rounded-lg border">
    <div class="px-4 py-2 border-b flex items-center justify-between">
      <span class="text-xs text-slate-500">${d.rows.length} message${d.rows.length === 1 ? '' : 's'}</span>
    </div>
    <ul class="divide-y">
      ${d.rows.length ? d.rows.map(r => `
        <li class="px-4 py-2 flex items-start gap-3">
          <div class="text-xs text-slate-500 shrink-0 w-32">${new Date(r.ts * 1000).toLocaleString()}</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs text-slate-500">${escapeHtml(r.push_name || r.participant_jid)} <span class="text-slate-300">→</span> ${escapeHtml(r.remote_jid)}${r.classified_intent ? `<span class="ml-2 inline-flex items-center px-1 rounded text-[10px] bg-slate-200">${r.classified_intent}</span>` : ''}</div>
            <div class="text-sm">${escapeHtml((r.text || '<media>').slice(0, 240))}</div>
            ${r.linked_backlog_id ? `<a href="/backlog?source=${r.linked_backlog_source}#b-${r.linked_backlog_id}" class="text-[10px] text-blue-600 hover:underline">→ #${r.linked_backlog_id}: ${escapeHtml((r.linked_backlog_title || '').slice(0, 60))}</a>` : ''}
          </div>
        </li>`).join('') : '<li class="px-4 py-6 text-center text-sm text-slate-500">No messages match.</li>'}
    </ul>
  </div>`;
}
