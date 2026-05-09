import type { BacklogItem, BacklogSource } from '../db/repos/BacklogRepo.js';
import type { TasklistRow, TasklistItem } from '../db/repos/TasklistsRepo.js';
import type { TeamMember } from '../db/repos/TeamRepo.js';
import type { EodSession, EodAnswer } from '../db/repos/EodRepo.js';
import type { PendingOutbound, OutboundKind } from '../db/repos/OutboundQueueRepo.js';
import type { PendingSheetEdit } from '../db/repos/SheetEditQueueRepo.js';
import type { MrReview, MrReviewSuggestion } from '../db/repos/MrReviewsRepo.js';
import type { SuggestionWithMembers } from '../db/repos/FeatureSuggestionsRepo.js';
import type { MemberFeedback } from '../db/repos/MemberFeedbackRepo.js';
import { renderMarkdown } from '../utils/markdown.js';

const SOURCE_LABEL: Record<BacklogSource, string> = {
  sheet: '📋 Sheet',
  gitlab: '🔀 GitLab',
  wa_task: '✅ WA Task',
  wa_connect: '📞 Connect',
  wa_task_update: '🔁 Update',
  wa_status_check: '❓ Status?',
  wa_mention_unreplied: '🔔 Unreplied',
  feature: '🧩 Feature',
  manual: '✍️ Manual',
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
  feature:              'bg-purple-50 text-purple-800 border border-purple-200',
  manual:               'bg-emerald-50 text-emerald-800 border border-emerald-200',
};

// Universal Cmd+K command palette. Static actions (nav + common ops) are
// listed inline and filtered client-side. The "Backlog items" section fetches
// matching items via HTMX from /palette/search as the user types — bounded
// at 20 results to keep the modal light.
function paletteModal(): string {
  const actions = [
    { label: 'Today',           href: '/',            kbd: 'g h', icon: '🏠' },
    { label: 'Backlog',         href: '/backlog',     kbd: 'g b', icon: '📋' },
    { label: 'Backlog (mine)',  href: '/backlog?mine=1',          icon: '👤' },
    { label: 'Backlog (sheet)', href: '/backlog?source=sheet',    icon: '📋' },
    { label: 'Backlog (gitlab MRs)', href: '/backlog?source=gitlab', icon: '🔀' },
    { label: 'Backlog (features)',  href: '/backlog?source=feature',  icon: '🧩' },
    { label: 'Connects waiting', href: '/backlog?source=wa_connect', icon: '📞' },
    { label: 'Unreplied mentions', href: '/backlog?source=wa_mention_unreplied', icon: '🔔' },
    { label: 'Team',            href: '/team',        kbd: 'g t', icon: '📊' },
    { label: 'Approvals (pending)', href: '/approvals', kbd: 'g o', icon: '📤' },
    { label: 'Approvals — WhatsApp only', href: '/approvals?kind=outbound', icon: '💬' },
    { label: 'Approvals — Sheet edits only', href: '/approvals?kind=sheet', icon: '📋' },
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

export function layout(opts: { title: string; body: string; active?: 'home' | 'backlog' | 'messages' | 'approvals' | 'team' | 'admin' | 'about'; selectedDate?: string; pinnedToday?: BacklogItem[]; pendingApprovalsCount?: number }): string {
  const pinned = opts.pinnedToday || [];
  const pendingCount = opts.pendingApprovalsCount || 0;
  const navLink = (href: string, label: string, key: string, kbd?: string) => {
    const base = 'px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center whitespace-nowrap';
    const cls = opts.active === key
      ? `${base} bg-slate-900 text-white`
      : `${base} text-slate-600 hover:bg-slate-200`;
    const kbdHtml = kbd ? `<kbd class="ml-1.5 px-1 py-0 text-[9px] font-mono bg-slate-200/60 text-slate-500 rounded border border-slate-300/40 whitespace-nowrap">${kbd.replace(/ /g, ' ')}</kbd>` : '';
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
        ${pinned.map(i => `<a href="/task/${i.id}" class="shrink-0 text-xs px-2 py-0.5 rounded bg-white border border-emerald-200 text-slate-700 hover:bg-emerald-100" title="${escapeHtml(i.title)}">${escapeHtml(i.title.slice(0, 50))}${i.title.length > 50 ? '…' : ''}</a>`).join('')}
      </div>
    </div>` : '';

  const outboundRail = pendingCount > 0 && opts.active !== 'approvals' ? `
    <div class="border-b bg-amber-50 sticky ${pinned.length ? 'top-[68px]' : 'top-12'} z-[4]">
      <div class="max-w-6xl mx-auto px-4 py-1 text-xs text-amber-900 flex items-center justify-between">
        <span>${pendingCount} item${pendingCount === 1 ? '' : 's'} pending your approval</span>
        <a href="/approvals" class="text-amber-800 hover:underline font-medium">Review →</a>
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
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif} kbd{line-height:1}
    /* HTMX in-flight feedback. htmx adds .htmx-request to the triggering element
       (and to elements named via hx-indicator) for the duration of the request. */
    @keyframes htmx-spin { to { transform: rotate(360deg); } }
    .htmx-request{ position:relative; pointer-events:none; opacity:0.65; cursor:wait; }
    .htmx-request::after{
      content:''; display:inline-block; width:0.85em; height:0.85em;
      margin-left:0.5em; vertical-align:-0.15em;
      border:2px solid currentColor; border-right-color:transparent; border-radius:50%;
      animation: htmx-spin 0.6s linear infinite;
    }
    /* Forms shouldn't grow a spinner on the form itself — only the button does. */
    form.htmx-request::after{ display:none; }
    form.htmx-request{ opacity:1; pointer-events:auto; cursor:auto; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <header class="border-b bg-white sticky top-0 z-10">
    <div class="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-3 shrink-0">
        <a href="/" class="font-semibold text-lg">machine</a>
        ${datePicker}
      </div>
      <nav class="flex gap-1.5 items-center flex-wrap justify-end">
        ${navLink('/', 'Today', 'home', 'g h')}
        ${navLink('/backlog', 'Backlog', 'backlog', 'g b')}
        ${navLink('/team', 'Team', 'team', 'g t')}
        ${navLink('/approvals', 'Approvals', 'approvals', 'g o')}
        ${navLink('/messages', 'Messages', 'messages', 'g m')}
        ${navLink('/admin/jobs', 'Admin', 'admin')}
        ${navLink('/about', 'About', 'about')}
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
          const map = { h: '/', b: '/backlog', s: '/team', t: '/team', o: '/outbound', m: '/messages' };
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
  tasklistsByJid: Map<string, TasklistRow>;
  eodSession: EodSession | null;
  eodAnswers: EodAnswer[];
  backlogBySource: Record<BacklogSource, number>;
  pendingApprovalsCount: number;
  todaysConnects: BacklogItem[];
  myMissingEtaCount: number;
  eodPanel: EodPanelData | null;
  topBacklogScored: TopBacklogEntry[];   // already filtered (no signals) + scored
  todaysPlan: BacklogItem[];             // pinned for today
  completedToday: BacklogItem[];         // pinned for today and resolved
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

  const allSources: BacklogSource[] = ['sheet', 'gitlab', 'wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied', 'feature', 'manual'];
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

  // Manual-add form (appended into the list on submit via HTMX). Used both in
  // the populated and empty states so adding always works from the dashboard.
  const addManualForm = `
    <form hx-post="/backlog/manual" hx-target="#todays-plan-list" hx-swap="beforeend"
          hx-on::after-request="if(event.detail.successful){this.reset()}"
          class="mt-3 flex flex-col gap-2 p-2 rounded border border-emerald-200 bg-white">
      <input name="title" required placeholder="Add a task to today's plan…"
             class="text-sm px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-emerald-400" />
      <input name="description" placeholder="Description (optional)"
             class="text-xs px-2 py-1 border rounded text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-400" />
      <div class="flex gap-2">
        <input name="expected_outcome" placeholder="Expected outcome (optional)"
               class="flex-1 text-xs px-2 py-1 border rounded text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-400" />
        <button type="submit" class="text-xs px-3 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-800">+ Add</button>
      </div>
    </form>`;

  // Today's plan — pinned items (or CTA to backlog). Always shows the manual
  // add form so the user can drop in tasks even when nothing is pinned yet.
  const todaysPlanHtml = `
    <div class="mb-4 bg-emerald-50 border border-emerald-200 rounded-lg p-4">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-emerald-700">📌 Today's plan (${d.todaysPlan.length})</h2>
        <a href="/backlog" class="text-xs text-emerald-800 hover:underline">Pin from backlog →</a>
      </div>
      <ul id="todays-plan-list" class="divide-y divide-emerald-200">
        ${d.todaysPlan.map(i => todaysPlanRow(i)).join('')}
      </ul>
      ${d.todaysPlan.length ? '' : '<div class="text-xs text-slate-500 italic">Nothing pinned yet.</div>'}
      ${addManualForm}
    </div>`;

  // Completed today — items whose pinned_for_date is the selected date and
  // status='resolved'. Persistent record of the day's wins, even after they
  // leave the active plan.
  const completedTodayHtml = d.completedToday.length ? `
    <div class="mb-4 bg-white border rounded-lg p-3">
      <details>
        <summary class="text-xs font-semibold uppercase tracking-wide text-slate-500 cursor-pointer flex items-center justify-between">
          <span>✅ Completed ${d.isToday ? 'today' : `on ${escapeHtml(d.date)}`} (${d.completedToday.length})</span>
          <span class="text-slate-400">▾</span>
        </summary>
        <ul class="mt-2 divide-y divide-slate-100">
          ${d.completedToday.map(i => `
            <li class="py-1.5 flex items-start gap-3">
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
              <a href="/task/${i.id}" class="flex-1 min-w-0 text-sm text-slate-600 line-through hover:no-underline hover:text-slate-900 truncate">${escapeHtml(i.title)}</a>
            </li>`).join('')}
        </ul>
      </details>
    </div>` : '';

  // Outbound banner now lives in layout's sticky outboundRail (visible on every
  // page, not just /). Keep an empty placeholder here so the dashboard layout
  // doesn't need restructuring further.
  const outboundBanner = '';

  // Compact "team status" sidebar (right column)
  const submittedMembers = d.members.filter(m => !m.excludeFromTasklist && d.submittedJids.has(m.jid));
  const renderTasklistItems = (row: TasklistRow): string => {
    let items: TasklistItem[] = [];
    try { items = JSON.parse(row.items_json) as TasklistItem[]; } catch { /* fall back to raw */ }
    if (items.length) {
      return `<ul class="mt-1 space-y-0.5 text-xs text-slate-700 list-disc pl-4">
        ${items.map(it => `<li>${escapeHtml(it.text)}${it.est_hours != null ? ` <span class="text-slate-400">(${it.est_hours}h)</span>` : ''}</li>`).join('')}
      </ul>`;
    }
    return `<pre class="mt-1 text-xs text-slate-700 whitespace-pre-wrap font-sans">${escapeHtml(row.raw_text)}</pre>`;
  };
  const tasklistCard = `
    <div class="bg-white rounded-lg border p-3">
      <div class="flex items-baseline justify-between">
        <span class="text-xs uppercase tracking-wide text-slate-500">Tasklists${d.isToday ? '' : ` (${escapeHtml(d.date)})`}</span>
        <span class="text-lg font-semibold tabular-nums">${submittedCount}<span class="text-xs text-slate-400">/${totalMembers}</span></span>
      </div>
      ${submittedMembers.length ? `<div class="mt-2 divide-y divide-slate-100">
        ${submittedMembers.map(m => {
          const row = d.tasklistsByJid.get(m.jid);
          if (!row) return '';
          return `<details class="py-1.5 group">
            <summary class="flex items-center justify-between cursor-pointer list-none text-xs">
              <span class="font-medium text-slate-700">${escapeHtml(m.name || m.jid.split('@')[0])}</span>
              <span class="text-slate-400 group-open:rotate-90 transition-transform">▸</span>
            </summary>
            ${renderTasklistItems(row)}
          </details>`;
        }).join('')}
      </div>` : ''}
      ${pendingMembers.length
        ? `<div class="mt-2 pt-2 ${submittedMembers.length ? 'border-t' : ''}">
            <div class="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Pending</div>
            <div class="flex flex-wrap gap-1">${pendingMembers.map(memberPill).join('')}</div>
          </div>`
        : (submittedMembers.length ? '' : '<div class="mt-1 text-xs text-emerald-600">All in ✓</div>')}
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

  // Wrapped in a div the HTMX poll replaces every 30s
  const inner = `
  <div id="dash" hx-get="/?_partial=1${d.selectedDate && !d.isToday ? `&date=${d.selectedDate}` : ''}" hx-trigger="every 30s" hx-swap="outerHTML">
    ${outboundBanner}

    <div class="grid lg:grid-cols-3 gap-4">
      <!-- LEFT: action items (2 cols) -->
      <div class="lg:col-span-2 space-y-4">
        ${todaysPlanHtml}
        ${completedTodayHtml}
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
      </div>
    </div>
  </div>`;

  return d.partial ? inner : inner;
}

export interface BacklogData {
  items: BacklogItem[];
  source: BacklogSource | 'all';
  devOnly: boolean;
  linksByItemId?: Map<number, BacklogRowLinks>;
  q?: string;
  mine?: boolean;
  missingEta?: boolean;
  sort?: string;
  showSnoozed?: boolean;
  etaBefore?: string;        // YYYY-MM-DD; items with parseable ETA on/before this date
  saturdayThisWeek?: string; // YYYY-MM-DD; default cutoff for the "ship this week" chip
}

function buildBacklogQs(d: BacklogData, override: Partial<{
  source: string; dev: string; mine: string; q: string; missing_eta: string; sort: string; snoozed: string; eta_before: string;
}> = {}): string {
  const params: Record<string, string> = {};
  if (d.source !== 'all') params.source = d.source;
  if (d.devOnly) params.dev = '1';
  if (d.mine) params.mine = '1';
  if (d.q) params.q = d.q;
  if (d.missingEta) params.missing_eta = '1';
  if (d.sort) params.sort = d.sort;
  if (d.showSnoozed) params.snoozed = '1';
  if (d.etaBefore) params.eta_before = d.etaBefore;
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
  const mineChip = `<a href="/backlog${buildBacklogQs(d, { mine: d.mine ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.mine ? 'bg-sky-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.mine ? '✓ Mine' : 'Mine only'}</a>`;
  const missingEtaChip = `<a href="/backlog${buildBacklogQs(d, { missing_eta: d.missingEta ? '' : '1' })}" class="px-3 py-1 rounded-full text-xs ${d.missingEta ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${d.missingEta ? '✓ No ETA' : '⚠ No ETA'}</a>`;

  // Generic ETA cutoff filter — `eta_before=YYYY-MM-DD` shows only items whose
  // parseable sheet ETA is on/before that date. Default chip cutoff is this
  // week's Saturday (set by the route); when an out-of-default value is in use,
  // we surface the actual date instead so it's never confusing.
  const satDate = d.saturdayThisWeek || '';
  const etaBeforeActive = !!d.etaBefore;
  const etaBeforeIsDefault = d.etaBefore === satDate;
  const etaBeforeChipLabel = etaBeforeActive
    ? `✓ ETA ≤ ${etaBeforeIsDefault ? 'Sat' : escapeHtml(d.etaBefore!)}`
    : '🚀 Ship this week';
  const etaBeforeChip = `<a href="/backlog${buildBacklogQs(d, { eta_before: etaBeforeActive ? '' : satDate })}" title="${etaBeforeActive ? 'Clear ETA cutoff' : `Show items with ETA on or before Sat ${escapeHtml(satDate)}`}" class="px-3 py-1 rounded-full text-xs ${etaBeforeActive ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${etaBeforeChipLabel}</a>`;

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
      <button hx-get="/features/bulk-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              hx-vals='js:{ids: document.getElementById("bulk-ids").value}'
              class="text-xs px-2 py-1 rounded bg-purple-600 hover:bg-purple-700">🧩 Add to feature…</button>
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

  // Three top-level groups (GitLab / Sheet / WhatsApp) + a Feature peer.
  // WhatsApp expands into its 5 sub-types only when a wa_* source is active.
  const WA_SUBS: BacklogSource[] = ['wa_task', 'wa_connect', 'wa_task_update', 'wa_status_check', 'wa_mention_unreplied'];
  const isWaActive = WA_SUBS.includes(d.source as BacklogSource);
  // Clicking WhatsApp parent picks a default sub (wa_task). Clicking again
  // (i.e. when already in a wa_* sub) collapses back to All.
  const waParentTarget = isWaActive ? 'all' : 'wa_task';
  return `
  ${bulkToolbar}
  ${searchBar}
  <div class="mb-2 flex items-center gap-2 flex-wrap">
    ${filterChip('all', 'All', d.source === 'all')}
    ${filterChip('gitlab', SOURCE_LABEL.gitlab, d.source === 'gitlab')}
    ${filterChip('sheet', SOURCE_LABEL.sheet, d.source === 'sheet')}
    ${filterChip(waParentTarget, '💬 WhatsApp', isWaActive)}
    ${filterChip('feature', SOURCE_LABEL.feature, d.source === 'feature')}
    <span class="ml-2">${mineChip}</span>
    <span>${missingEtaChip}</span>
    <span>${etaBeforeChip}</span>
    <span>${devChip}</span>
    <span class="ml-auto flex items-center gap-1">
      <span class="text-[10px] text-slate-400 uppercase">sort</span>
      ${(['recent','oldest','eta','priority'] as const).map(s => {
        const cls = (d.sort || 'recent') === s ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700 hover:bg-slate-300';
        return `<a href="/backlog${buildBacklogQs(d, { sort: s === 'recent' ? '' : s })}" class="px-2 py-0.5 rounded-full text-[10px] ${cls}">${s}</a>`;
      }).join('')}
      <a href="/backlog${buildBacklogQs(d, { snoozed: d.showSnoozed ? '' : '1' })}" class="ml-2 px-2 py-0.5 rounded-full text-[10px] ${d.showSnoozed ? 'bg-amber-100 text-amber-900' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">😴 ${d.showSnoozed ? 'incl. snoozed' : 'show snoozed'}</a>
      <button hx-get="/features/new" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              title="Create a new feature (manual grouping)"
              class="ml-2 px-2 py-0.5 rounded-full text-[10px] bg-purple-600 text-white hover:bg-purple-700">+ 🧩 Feature</button>
    </span>
  </div>
  ${isWaActive ? `
  <div class="mb-4 ml-4 pl-3 border-l-2 border-slate-300 flex items-center gap-2 flex-wrap">
    ${WA_SUBS.map(sub => filterChip(sub, SOURCE_LABEL[sub], d.source === sub)).join('\n    ')}
  </div>` : `<div class="mb-4"></div>`}
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

// Source-specific status pills (priority/assignee/ETA/sprint/branch/author).
// Shared between the backlog row (triage) and the task detail page (workspace).
function metadataPills(i: BacklogItem): string[] {
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
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
  return pills;
}

export function backlogRow(i: BacklogItem, links?: BacklogRowLinks): string {
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
  const devBadge = i.is_dev_task === 1
    ? '<span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">dev</span>'
    : '';

  const pills = metadataPills(i);
  const latestUpdate = i.source === 'sheet' ? latestSheetUpdate(meta) : '';

  // Feature progress: resolved children / total. For features only — used by
  // both the row pill and the page header so it stays consistent.
  const isFeatureRow = i.source === 'feature';
  const allChildren = links?.children || [];
  const featureDone = isFeatureRow ? allChildren.filter(c => c.status === 'resolved').length : 0;
  const featureTotal = isFeatureRow ? allChildren.length : 0;
  const featureProgressChip = isFeatureRow
    ? `<span class="text-[10px] px-1.5 py-0.5 rounded ${featureTotal > 0 && featureDone === featureTotal ? 'bg-emerald-100 text-emerald-800' : 'bg-purple-100 text-purple-800'}">${featureDone}/${featureTotal} done</span>`
    : '';

  const linkChips: string[] = [];
  if (links?.children?.length && !isFeatureRow) {
    // For sheet/wa_task rows: show MR children as orange chips.
    for (const c of links.children) {
      const label = c.source === 'gitlab' ? '🔀 MR' : SOURCE_LABEL[c.source];
      linkChips.push(`<a href="${c.url ? escapeHtml(c.url) : '#'}" target="_blank" title="${escapeHtml(c.title)}" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-orange-50 text-orange-700 hover:bg-orange-100">${label}: ${escapeHtml(c.title.slice(0, 60))}</a>`);
    }
  } else if (links?.children?.length && isFeatureRow) {
    // For feature rows: show member chips (color-coded by their source).
    for (const c of links.children) {
      const strike = c.status === 'resolved' ? 'line-through opacity-60' : '';
      linkChips.push(`<a href="/task/${c.id}" title="${escapeHtml(c.title)}" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[c.source]} hover:opacity-80 ${strike}">${SOURCE_LABEL[c.source]}: ${escapeHtml(c.title.slice(0, 50))}</a>`);
    }
  }
  if (links?.parents?.length) {
    for (const p of links.parents) {
      // Feature parents get a distinct purple chip so the grouping is visible.
      if (p.source === 'feature') {
        linkChips.push(`<a href="/task/${p.id}" title="${escapeHtml(p.title)}" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-800 hover:bg-purple-200">🧩 ${escapeHtml(p.title.slice(0, 60))}</a>`);
        continue;
      }
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
      ${(pills.length || featureProgressChip) ? `<div class="mt-1 flex items-center gap-1.5 flex-wrap">${featureProgressChip}${pills.join('')}${snoozeChip}</div>` : (snoozeChip ? `<div class="mt-1">${snoozeChip}</div>` : '')}
      ${i.description ? `<div class="text-xs text-slate-500 mt-1 line-clamp-2">${escapeHtml(i.description.slice(0, 240))}</div>` : ''}
      ${latestUpdate ? `<div class="text-xs text-slate-600 mt-1 italic line-clamp-1">↪ ${escapeHtml(latestUpdate.slice(0, 200))}</div>` : ''}
      ${noteBlock}
      <div class="mt-1.5 flex items-center gap-2 flex-wrap">
        <a href="/task/${i.id}" class="text-xs px-2 py-0.5 rounded bg-slate-900 text-white hover:bg-slate-800">→ Open</a>
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">source ↗</a>` : ''}
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
              ${isFeatureRow && featureTotal === 0 ? `hx-confirm="This feature has no tasks or MRs attached. Resolve anyway?"` : (isFeatureRow ? `hx-confirm="Resolving this feature will also resolve its ${featureTotal - featureDone} open task(s)/MR(s). Continue?"` : '')}
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
  const desc = i.description ? `<div class="text-xs text-slate-500 truncate">${escapeHtml(i.description)}</div>` : '';
  const goal = i.expected_outcome ? `<div class="text-[11px] text-emerald-700 truncate">🎯 ${escapeHtml(i.expected_outcome)}</div>` : '';
  return `
  <li id="tp-${i.id}" class="py-2">
    <div class="flex items-start gap-3">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0">${SOURCE_LABEL[i.source]}</span>
      <div class="flex-1 min-w-0">
        <a href="/task/${i.id}" class="text-sm font-medium hover:underline">${escapeHtml(i.title)}</a>
        ${i.url ? ` <a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">source ↗</a>` : ''}
        ${desc}
        ${goal}
      </div>
      <button hx-post="/backlog/${i.id}/resolve" hx-target="#tp-${i.id}" hx-swap="delete"
              title="Mark done — moves to Completed"
              class="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">✓ Done</button>
      <a href="/task/${i.id}" class="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">→ Open</a>
      <button hx-post="/backlog/${i.id}/unpin" hx-target="#tp-${i.id}" hx-swap="delete"
              title="Remove from today's plan"
              class="text-xs px-2 py-1 rounded bg-slate-200 text-slate-600 hover:bg-slate-300">✕</button>
    </div>
  </li>`;
}

// ─── Phase pill + actionables panel ─────────────────────────────────────────

import type { Phase, BacklogActionable } from '../db/repos/BacklogActionableRepo.js';
import { PHASE_LABEL, PHASE_COLOR, PHASES } from '../lib/phase.js';

export function phasePill(itemId: number, current: Phase): string {
  // Click to cycle through phases. Right-click clears the override (back to inferred).
  const idx = PHASES.indexOf(current);
  const next = PHASES[(idx + 1) % PHASES.length];
  return `<span class="inline-flex items-center gap-1 shrink-0">
    <button hx-post="/backlog/${itemId}/phase-override?phase=${next}"
            hx-target="#act-panel-${itemId}" hx-swap="outerHTML"
            title="SDLC phase — click to advance, ✕ to reset to inferred"
            class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${PHASE_COLOR[current]} hover:opacity-80">${PHASE_LABEL[current]}</button>
  </span>`;
}

export function actionableRow(a: BacklogActionable, outboundStatus?: string): string {
  const targetIcon = a.target === 'self' ? '' :
    a.target === 'mr_author' ? '<span class="text-[10px] text-slate-400" title="routes to MR author">→ author</span>' :
    '<span class="text-[10px] text-slate-400" title="routes to owner">→ owner</span>';
  const sentBadge = a.pending_outbound_id
    ? `<span class="text-[10px] px-1 py-0.5 rounded bg-slate-100 text-slate-600">${escapeHtml(outboundStatus || 'queued')}</span>`
    : '';
  const sendBtn = a.target !== 'self' && !a.pending_outbound_id
    ? `<button hx-post="/backlog/${a.backlog_id}/actionable/${a.id}/send"
              hx-target="#act-row-${a.id}" hx-swap="outerHTML"
              title="Draft outbound message → /approvals"
              class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200">send</button>`
    : '';
  // Any checklist item can be deleted (custom or seeded). Seeded items will simply
  // re-seed on the next visit if their phase still applies; deleting is therefore
  // a "hide for now" gesture for templates and a "remove" for custom rows.
  const delBtn = `<button hx-delete="/backlog/${a.backlog_id}/actionable/${a.id}"
              hx-target="#act-row-${a.id}" hx-swap="delete"
              hx-confirm="Delete this actionable?"
              title="Delete"
              class="text-[10px] text-slate-400 hover:text-red-600">✕</button>`;
  return `<div id="act-row-${a.id}" class="flex items-start gap-2 py-0.5 text-xs ${a.is_done ? 'opacity-60' : ''}">
    <input type="checkbox" ${a.is_done ? 'checked' : ''}
           hx-post="/backlog/${a.backlog_id}/actionable/${a.id}/toggle"
           hx-target="#act-row-${a.id}" hx-swap="outerHTML"
           class="mt-0.5 shrink-0">
    <div class="flex-1 ${a.is_done ? 'line-through text-slate-500' : 'text-slate-700'} prose-sm break-words">${renderMarkdown(a.text)}</div>
    ${targetIcon}
    ${sentBadge}
    ${sendBtn}
    ${delBtn}
  </div>`;
}

export function actionablesPanel(opts: {
  itemId: number;
  source: BacklogSource;
  currentPhase: Phase;
  actionables: BacklogActionable[];
  outboundStatusById?: Record<number, string>;
}): string {
  const grouped = new Map<Phase, BacklogActionable[]>();
  for (const a of opts.actionables) {
    const arr = grouped.get(a.phase as Phase) || [];
    arr.push(a);
    grouped.set(a.phase as Phase, arr);
  }
  // Render phases in canonical order; only include phases that have any actionable.
  const sections = PHASES
    .filter(p => (grouped.get(p)?.length ?? 0) > 0)
    .map(p => {
      const isCurrent = p === opts.currentPhase;
      const rows = (grouped.get(p) || [])
        .map(a => actionableRow(a, opts.outboundStatusById?.[a.pending_outbound_id ?? -1]))
        .join('');
      return `<details ${isCurrent ? 'open' : ''} class="border-l-2 ${isCurrent ? 'border-emerald-400' : 'border-slate-200'} pl-2">
        <summary class="cursor-pointer text-[11px] font-medium text-slate-500 hover:text-slate-800">
          ${PHASE_LABEL[p]} <span class="text-slate-400 font-normal">(${(grouped.get(p) || []).length})</span>
        </summary>
        <div class="mt-1 space-y-0.5">${rows}</div>
      </details>`;
    }).join('');

  return `<div id="act-panel-${opts.itemId}" class="border border-slate-200 rounded p-2 bg-slate-50/40">
    <div class="flex items-center justify-between mb-1.5">
      <div class="flex items-center gap-2">
        ${phasePill(opts.itemId, opts.currentPhase)}
        <span class="text-[10px] text-slate-400">SDLC checklist</span>
      </div>
      <button onclick="document.getElementById('add-act-${opts.itemId}').classList.toggle('hidden')"
              class="text-[10px] text-slate-500 hover:text-slate-800">+ add</button>
    </div>
    ${sections || '<div class="text-[11px] text-slate-400 italic px-2 py-1">no actionables yet</div>'}
    <form id="add-act-${opts.itemId}" class="hidden mt-2 flex flex-col gap-1"
          hx-post="/backlog/${opts.itemId}/actionable" hx-target="#act-panel-${opts.itemId}" hx-swap="outerHTML">
      <textarea name="text" rows="2" placeholder="e.g. Request demo video — markdown ok (tables, **bold**, [links](…))" required
                class="text-xs border rounded px-2 py-1 outline-none focus:border-slate-400 font-mono"></textarea>
      <div class="flex gap-1 items-center justify-end">
        <select name="target" class="text-xs border rounded px-1 py-0.5 bg-white">
          <option value="self">self</option>
          <option value="owner">→ owner</option>
          <option value="mr_author">→ MR author</option>
        </select>
        <input type="hidden" name="phase" value="${opts.currentPhase}">
        <button type="submit" class="text-xs px-2 py-0.5 rounded bg-slate-900 text-white hover:bg-slate-800">add</button>
      </div>
    </form>
  </div>`;
}

export function resolvedRow(i: BacklogItem): string {
  return `<li id="b-${i.id}" class="px-4 py-3 text-sm text-slate-400 italic">✓ Resolved: ${escapeHtml(i.title)}</li>`;
}

// ----- /task/:id detail page -----

export interface TaskReviewSummary {
  id: number;
  status: string;
  mrTitle: string;
  mrBacklogId: number | null;
}

export interface TaskDetailData {
  item: BacklogItem;
  links: BacklogRowLinks;
  actionablesPanelHtml: string;     // pre-rendered via renderActionablesPanel(itemId)
  reviews: TaskReviewSummary[];     // mr_reviews for this item (or its linked MR children)
  // For feature pages: MRs attached to a child sheet/wa_task, keyed by child id.
  // Lets the feature page show "this feature's full MR list" without the user
  // having to click into each task to find them.
  subMrsByChildId?: Map<number, BacklogItem[]>;
}

export function taskDetailPage(d: TaskDetailData): string {
  const i = d.item;
  const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
  const isPinnedToday = i.pinned_for_date === istDateStringNow();
  const devBadge = i.is_dev_task === 1
    ? '<span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">dev</span>'
    : '';
  const pills = metadataPills(i);
  const latestUpdate = i.source === 'sheet' ? latestSheetUpdate(meta) : '';

  // Feature items render their children as a flat "members" list — don't split
  // out MRs separately (a feature is the grouping itself).
  const isFeature = i.source === 'feature';
  const linkedMrs = isFeature ? [] : (d.links.children || []).filter(c => c.source === 'gitlab');
  const featureMembers = isFeature ? (d.links.children || []) : [];
  const otherChildren = isFeature ? [] : (d.links.children || []).filter(c => c.source !== 'gitlab');
  const parents = d.links.parents || [];

  const pinBtn = isPinnedToday
    ? `<button hx-post="/backlog/${i.id}/unpin" hx-target="#task-status-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200">📌 Unpin from today</button>`
    : `<button hx-post="/backlog/${i.id}/pin" hx-target="#task-status-${i.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">📌 Pin to today</button>`;

  const description = i.description
    ? `<div class="mt-2 text-sm text-slate-600 whitespace-pre-wrap">${escapeHtml(i.description)}</div>`
    : '';

  const updateBlock = latestUpdate
    ? `<div class="mt-2 text-sm text-slate-700 italic">↪ ${escapeHtml(latestUpdate)}</div>`
    : '';

  const noteBlock = `
    <form hx-post="/backlog/${i.id}/note" hx-target="#task-note-${i.id}" hx-swap="outerHTML"
          id="task-note-${i.id}"
          class="mt-3 flex gap-2 items-start">
      <textarea name="note" rows="2" placeholder="PM note (free text)…"
                class="flex-1 text-xs border rounded px-2 py-1 outline-none focus:border-slate-400">${escapeHtml(i.pm_note || '')}</textarea>
      <button type="submit" class="text-xs px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">Save note</button>
    </form>`;

  const linkedMrsBlock = linkedMrs.length ? `
    <section class="bg-white border rounded-lg p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🔀 Linked MRs (${linkedMrs.length})</h2>
      <ul class="divide-y">
        ${linkedMrs.map(c => `
          <li class="py-2 flex items-center gap-2">
            <a href="${c.url ? escapeHtml(c.url) : '#'}" target="_blank" class="flex-1 text-sm text-slate-700 hover:underline truncate">${escapeHtml(c.title)}</a>
            <a href="/task/${c.id}" class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">→ Open</a>
            <button hx-get="/mr-reviews/new?backlog_id=${c.id}" hx-target="#chat-modal-mount" hx-swap="innerHTML"
                    class="text-xs px-2 py-0.5 rounded bg-violet-600 text-white hover:bg-violet-700">🤖 Review</button>
            <button hx-post="/backlog/${i.id}/unlink-mr?mr=${c.id}" hx-target="closest li" hx-swap="outerHTML"
                    hx-confirm="Unlink this MR from the sheet task?"
                    class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-rose-100 hover:text-rose-700">remove</button>
          </li>`).join('')}
      </ul>
    </section>` : '';

  const reviewsBlock = d.reviews.length ? `
    <section class="bg-white border rounded-lg p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🤖 Code reviews (${d.reviews.length})</h2>
      <ul class="divide-y">
        ${d.reviews.map(r => `
          <li class="py-2 flex items-center gap-2 text-sm">
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 shrink-0">${escapeHtml(r.status)}</span>
            <a href="/mr-reviews/${r.id}" class="flex-1 text-slate-700 hover:underline truncate">${escapeHtml(r.mrTitle)}</a>
          </li>`).join('')}
      </ul>
    </section>` : '';

  // Aggregate progress: count both direct members and transitive MRs.
  const subMrs = d.subMrsByChildId;
  const allFeatureItems: BacklogItem[] = isFeature
    ? featureMembers.flatMap(c => [c, ...((subMrs?.get(c.id)) || [])])
    : [];
  const featureDoneTotal = allFeatureItems.filter(c => c.status === 'resolved').length;
  const renderMemberRow = (c: BacklogItem, indent = false): string => {
    const strike = c.status === 'resolved' ? 'line-through text-slate-400' : '';
    const removeBtn = indent ? '' :
      `<button hx-post="/features/${i.id}/remove?member=${c.id}" hx-target="closest li" hx-swap="outerHTML"
               class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-rose-100 hover:text-rose-700">remove</button>`;
    return `<li class="py-2 flex items-center gap-2 text-sm ${indent ? 'pl-6 bg-slate-50/50' : ''}">
      ${indent ? '<span class="text-slate-300 text-xs">↳</span>' : ''}
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[c.source]} shrink-0">${SOURCE_LABEL[c.source]}</span>
      <a href="/task/${c.id}" class="flex-1 ${strike} hover:underline truncate">${escapeHtml(c.title)}</a>
      ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">↗</a>` : ''}
      ${c.status === 'resolved' ? '<span class="text-[10px] text-emerald-700">✓</span>' : ''}
      ${removeBtn}
    </li>`;
  };
  const featureMembersBlock = isFeature ? `
    <section class="bg-white border rounded-lg p-4">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500">🧩 Tasks &amp; MRs in this feature (${featureDoneTotal}/${allFeatureItems.length} done)</h2>
        <div class="flex items-center gap-2">
          <button hx-post="/features/${i.id}/pin-all" hx-target="#chat-modal-mount" hx-swap="innerHTML"
                  title="Pin every open task / MR in this feature to today's plan"
                  class="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">📌 Pin all open</button>
          <button hx-get="/backlog/${i.id}/link-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
                  class="text-xs px-2 py-0.5 rounded bg-slate-900 text-white hover:bg-slate-800">+ Add task / MR</button>
        </div>
      </div>
      ${featureMembers.length ? `<ul class="divide-y">
        ${featureMembers.map(c => {
          const subs = subMrs?.get(c.id) || [];
          return renderMemberRow(c) + subs.map(s => renderMemberRow(s, true)).join('');
        }).join('')}
      </ul>` : '<div class="text-xs text-slate-400 italic">Nothing in this feature yet. Use + Add task / MR to attach items.</div>'}
    </section>` : '';

  const otherLinksBlock = (otherChildren.length || parents.length) ? `
    <section class="bg-white border rounded-lg p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🔗 Linked items</h2>
      <ul class="space-y-1 text-sm">
        ${otherChildren.map(c => `<li>↳ <a href="/task/${c.id}" class="text-slate-700 hover:underline">${escapeHtml(SOURCE_LABEL[c.source])}: ${escapeHtml(c.title)}</a></li>`).join('')}
        ${parents.map(p => `<li>↩ <a href="/task/${p.id}" class="text-slate-700 hover:underline">${escapeHtml(SOURCE_LABEL[p.source])}: ${escapeHtml(p.title)}</a></li>`).join('')}
      </ul>
    </section>` : '';

  const reviewBtn = i.source === 'gitlab'
    ? `<button hx-get="/mr-reviews/new?backlog_id=${i.id}" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700">🤖 Launch review</button>`
    : '';
  const linkMrBtn = i.source === 'sheet'
    ? `<button hx-get="/backlog/${i.id}/link-mr-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800">🔀+ Link MR</button>`
    : '';
  const addMemberBtn = isFeature
    ? `<button hx-get="/backlog/${i.id}/link-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700">+ Add task / MR</button>`
    : '';
  const editFeatureBtn = isFeature
    ? `<button onclick="document.getElementById('feature-edit-form').classList.toggle('hidden')"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">✏️ Edit</button>`
    : '';
  const featureEditFormBlock = isFeature ? `
    <form id="feature-edit-form" class="hidden mt-3 pt-3 border-t space-y-2"
          hx-post="/features/${i.id}/edit"
          hx-on::after-request="if (event.detail.successful) { const loc = event.detail.xhr.getResponseHeader('HX-Redirect'); if (loc) location.href = loc; }">
      <label class="block text-[10px] uppercase tracking-wide text-slate-500">Title</label>
      <input type="text" name="title" value="${escapeHtml(i.title)}" required
             class="w-full px-2 py-1 text-sm border rounded outline-none focus:border-slate-400">
      <label class="block text-[10px] uppercase tracking-wide text-slate-500">Description</label>
      <textarea name="description" rows="3"
                class="w-full px-2 py-1 text-sm border rounded outline-none focus:border-slate-400">${escapeHtml(i.description || '')}</textarea>
      <div class="flex justify-end gap-2">
        <button type="button" onclick="document.getElementById('feature-edit-form').classList.add('hidden')"
                class="text-xs px-3 py-1 rounded text-slate-600 hover:bg-slate-100">Cancel</button>
        <button type="submit" class="text-xs px-3 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">Save</button>
      </div>
    </form>` : '';

  return `
  <div class="mb-4">
    <a href="/backlog" class="text-xs text-slate-500 hover:text-slate-800">← Backlog</a>
  </div>

  <header class="bg-white border rounded-lg p-4 mb-4">
    <div class="flex items-start gap-3">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[i.source]} shrink-0 mt-1">${SOURCE_LABEL[i.source]}</span>
      <div class="flex-1 min-w-0">
        <h1 class="text-lg font-semibold">${escapeHtml(i.title)}${devBadge}</h1>
        ${pills.length ? `<div class="mt-2 flex items-center gap-1.5 flex-wrap">${pills.join('')}</div>` : ''}
        ${description}
        ${updateBlock}
        ${noteBlock}
      </div>
      <div id="task-status-${i.id}" class="flex flex-col items-end gap-2 shrink-0">
        ${pinBtn}
        ${i.url ? `<a href="${escapeHtml(i.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">source ↗</a>` : ''}
      </div>
    </div>
    <div class="mt-3 pt-3 border-t flex items-center gap-2 flex-wrap">
      ${addMemberBtn}
      ${editFeatureBtn}
      ${reviewBtn}
      ${linkMrBtn}
      <button hx-post="/backlog/${i.id}/snooze?hours=24" hx-swap="none"
              hx-on::after-request="location.href='/backlog'"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">😴 Snooze 24h</button>
      <button hx-post="/backlog/${i.id}/resolve" hx-swap="none"
              hx-on::after-request="location.href='/backlog'"
              class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">✓ Resolve</button>
      <button hx-get="/backlog/${i.id}/timeline" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">📜 Timeline</button>
      <button hx-get="/backlog/${i.id}/chat" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">💬 Chat</button>
      <button hx-get="/backlog/${i.id}/link-modal" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">🔗 Link</button>
    </div>
    ${featureEditFormBlock}
  </header>

  <section class="bg-white border rounded-lg p-4 mb-4" id="goal-proof-${i.id}">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🎯 Goal &amp; proof</h2>
    <form hx-post="/backlog/${i.id}/goal-proof" hx-target="#goal-proof-${i.id}" hx-swap="outerHTML"
          class="grid grid-cols-1 sm:grid-cols-[1fr_18rem] gap-3 items-start">
      <div>
        <label class="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">End-goal expectation</label>
        <textarea name="expected_outcome" rows="3"
                  placeholder="What does &quot;done&quot; look like? Markdown ok."
                  class="w-full text-xs border rounded px-2 py-1 outline-none focus:border-slate-400 font-mono">${escapeHtml(i.expected_outcome || '')}</textarea>
        ${i.expected_outcome ? `<div class="mt-2 text-xs text-slate-700 prose-sm">${renderMarkdown(i.expected_outcome)}</div>` : ''}
      </div>
      <div>
        <label class="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Verifiable proof (URL)</label>
        <input type="url" name="proof_url" value="${escapeHtml(i.proof_url || '')}"
               placeholder="https://… (demo video, screenshot, doc)"
               class="w-full text-xs border rounded px-2 py-1 outline-none focus:border-slate-400 font-mono">
        ${i.proof_url ? `<a href="${escapeHtml(i.proof_url)}" target="_blank" class="mt-1 inline-block text-xs text-blue-600 hover:underline truncate max-w-full">↗ ${escapeHtml(i.proof_url)}</a>` : ''}
        <button type="submit" class="mt-2 text-xs px-3 py-1 rounded bg-slate-900 text-white hover:bg-slate-800">Save</button>
      </div>
    </form>
  </section>

  <section class="bg-white border rounded-lg p-4 mb-4">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">📋 SDLC actionables</h2>
    ${d.actionablesPanelHtml}
  </section>

  ${featureMembersBlock ? `<div class="mb-4">${featureMembersBlock}</div>` : ''}
  ${isFeature ? `<div class="mb-4" hx-get="/features/${i.id}/member-suggestions" hx-trigger="load" hx-swap="outerHTML"></div>` : ''}
  ${linkedMrsBlock ? `<div class="mb-4">${linkedMrsBlock}</div>` : ''}
  ${reviewsBlock ? `<div class="mb-4">${reviewsBlock}</div>` : ''}
  ${otherLinksBlock ? `<div class="mb-4">${otherLinksBlock}</div>` : ''}
  `;
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
  task_actionable:   '✅ Task actionable',
};
const KIND_COLOR: Record<OutboundKind, string> = {
  tasklist_nudge:    'bg-blue-100 text-blue-800',
  eod_check_in:      'bg-indigo-100 text-indigo-800',
  eod_summary:       'bg-purple-100 text-purple-800',
  eod_summary_dm:    'bg-purple-100 text-purple-800',
  weekly_summary_dm: 'bg-fuchsia-100 text-fuchsia-800',
  task_actionable:   'bg-emerald-100 text-emerald-800',
};

function recipientLabel(p: PendingOutbound, members: TeamMember[]): string {
  const m = members.find(mm => mm.jid === p.to_jid);
  if (m) return m.name || p.to_jid;
  // group jid? show last 6 chars of digit prefix to keep it short
  return p.to_jid.split('@')[0];
}

export function outboundCard(p: PendingOutbound, members: TeamMember[]): string {
  const recipient = recipientLabel(p, members);
  const ageMin = Math.max(0, Math.round((Date.now() - p.created_at) / 60000));
  const errorBanner = p.status === 'error' && p.error
    ? `<div class="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">⚠ ${escapeHtml(p.error)}</div>`
    : '';
  const ctx = p.context_json ? JSON.parse(p.context_json) as Record<string, unknown> : {};
  const ctxLine = Object.keys(ctx).length
    ? `<div class="text-[10px] text-slate-400 mt-1">${escapeHtml(Object.entries(ctx).filter(([k]) => !['dedupKey', 'candidates', 'missingJids', 'bodyTail', 'groupJid'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' • '))}</div>`
    : '';

  const header = `
    <div class="flex items-start justify-between mb-2 gap-3">
      <div>
        <div class="text-sm font-medium">→ ${escapeHtml(recipient)} <span class="text-xs text-slate-400 font-normal">${escapeHtml(p.to_jid)}</span></div>
        <div class="mt-1 flex items-center gap-2">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${KIND_COLOR[p.kind]}">${KIND_LABEL[p.kind]}</span>
          <span class="text-[10px] text-slate-400">${ageMin === 0 ? 'just now' : `${ageMin} min ago`}</span>
        </div>
        ${ctxLine}
      </div>
    </div>`;

  // Custom render for the tasklist nudge: checkboxes for each candidate so
  // Sid picks who actually gets tagged. Tag line is rebuilt server-side from
  // the checked set on submit.
  if (p.kind === 'tasklist_nudge'
      && Array.isArray((ctx as Record<string, unknown>).candidates)
      && (ctx as Record<string, unknown>).bodyTail !== undefined) {
    return tasklistNudgeCard(p, ctx as { candidates: Array<{ jid: string; name: string }>; missingJids?: string[]; bodyTail: string }, header, errorBanner);
  }

  return `
  <div id="ob-${p.id}" class="bg-white border rounded-lg p-4">
    ${errorBanner}
    ${header}
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

function tasklistNudgeCard(
  p: PendingOutbound,
  ctx: { candidates: Array<{ jid: string; name: string }>; missingJids?: string[]; bodyTail: string },
  header: string,
  errorBanner: string,
): string {
  const missingSet = new Set(ctx.missingJids || []);
  const checkboxes = ctx.candidates.map(c => {
    const checked = missingSet.has(c.jid);
    return `<label class="inline-flex items-center gap-1.5 px-2 py-1 rounded border ${checked ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'} text-xs cursor-pointer hover:bg-slate-50">
      <input type="checkbox" name="selected_jids" value="${escapeHtml(c.jid)}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(c.name)}</span>
    </label>`;
  }).join('');

  return `
  <div id="ob-${p.id}" class="bg-white border rounded-lg p-4">
    ${errorBanner}
    ${header}
    <form hx-post="/outbound/${p.id}/approve" hx-target="#ob-${p.id}" hx-swap="outerHTML">
      <div class="mb-2">
        <div class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Tag in this nudge</div>
        <div class="flex flex-wrap gap-1.5">${checkboxes}</div>
        <div class="text-[10px] text-slate-400 mt-1">Pre-checked = hadn't shared their tasklist as of noon. The @-tags will be rebuilt from this selection on submit.</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Message body (after the tags)</div>
        <textarea name="body_tail" rows="3"
                  class="w-full text-sm font-mono border rounded p-2 bg-slate-50 focus:bg-white focus:border-slate-400 outline-none">${escapeHtml(ctx.bodyTail)}</textarea>
      </div>
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
  const canResend = p.status === 'sent' || p.status === 'skipped';
  return `
  <div class="px-4 py-2 flex items-center gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${KIND_COLOR[p.kind]}">${KIND_LABEL[p.kind]}</span>
    <span class="text-xs text-slate-500 w-32 shrink-0">${new Date(when).toLocaleString()}</span>
    <span class="text-xs flex-1 truncate">→ ${escapeHtml(recipient)}: ${escapeHtml(p.body.slice(0, 80))}</span>
    <span class="text-[10px] ${statusColor} font-medium uppercase">${p.status}</span>
    ${canResend ? `<button hx-post="/outbound/${p.id}/resend" hx-target="#outbound-list" hx-swap="afterbegin"
            class="text-[10px] px-2 py-0.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">↺ resend</button>` : ''}
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

// ----- /approvals (unified WhatsApp outbound + sheet edits) -----

const SHEET_EDIT_KIND_LABEL: Record<string, string> = {
  mr_link: 'MR link → sheet',
};

export interface SheetEditRowContext {
  title?: string;
  assignee?: string;
}

export interface ApprovalsPageData {
  pendingOutbound: PendingOutbound[];
  pendingSheetEdits: PendingSheetEdit[];
  pendingReviews: Array<{ review: MrReview; suggestionCount: number; severityCounts: Record<string, number> }>;
  recentOutbound: PendingOutbound[];
  recentSheetEdits: PendingSheetEdit[];
  recentReviews: MrReview[];
  pendingFeatureSuggestions: SuggestionWithMembers[];
  members: TeamMember[];
  filter: 'all' | 'outbound' | 'sheet' | 'review' | 'feature';
  /** id → row context (looked up from backlog by sheetItemId in context_json) */
  sheetEditRowContexts?: Map<number, SheetEditRowContext>;
  /** When true, render the archive page instead of the pending page. */
  archiveView?: boolean;
}

export function approvalsPage(d: ApprovalsPageData): string {
  const showOb = d.filter === 'all' || d.filter === 'outbound';
  const showSh = d.filter === 'all' || d.filter === 'sheet';
  const showRv = d.filter === 'all' || d.filter === 'review';
  const showFs = d.filter === 'all' || d.filter === 'feature';

  type Card = { ts: number; html: string };
  const pending: Card[] = [];
  if (showOb) for (const p of d.pendingOutbound) pending.push({ ts: p.created_at, html: outboundCard(p, d.members) });
  if (showSh) for (const p of d.pendingSheetEdits) pending.push({ ts: p.created_at, html: sheetEditCard(p, d.sheetEditRowContexts?.get(p.id)) });
  if (showRv) for (const r of d.pendingReviews) pending.push({ ts: r.review.finished_at || r.review.created_at, html: reviewApprovalCard(r.review, r.suggestionCount, r.severityCounts) });
  if (showFs) for (const s of d.pendingFeatureSuggestions) pending.push({ ts: s.created_at, html: featureSuggestionCard(s) });
  pending.sort((a, b) => a.ts - b.ts);
  const pendingHtml = pending.map(c => c.html).join('');

  const history: Card[] = [];
  if (showOb) for (const p of d.recentOutbound) if (p.status !== 'pending') history.push({ ts: (p.sent_at || p.approved_at || p.created_at), html: outboundHistoryRow(p, d.members) });
  if (showSh) for (const p of d.recentSheetEdits) if (p.status !== 'pending') history.push({ ts: (p.applied_at || p.approved_at || p.created_at), html: sheetEditHistoryRow(p) });
  if (showRv) for (const r of d.recentReviews) if (r.status !== 'queued' && r.status !== 'running') history.push({ ts: (r.submitted_at || r.finished_at || r.created_at), html: reviewHistoryRow(r) });
  history.sort((a, b) => b.ts - a.ts);
  const historyHtml = history.map(c => c.html).join('');

  const totalPending = pending.length;
  const obPending = d.pendingOutbound.length;
  const shPending = d.pendingSheetEdits.length;
  const rvPending = d.pendingReviews.length;
  const fsPending = d.pendingFeatureSuggestions.length;

  const base = d.archiveView ? '/approvals/archive' : '/approvals';
  const chip = (key: 'all' | 'outbound' | 'sheet' | 'review' | 'feature', label: string, count: number) => {
    const active = d.filter === key;
    const cls = active
      ? 'px-3 py-1 rounded-full text-xs font-medium bg-slate-900 text-white'
      : 'px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200';
    return `<a href="${base}${key === 'all' ? '' : `?kind=${key}`}" class="${cls}">${escapeHtml(label)} <span class="opacity-60">${count}</span></a>`;
  };

  const filterQs = d.filter === 'all' ? '' : `?kind=${d.filter}`;
  if (d.archiveView) {
    return `
    <div class="mb-3 flex items-center justify-between">
      <h1 class="text-lg font-semibold">Approvals archive</h1>
      <a href="/approvals${filterQs}" class="text-xs text-slate-600 hover:underline">← Back to pending</a>
    </div>
    <div class="mb-4 flex items-center gap-2">
      ${chip('all',      'All',        obPending + shPending + rvPending + fsPending)}
      ${chip('outbound', 'WhatsApp',   obPending)}
      ${chip('sheet',    'Sheet edits',shPending)}
      ${chip('review',   'Reviews',    rvPending)}
      ${chip('feature',  '🪄 Features',fsPending)}
    </div>
    ${historyHtml
      ? `<div class="bg-white rounded-lg border divide-y">${historyHtml}</div>`
      : '<div class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">No archived items yet.</div>'}`;
  }

  return `
  <div class="mb-3 flex items-center justify-between">
    <h1 class="text-lg font-semibold">Pending approvals (${totalPending})</h1>
    <div class="flex items-center gap-2">
      <a href="/approvals/archive${filterQs}" class="text-xs text-slate-600 hover:underline">View archive →</a>
      ${d.pendingOutbound.length > 1 ? `<button hx-post="/outbound/approve-all" hx-target="#approvals-list" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">Approve all WhatsApp</button>` : ''}
    </div>
  </div>
  <div class="mb-4 flex items-center gap-2">
    ${chip('all',      'All',        obPending + shPending + rvPending + fsPending)}
    ${chip('outbound', 'WhatsApp',   obPending)}
    ${chip('sheet',    'Sheet edits',shPending)}
    ${chip('review',   'Reviews',    rvPending)}
    ${chip('feature',  '🪄 Features',fsPending)}
  </div>
  <div id="approvals-list" class="space-y-3">
    ${pendingHtml || '<div class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">Nothing pending. The bot will queue here before sending anything to anyone or editing the sheet. 🌿</div>'}
  </div>`;
}

function sheetEditUrl(p: PendingSheetEdit): string {
  return `https://docs.google.com/spreadsheets/d/${p.sheet_id}/edit#range=A${p.row_index}`;
}

export function sheetEditCard(p: PendingSheetEdit, rowCtx?: SheetEditRowContext): string {
  const ctx = p.context_json ? (() => { try { return JSON.parse(p.context_json!) as Record<string, unknown>; } catch { return {}; } })() : {};
  const errorBanner = p.status === 'error' && p.error
    ? `<div class="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">⚠ ${escapeHtml(p.error)}</div>`
    : '';
  const mrUrl = ctx.mrUrl ? String(ctx.mrUrl) : '';
  const rowTitle = rowCtx?.title?.trim();
  const rowAssignee = rowCtx?.assignee?.trim();
  return `
  <div id="se-${p.id}" class="bg-white border rounded-lg p-4">
    ${errorBanner}
    <div class="flex items-start justify-between mb-2 gap-3">
      <div class="min-w-0">
        <div class="text-sm font-medium">📋 Sheet edit
          <a href="${escapeHtml(sheetEditUrl(p))}" target="_blank" class="text-xs text-slate-500 font-normal hover:underline">row ${p.row_index} → "${escapeHtml(p.column_match)}"</a>
        </div>
        ${rowTitle ? `<div class="text-sm text-slate-800 mt-0.5 truncate" title="${escapeHtml(rowTitle)}">${escapeHtml(rowTitle)}</div>` : ''}
        <div class="mt-1 flex items-center gap-2 flex-wrap">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-800">${escapeHtml(SHEET_EDIT_KIND_LABEL[p.kind] || p.kind)}</span>
          ${rowAssignee ? `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700">👤 ${escapeHtml(rowAssignee)}</span>` : ''}
          <span class="text-[10px] text-slate-400">${escapeHtml(fmtAbsolute(p.created_at))}</span>
        </div>
        ${mrUrl ? `<div class="text-[10px] text-slate-500 mt-1"><a href="${escapeHtml(mrUrl)}" target="_blank" class="hover:underline">${escapeHtml(mrUrl)}</a></div>` : ''}
      </div>
    </div>
    <form hx-post="/sheet-edits/${p.id}/approve" hx-target="#se-${p.id}" hx-swap="outerHTML">
      <textarea name="append_text" rows="${Math.min(6, Math.max(2, (p.append_text.match(/\n/g) || []).length + 2))}"
                class="w-full text-sm font-mono border rounded p-2 bg-slate-50 focus:bg-white focus:border-slate-400 outline-none">${escapeHtml(p.append_text)}</textarea>
      <p class="text-[10px] text-slate-400 mt-1">Will be appended to the existing cell with a leading newline. Skipped automatically if any cell on the row already mentions an MR URL.</p>
      <div class="mt-2 flex items-center gap-2">
        <button type="submit"
                class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">${p.status === 'error' ? 'Retry & write' : 'Approve & write'}</button>
        <button type="button" hx-post="/sheet-edits/${p.id}/skip" hx-target="#se-${p.id}" hx-swap="outerHTML"
                class="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Skip</button>
      </div>
    </form>
  </div>`;
}

export function sheetEditAppliedRow(p: PendingSheetEdit): string {
  return `<div id="se-${p.id}" class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
    ✓ Wrote to row ${p.row_index} — ${escapeHtml(SHEET_EDIT_KIND_LABEL[p.kind] || p.kind)}
  </div>`;
}

export function sheetEditSkippedRow(p: PendingSheetEdit, reason?: string): string {
  return `<div id="se-${p.id}" class="bg-slate-100 border border-slate-200 rounded-lg p-3 text-sm text-slate-500 italic">
    Skipped — ${escapeHtml(SHEET_EDIT_KIND_LABEL[p.kind] || p.kind)} on row ${p.row_index}${reason ? ` (${escapeHtml(reason)})` : ''}
  </div>`;
}

function sheetEditHistoryRow(p: PendingSheetEdit): string {
  const when = p.applied_at || p.approved_at || p.created_at;
  const statusColor =
    p.status === 'applied' ? 'text-emerald-700' :
    p.status === 'skipped' ? 'text-slate-500' :
    'text-red-700';
  return `
  <div class="px-4 py-2 flex items-center gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-800">${escapeHtml(SHEET_EDIT_KIND_LABEL[p.kind] || p.kind)}</span>
    <span class="text-xs text-slate-500 w-32 shrink-0">${new Date(when).toLocaleString()}</span>
    <span class="text-xs flex-1 truncate">row ${p.row_index} → "${escapeHtml(p.column_match)}": ${escapeHtml(p.append_text.slice(0, 80))}</span>
    <span class="text-[10px] ${statusColor} font-medium uppercase">${p.status}</span>
  </div>`;
}

// ----- /team (merged: weekly summary + per-member daily grid + evaluations + feedback log) -----

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
  weeklyFeedback: MemberFeedback[];
}

export interface TeamPageData {
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  members: TeamMember[];
  rows: EvalRow[];
  // summary slice
  workingDays: string[];
  cellByMemberDate: Map<string, string>;            // key = `${jid}|${date}`
  weeklyByMember: Map<string, string>;
  teamSummary: string | null;
  madeLive: string | null;
  // run-status + saturday gating
  runStatus: {
    state: 'idle' | 'running' | 'done' | 'error';
    kind: 'summary' | 'prefill' | null;
    weekStart: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    error?: string;
  };
  todayDate: string;       // istDateString() at request time
  saturdayDate: string;    // Saturday of viewed week
}

function summarySection(d: TeamPageData): string {
  const headerDates = d.workingDays.map(date => `<th class="px-2 py-1 text-xs font-medium text-slate-500">${escapeHtml(date.slice(5))}</th>`).join('');
  const gridRows = d.members.map(m => {
    const cells = d.workingDays.map(date => {
      const md = d.cellByMemberDate.get(`${m.jid}|${date}`) || '';
      return `<td class="align-top px-2 py-2 border-l border-slate-100 text-xs text-slate-700 max-w-[180px]">
        ${md ? `<details><summary class="cursor-pointer text-slate-800 line-clamp-3">${escapeHtml(md.replace(/[*_#`]/g, '').slice(0, 140))}</summary><div class="mt-1 text-[11px] text-slate-600 prose prose-xs max-w-none">${renderMarkdown(md)}</div></details>` : '<span class="text-slate-300">—</span>'}
      </td>`;
    }).join('');
    const wk = d.weeklyByMember.get(m.jid) || '';
    return `<tr class="border-t">
      <td class="px-3 py-2 align-top text-sm font-medium w-44">${escapeHtml(m.name || m.jid.split('@')[0])}</td>
      ${cells}
      <td class="px-2 py-2 align-top border-l border-slate-200 text-xs text-slate-700 max-w-[260px]">
        ${wk ? `<details><summary class="cursor-pointer font-medium">Week recap</summary><div class="mt-1 text-[11px] text-slate-600 prose prose-xs max-w-none">${renderMarkdown(wk)}</div></details>` : '<span class="text-slate-300">—</span>'}
      </td>
    </tr>`;
  }).join('');

  return `
  ${d.teamSummary ? `
    <div class="mb-4 bg-white border rounded-lg p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">📊 Team weekly roll-up</h2>
      <div class="prose prose-sm max-w-none text-sm">${renderMarkdown(d.teamSummary)}</div>
      ${d.madeLive ? `<details class="mt-3" open><summary class="cursor-pointer text-xs font-semibold text-slate-600">📦 What we made live</summary><div class="mt-2 text-sm text-slate-700 prose prose-sm max-w-none">${renderMarkdown(d.madeLive)}</div></details>` : ''}
    </div>` : `
    <div class="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
      No team summary for this week yet. Click <strong>↻ Regenerate weekly summary</strong> above (or run <code>npm run job WeeklyTeamSummaryJob</code> Friday evening).
    </div>`}

  <div class="bg-white border rounded-lg overflow-x-auto mb-6">
    <table class="w-full text-left">
      <thead class="bg-slate-50">
        <tr>
          <th class="px-3 py-2 text-xs font-medium text-slate-500">Member</th>
          ${headerDates}
          <th class="px-2 py-2 text-xs font-medium text-slate-500 border-l border-slate-200">Week</th>
        </tr>
      </thead>
      <tbody>${gridRows || '<tr><td colspan="99" class="px-4 py-6 text-center text-sm text-slate-500">No members configured.</td></tr>'}</tbody>
    </table>
  </div>`;
}

export function teamPage(d: TeamPageData): string {
  const evalRows = d.rows.map(r => evaluationRow(d.weekStart, r)).join('');
  const memberOpts = d.members.map(m =>
    `<option value="${escapeHtml(m.jid)}">${escapeHtml(m.name || m.jid.split('@')[0])}</option>`
  ).join('');

  const runStatus = d.runStatus;
  const isRunningThisWeek = runStatus.state === 'running' && runStatus.weekStart === d.weekStart;
  const regenRunning = isRunningThisWeek && runStatus.kind === 'summary';
  const prefillRunning = isRunningThisWeek && runStatus.kind === 'prefill';
  const prefillEnabled = d.todayDate >= d.saturdayDate;
  const prefillDisabledTitle = prefillEnabled
    ? 'Re-run heuristic prefill for the unsaved evaluation rows.'
    : `Available on or after ${d.saturdayDate} (Saturday of this week).`;

  return `
  <div class="mb-4 flex items-center justify-between flex-wrap gap-2">
    <div>
      <h1 class="text-lg font-semibold">Team — week of ${escapeHtml(d.weekStart)}</h1>
      <p class="text-xs text-slate-500 mt-0.5">${d.workingDays.length} working days · ${d.members.length} members · weekly summary + made-live + evaluations + daily feedback log.</p>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <button id="regen-weekly-btn" data-week="${escapeHtml(d.weekStart)}" ${regenRunning ? 'disabled' : ''}
        title="Recompute per-member weekly summaries, team roll-up, made-live, and refresh evaluation prefills."
        class="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed">
        ${regenRunning ? '⏳ Regenerating…' : '↻ Regenerate weekly summary'}
      </button>
      <button id="prefill-btn" data-week="${escapeHtml(d.weekStart)}" ${prefillEnabled && !prefillRunning ? '' : 'disabled'}
        title="${escapeHtml(prefillDisabledTitle)}"
        class="px-2 py-1 rounded ${prefillEnabled ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} disabled:opacity-60">
        ${prefillRunning ? '⏳ Prefilling…' : '✨ Prefill scores'}
      </button>
      <a href="/team?week=${d.prevWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">← prev</a>
      <a href="/team" class="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">this week</a>
      <a href="/team?week=${d.nextWeek}" class="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300">next →</a>
    </div>
  </div>

  <div id="regen-status-bar" class="mb-3 hidden text-xs px-3 py-2 rounded border"></div>
  <div id="toast-host" class="fixed bottom-4 right-4 z-50 flex flex-col gap-2"></div>

  <script>
  (function () {
    const regenBtn = document.getElementById('regen-weekly-btn');
    const prefillBtn = document.getElementById('prefill-btn');
    const bar = document.getElementById('regen-status-bar');
    const toastHost = document.getElementById('toast-host');
    const week = regenBtn.dataset.week;
    const prefillEnabled = ${JSON.stringify(prefillEnabled)};
    let pollTimer = null;
    let lastState = ${JSON.stringify(runStatus.state)};
    let lastKind = ${JSON.stringify(runStatus.kind)};

    function showBar(kind, msg) {
      bar.classList.remove('hidden', 'bg-blue-50', 'border-blue-200', 'text-blue-900',
        'bg-green-50', 'border-green-200', 'text-green-900',
        'bg-red-50', 'border-red-200', 'text-red-900',
        'bg-slate-50', 'border-slate-200', 'text-slate-700');
      const map = {
        running: ['bg-blue-50', 'border-blue-200', 'text-blue-900'],
        done:    ['bg-green-50', 'border-green-200', 'text-green-900'],
        error:   ['bg-red-50', 'border-red-200', 'text-red-900'],
        idle:    ['bg-slate-50', 'border-slate-200', 'text-slate-700'],
      };
      (map[kind] || map.idle).forEach(c => bar.classList.add(c));
      bar.textContent = msg;
    }

    function toast(kind, msg) {
      const t = document.createElement('div');
      const palette = kind === 'error'
        ? 'bg-red-600 text-white'
        : kind === 'done' ? 'bg-green-600 text-white' : 'bg-slate-800 text-white';
      t.className = 'shadow-lg rounded px-3 py-2 text-sm ' + palette;
      t.textContent = msg;
      toastHost.appendChild(t);
      setTimeout(() => t.remove(), 5000);
    }

    function setBusy(running, kind) {
      regenBtn.disabled = running;
      regenBtn.textContent = running && kind === 'summary' ? '⏳ Regenerating…' : '↻ Regenerate weekly summary';
      prefillBtn.disabled = running || !prefillEnabled;
      prefillBtn.textContent = running && kind === 'prefill' ? '⏳ Prefilling…' : '✨ Prefill scores';
    }

    function labelFor(kind) {
      return kind === 'prefill' ? 'score prefill' : 'weekly summary';
    }

    async function pollOnce() {
      try {
        const r = await fetch('/team/status', { cache: 'no-store' });
        const s = await r.json();
        if (s.state === 'running' && s.weekStart === week) {
          setBusy(true, s.kind);
          const elapsed = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
          showBar('running', '⏳ Running ' + labelFor(s.kind) + ' for ' + s.weekStart + '… (' + elapsed + 's)');
        } else if (s.state === 'done' && lastState === 'running') {
          setBusy(false);
          showBar('done', '✅ ' + labelFor(lastKind) + ' complete for ' + s.weekStart + '. Reloading…');
          toast('done', labelFor(lastKind) + ' complete');
          stopPolling();
          setTimeout(() => location.reload(), 800);
        } else if (s.state === 'error' && lastState === 'running') {
          setBusy(false);
          showBar('error', '❌ ' + labelFor(lastKind) + ' failed: ' + (s.error || 'unknown error'));
          toast('error', labelFor(lastKind) + ' failed: ' + (s.error || 'unknown error'));
          stopPolling();
        } else if (s.state === 'running') {
          showBar('running', '⏳ Another ' + labelFor(s.kind) + ' is currently running (' + s.weekStart + ')…');
        }
        lastState = s.state;
        if (s.kind) lastKind = s.kind;
      } catch (err) { /* network blip — keep polling */ }
    }
    function startPolling() {
      if (pollTimer) return;
      pollOnce();
      pollTimer = setInterval(pollOnce, 2000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function trigger(path, label) {
      try {
        const r = await fetch(path + '?week=' + encodeURIComponent(week), { method: 'POST' });
        if (r.status === 409) {
          toast('error', 'Another job is already running');
          return;
        }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          toast('error', label + ' failed to start: ' + (j.error || r.statusText));
          return;
        }
        lastState = 'running';
        startPolling();
      } catch (err) {
        setBusy(false);
        showBar('error', '❌ Failed to start: ' + (err && err.message || err));
        toast('error', 'Failed to start ' + label);
      }
    }

    regenBtn.addEventListener('click', () => {
      setBusy(true, 'summary');
      showBar('running', '⏳ Starting weekly summary regeneration for ' + week + '…');
      trigger('/team/regenerate', 'regenerate');
    });

    prefillBtn.addEventListener('click', () => {
      if (prefillBtn.disabled) return;
      setBusy(true, 'prefill');
      showBar('running', '⏳ Starting score prefill for ' + week + '…');
      trigger('/team/prefill', 'prefill');
    });

    if (${JSON.stringify(runStatus.state)} === 'running') startPolling();
  })();
  </script>

  ${summarySection(d)}

  <form hx-post="/team/feedback" hx-swap="none"
        hx-on::after-request="if(event.detail.successful){this.reset();window.location.reload();}"
        class="bg-white border rounded-lg p-3 mb-4 space-y-2">
    <div class="text-[10px] uppercase tracking-wide text-slate-500">Log a daily feedback note</div>
    <div class="flex items-center gap-2 flex-wrap">
      <select name="member_jid" required class="text-sm px-2 py-1 rounded border bg-white">
        <option value="">— member —</option>
        ${memberOpts}
      </select>
      <input type="number" name="backlog_item_id" placeholder="optional #backlog id"
             class="text-sm px-2 py-1 rounded border bg-white w-44">
      <input type="text" name="text" required placeholder="What did they do? (e.g. nailed the auth refactor)"
             class="flex-1 min-w-[18rem] text-sm border rounded px-2 py-1 bg-slate-50 focus:bg-white focus:border-slate-400 outline-none">
      <button type="submit" class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">Log</button>
    </div>
  </form>

  <div id="eval-list" class="space-y-3">${evalRows || '<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">No evaluations prefilled yet. Click <strong>✨ Prefill scores</strong> above (Saturday onwards) or run <code>npm run job WeeklyEvaluationPrefillJob</code>.</div>'}</div>`;
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
  <form id="ev-${escapeHtml(r.member.jid)}" hx-post="/team/eval/${encodeURIComponent(r.member.jid)}/save" hx-target="this" hx-swap="outerHTML"
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
    ${r.weeklyFeedback.length ? `
    <div class="mb-3 border-l-2 border-blue-200 pl-3">
      <div class="text-[10px] uppercase tracking-wide text-blue-700 mb-1">This week's daily notes (${r.weeklyFeedback.length})</div>
      <ul class="space-y-1 text-xs text-slate-700">
        ${r.weeklyFeedback.map(f => `<li><span class="text-slate-400 font-mono">${escapeHtml(f.feedback_date.slice(5))}</span> · ${escapeHtml(f.text)}${f.backlog_item_id ? ` <a href="/task/${f.backlog_item_id}" class="text-blue-600 hover:underline">#${f.backlog_item_id}</a>` : ''}</li>`).join('')}
      </ul>
    </div>` : ''}
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

// ===== MR Reviews (Claude Code) =====

const MR_REVIEW_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-7',   label: 'Opus 4.7 (deeper)' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5 (fast)' },
];

const MR_REVIEW_LEVELS: Array<{ id: string; label: string; sub: string }> = [
  { id: 'critical_only',              label: 'Critical only',          sub: 'security, data loss, broken-by-construction (default)' },
  { id: 'critical_plus_correctness',  label: 'Critical + correctness', sub: 'adds logic bugs, swallowed errors, leaks' },
  { id: 'thorough',                   label: 'Thorough',               sub: 'adds quality, error handling, perf' },
];

const SEV_COLOR: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  high:     'bg-orange-100 text-orange-800',
  medium:   'bg-amber-100 text-amber-800',
  low:      'bg-slate-100 text-slate-700',
};

const REVIEW_STATUS_COLOR: Record<string, string> = {
  queued:     'bg-slate-100 text-slate-600',
  running:    'bg-blue-100 text-blue-800',
  finished:   'bg-emerald-100 text-emerald-800',
  submitting: 'bg-amber-100 text-amber-800',
  submitted:  'bg-emerald-200 text-emerald-900',
  failed:     'bg-red-100 text-red-800',
  cancelled:  'bg-slate-200 text-slate-600',
  discarded:  'bg-slate-200 text-slate-500',
};

export interface ReviewLaunchModalData {
  backlogItem: BacklogItem;
  defaultModel: string;
  defaultLevel: string;
  activeReviewCount: number;
  maxConcurrent: number;
}

export function reviewLaunchModal(d: ReviewLaunchModalData): string {
  const i = d.backlogItem;
  return `
  <div id="review-modal" class="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center"
       onclick="if(event.target===this) document.getElementById('chat-modal-mount').innerHTML=''">
    <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
      <div class="flex items-start justify-between mb-3">
        <div>
          <h3 class="text-base font-semibold">🤖 AI code review</h3>
          <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(i.title.slice(0, 100))}</p>
        </div>
        <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-xl leading-none">&times;</button>
      </div>
      <p class="text-[11px] text-slate-500 mb-3">Spawns a local Claude Code session against the MR's source branch. ${d.activeReviewCount}/${d.maxConcurrent} review slots in use.</p>
      <form action="/mr-reviews" method="post">
        <input type="hidden" name="backlog_id" value="${i.id}">
        <label class="block text-xs font-medium text-slate-700 mb-1">Model</label>
        <select name="model" class="w-full text-sm border rounded px-2 py-1.5 mb-3 outline-none focus:border-slate-400">
          ${MR_REVIEW_MODELS.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === d.defaultModel ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
        </select>
        <label class="block text-xs font-medium text-slate-700 mb-1">Review level</label>
        <div class="space-y-1.5 mb-4">
          ${MR_REVIEW_LEVELS.map(l => `
            <label class="flex items-start gap-2 p-2 border rounded hover:bg-slate-50 cursor-pointer">
              <input type="radio" name="level" value="${escapeHtml(l.id)}" ${l.id === d.defaultLevel ? 'checked' : ''} class="mt-0.5">
              <div>
                <div class="text-sm font-medium">${escapeHtml(l.label)}</div>
                <div class="text-[10px] text-slate-500">${escapeHtml(l.sub)}</div>
              </div>
            </label>`).join('')}
        </div>
        <div class="flex items-center justify-end gap-2">
          <button type="button" onclick="document.getElementById('chat-modal-mount').innerHTML=''"
                  class="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Cancel</button>
          <button type="submit"
                  class="text-xs px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700">Start review</button>
        </div>
      </form>
    </div>
  </div>`;
}

export interface SuggestionsPageData {
  review: MrReview;
  suggestions: MrReviewSuggestion[];
}

export function suggestionsPage(d: SuggestionsPageData): string {
  const r = d.review;
  const isLive = r.status === 'queued' || r.status === 'running';
  const acceptedCount = d.suggestions.filter(s => s.status === 'accepted').length;
  const sevCounts = d.suggestions.reduce((acc, s) => { acc[s.severity] = (acc[s.severity] || 0) + 1; return acc; }, {} as Record<string, number>);
  const sevLine = ['critical', 'high', 'medium', 'low']
    .filter(k => sevCounts[k]).map(k => `${k}: ${sevCounts[k]}`).join(' • ');

  const banner = `
    <div class="mb-4 bg-white border rounded-lg p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${REVIEW_STATUS_COLOR[r.status] || 'bg-slate-100 text-slate-700'}">${escapeHtml(r.status)}</span>
            <span class="text-[10px] text-slate-500">model: ${escapeHtml(r.model)} • level: ${escapeHtml(r.level)}</span>
            ${r.cost_usd != null ? `<span class="text-[10px] text-slate-500">$${r.cost_usd.toFixed(4)}</span>` : ''}
            ${r.duration_ms != null ? `<span class="text-[10px] text-slate-500">${(r.duration_ms / 1000).toFixed(1)}s</span>` : ''}
          </div>
          <div class="text-sm font-medium truncate">${escapeHtml(r.mr_title)}</div>
          <div class="text-[11px] text-slate-500 mt-0.5"><a href="${escapeHtml(r.mr_url)}" target="_blank" class="hover:underline">${escapeHtml(r.mr_url)}</a></div>
          <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(r.source_branch)} → ${escapeHtml(r.target_branch)}</div>
          ${sevLine ? `<div class="text-[11px] text-slate-600 mt-1">${escapeHtml(sevLine)}</div>` : ''}
          ${r.error ? `<div class="text-[11px] text-red-700 mt-1">⚠ ${escapeHtml(r.error)}</div>` : ''}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${isLive ? `<form action="/mr-reviews/${r.id}/cancel" method="post" class="inline">
                        <button type="submit" class="text-xs px-3 py-1.5 rounded bg-red-100 text-red-700 hover:bg-red-200">Cancel</button>
                      </form>` : ''}
          ${r.status === 'finished' ? `
            <form action="/mr-reviews/${r.id}/submit" method="post" class="inline"
                  onsubmit="return ${acceptedCount === 0 ? 'false' : 'true'}">
              <button type="submit" ${acceptedCount === 0 ? 'disabled' : ''}
                      class="text-xs px-3 py-1.5 rounded ${acceptedCount === 0 ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700'}">
                Submit ${acceptedCount} fix${acceptedCount === 1 ? '' : 'es'} → push
              </button>
            </form>
            <form action="/mr-reviews/${r.id}/discard" method="post" class="inline">
              <button type="submit" class="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Discard</button>
            </form>` : ''}
          ${r.status === 'submitted' && r.push_commit_sha ? `<span class="text-[11px] text-emerald-700 font-mono">pushed ${escapeHtml(r.push_commit_sha.slice(0, 8))}</span>` : ''}
        </div>
      </div>
    </div>`;

  const transcript = `
    <details class="mb-4 bg-slate-50 border rounded-lg" ${isLive ? 'open' : ''}>
      <summary class="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">
        Agent transcript${isLive ? ' (live)' : ''} — ${r.transcript.length} chars
      </summary>
      <pre class="px-3 py-2 text-[11px] text-slate-700 whitespace-pre-wrap overflow-x-auto max-h-96">${escapeHtml(r.transcript || '(no output yet)')}</pre>
    </details>`;

  const suggestionsHtml = d.suggestions.length === 0
    ? `<div class="bg-white border rounded-lg p-6 text-center text-sm text-slate-500">${isLive ? 'Waiting for suggestions…' : 'No suggestions emitted.'}</div>`
    : `<div id="suggestions-list" class="space-y-3">${d.suggestions.map(s => suggestionCard(s)).join('')}</div>`;

  // htmx polling: keep refreshing the whole page while running.
  const poll = isLive
    ? `<div hx-get="/mr-reviews/${r.id}?_partial=1" hx-trigger="every 2s" hx-target="body" hx-swap="innerHTML"></div>`
    : '';

  return `${banner}${transcript}${suggestionsHtml}${poll}`;
}

export function suggestionCard(s: MrReviewSuggestion): string {
  const decided = s.status === 'accepted' || s.status === 'rejected' || s.status === 'applied' || s.status === 'apply_failed';
  const statusBadge =
    s.status === 'accepted'      ? '<span class="text-[10px] text-emerald-700 font-medium">✓ accepted</span>' :
    s.status === 'rejected'      ? '<span class="text-[10px] text-slate-500 italic">rejected</span>' :
    s.status === 'applied'       ? '<span class="text-[10px] text-emerald-800 font-medium">✓ applied</span>' :
    s.status === 'apply_failed'  ? `<span class="text-[10px] text-red-700 font-medium">✗ apply failed${s.apply_error ? `: ${escapeHtml(s.apply_error.slice(0, 80))}` : ''}</span>` :
    '';
  return `
  <div id="sug-${s.id}" class="bg-white border rounded-lg p-3 ${s.status === 'rejected' || s.status === 'apply_failed' ? 'opacity-60' : ''}">
    <div class="flex items-center gap-2 mb-2 text-xs">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded font-semibold ${SEV_COLOR[s.severity] || 'bg-slate-100'}">${s.severity}</span>
      <span class="font-mono text-slate-600">${escapeHtml(s.file)}:${s.line_start}${s.line_end !== s.line_start ? `-${s.line_end}` : ''}</span>
      <span class="ml-auto">${statusBadge}</span>
    </div>
    <div class="text-sm text-slate-700 mb-2">${escapeHtml(s.rationale)}</div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
      <div>
        <div class="text-[10px] text-slate-500 mb-0.5">- before</div>
        <pre class="text-[11px] bg-red-50 border border-red-100 rounded p-2 whitespace-pre-wrap overflow-x-auto">${escapeHtml(s.original) || '<empty>'}</pre>
      </div>
      <div>
        <div class="text-[10px] text-slate-500 mb-0.5">+ after</div>
        <pre class="text-[11px] bg-emerald-50 border border-emerald-100 rounded p-2 whitespace-pre-wrap overflow-x-auto">${escapeHtml(s.replacement) || '<empty>'}</pre>
      </div>
    </div>
    ${!decided ? `<div class="flex items-center gap-2">
      <button hx-post="/mr-reviews/sugs/${s.id}/accept" hx-target="#sug-${s.id}" hx-swap="outerHTML"
              class="text-xs px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">Apply</button>
      <button hx-post="/mr-reviews/sugs/${s.id}/reject" hx-target="#sug-${s.id}" hx-swap="outerHTML"
              class="text-xs px-3 py-1 rounded bg-slate-200 text-slate-700 hover:bg-slate-300">Reject</button>
    </div>` : (s.status === 'accepted' || s.status === 'rejected' ? `<div>
      <button hx-post="/mr-reviews/sugs/${s.id}/reset" hx-target="#sug-${s.id}" hx-swap="outerHTML"
              class="text-[11px] text-slate-500 hover:text-slate-800">undo</button>
    </div>` : '')}
  </div>`;
}

export function reviewApprovalCard(r: MrReview, suggestionCount: number, severityCounts: Record<string, number>): string {
  const ageMin = Math.max(0, Math.round((Date.now() - (r.finished_at || r.created_at)) / 60000));
  const sevLine = ['critical', 'high', 'medium', 'low']
    .filter(k => severityCounts[k]).map(k => `${k}: ${severityCounts[k]}`).join(' • ');
  return `
  <div id="rv-${r.id}" class="bg-white border rounded-lg p-4 hover:shadow-md transition">
    <a href="/mr-reviews/${r.id}" class="block">
      <div class="flex items-center justify-between gap-3 mb-1">
        <div class="text-sm font-medium truncate">🤖 Review of ${escapeHtml(r.mr_title)}</div>
        <span class="text-[10px] text-slate-400 shrink-0">${ageMin === 0 ? 'just now' : `${ageMin} min ago`}</span>
      </div>
      <div class="flex items-center gap-2 text-[11px] text-slate-500">
        <span class="inline-flex items-center px-1.5 py-0.5 rounded ${REVIEW_STATUS_COLOR[r.status] || 'bg-slate-100'}">${escapeHtml(r.status)}</span>
        <span>${suggestionCount} suggestion${suggestionCount === 1 ? '' : 's'}</span>
        ${sevLine ? `<span>${escapeHtml(sevLine)}</span>` : ''}
        <span class="ml-auto text-slate-400">${escapeHtml(r.source_branch)} → ${escapeHtml(r.target_branch)}</span>
      </div>
    </a>
  </div>`;
}

export function reviewHistoryRow(r: MrReview): string {
  const when = r.submitted_at || r.finished_at || r.created_at;
  const statusColor = REVIEW_STATUS_COLOR[r.status] || 'bg-slate-100 text-slate-700';
  return `
  <div class="px-4 py-2 flex items-center gap-3">
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${statusColor}">🤖 ${escapeHtml(r.status)}</span>
    <span class="text-xs text-slate-500 w-32 shrink-0">${new Date(when).toLocaleString()}</span>
    <a href="/mr-reviews/${r.id}" class="text-xs flex-1 truncate text-blue-600 hover:underline">${escapeHtml(r.mr_title)}</a>
    ${r.push_commit_sha ? `<span class="text-[10px] font-mono text-emerald-700">${escapeHtml(r.push_commit_sha.slice(0, 8))}</span>` : ''}
  </div>`;
}

// ───────────────────────── Admin: jobs ─────────────────────────

export interface AdminJobView {
  name: string;
  schedule: string;
  description?: string;
}

export interface AdminJobRun {
  job_name: string;
  ran_at: number;
  ok: number;
  error: string | null;
}

// Human-readable absolute timestamp, e.g. "today 14:32", "yesterday 09:15",
// "May 4, 14:32", or "May 4 2024, 14:32" if not in the current year.
function fmtAbsolute(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return `today ${time}`;
  if (isYesterday) return `yesterday ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const dateOpts: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString(undefined, dateOpts)}, ${time}`;
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function adminJobsPage(opts: {
  jobs: AdminJobView[];
  recentRuns: AdminJobRun[];
  enabledMissing: string[];   // names referenced in code but not currently loaded
}): string {
  const jobRow = (j: AdminJobView) => `
    <tr id="job-${escapeHtml(j.name)}" class="border-t">
      <td class="px-3 py-2 align-top">
        <div class="font-mono text-sm text-slate-800">${escapeHtml(j.name)}</div>
        ${j.description ? `<div class="text-xs text-slate-500 mt-0.5">${escapeHtml(j.description)}</div>` : ''}
      </td>
      <td class="px-3 py-2 align-top text-xs text-slate-600 font-mono whitespace-nowrap">${escapeHtml(j.schedule)}</td>
      <td class="px-3 py-2 align-top text-right">
        <form hx-post="/admin/jobs/${encodeURIComponent(j.name)}/run"
              hx-target="#job-status-${escapeHtml(j.name)}"
              hx-swap="innerHTML"
              hx-confirm="Run ${escapeHtml(j.name)} now? It will execute immediately and may send WhatsApp messages."
              class="inline-block">
          <button type="submit" class="text-xs px-3 py-1 rounded bg-slate-900 text-white hover:bg-slate-700">Run now</button>
        </form>
        <div id="job-status-${escapeHtml(j.name)}" class="mt-1 text-[11px] text-slate-500"></div>
      </td>
    </tr>`;

  const runRow = (r: AdminJobRun) => `
    <tr class="border-t">
      <td class="px-3 py-1.5 font-mono text-xs">${escapeHtml(r.job_name)}</td>
      <td class="px-3 py-1.5 text-xs text-slate-500 whitespace-nowrap">${fmtAgo(r.ran_at)} · ${new Date(r.ran_at).toLocaleString()}</td>
      <td class="px-3 py-1.5">
        ${r.ok
          ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">ok</span>'
          : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">fail</span>'}
      </td>
      <td class="px-3 py-1.5 text-xs text-slate-600">${r.error ? `<details><summary class="cursor-pointer">error</summary><pre class="mt-1 text-[10px] whitespace-pre-wrap text-red-700">${escapeHtml(r.error)}</pre></details>` : ''}</td>
    </tr>`;

  const missingPanel = opts.enabledMissing.length ? `
    <div class="mb-4 bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
      Not currently loaded (add to <code>ENABLED_JOBS</code> to enable): ${opts.enabledMissing.map(n => `<code>${escapeHtml(n)}</code>`).join(', ')}
    </div>` : '';

  const body = `
    <div class="mb-4">
      <h1 class="text-lg font-semibold">Admin · Jobs</h1>
      <p class="text-xs text-slate-500 mt-0.5">Manually trigger any cron job loaded into the scheduler. Triggering is synchronous — the page waits for the job to finish.</p>
    </div>

    ${missingPanel}

    <div class="bg-white border rounded-lg overflow-hidden mb-6">
      <table class="w-full">
        <thead class="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-3 py-2 text-left">Job</th>
            <th class="px-3 py-2 text-left">Schedule (cron)</th>
            <th class="px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${opts.jobs.length ? opts.jobs.map(jobRow).join('') : '<tr><td colspan="3" class="px-3 py-4 text-center text-sm text-slate-500 italic">No jobs loaded. Set ENABLED_JOBS in .env.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2 class="text-sm font-semibold mb-2 text-slate-700">Recent runs</h2>
    <div class="bg-white border rounded-lg overflow-hidden">
      <table class="w-full">
        <thead class="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-3 py-2 text-left">Job</th>
            <th class="px-3 py-2 text-left">When</th>
            <th class="px-3 py-2 text-left">Status</th>
            <th class="px-3 py-2 text-left">Error</th>
          </tr>
        </thead>
        <tbody>
          ${opts.recentRuns.length ? opts.recentRuns.map(runRow).join('') : '<tr><td colspan="4" class="px-3 py-4 text-center text-sm text-slate-500 italic">No runs recorded yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  return body;
}

export function jobRunResult(opts: { name: string; ok: boolean; ms: number; error?: string }): string {
  if (opts.ok) {
    return `<span class="text-emerald-700">✓ ran in ${opts.ms}ms</span>`;
  }
  return `<span class="text-red-700" title="${escapeHtml(opts.error || '')}">✗ failed (${opts.ms}ms) — ${escapeHtml((opts.error || '').split('\n')[0].slice(0, 120))}</span>`;
}

// ───────────────────────── About / changelog ─────────────────────────

interface AboutSection {
  heading: string;
  blurb?: string;
  items: { title: string; desc: string }[];
}

const ABOUT_SECTIONS: AboutSection[] = [
  {
    heading: 'P0 · Foundation',
    items: [
      { title: 'SQLite + migrations + repos', desc: 'Versioned schema, thin per-table repo classes.' },
      { title: 'Gemini client', desc: 'Wraps Google AI Studio with LLM_DRY_RUN for offline testing.' },
      { title: 'Scheduler / Hooks / Actions / Jobs', desc: 'Pluggable units auto-loaded by class name from ENABLED_* env.' },
      { title: 'Hardened WhatsApp service', desc: 'Raw Baileys proto, mention parsing, canonical sender JID across LID and @s.whatsapp.net.' },
    ],
  },
  {
    heading: 'P1 · Morning tasklist',
    items: [
      { title: 'Tasklist classification', desc: 'Watches the meetings group and detects tasklist messages as members post them.' },
      { title: 'Noon reminder', desc: 'At 12:00 IST DMs anyone who hasn\'t shared, with stateful 2-step DM follow-up.' },
    ],
  },
  {
    heading: 'P2 · EOD standup',
    items: [
      { title: 'EOD kickoff (19:00 IST)', desc: 'DMs each member 3 questions: done / left / blockers.' },
      { title: 'EOD aggregate (20:30 IST)', desc: 'Done-vs-plan comparison per member, posts overview to meetings group + DMs PM.' },
    ],
  },
  {
    heading: 'P3 · Backlog',
    items: [
      { title: 'WhatsApp inbox classification', desc: 'Hourly pass over org-level / csm / bugs / webdev into 5 intents (task / connect / task_update / status_check / noise) with image vision fallback.' },
      { title: 'Sheet + GitLab MR sync', desc: '6-hourly Google Sheets and GitLab MR ingest, rolled into a unified backlog.' },
      { title: 'Unreplied-mention sweep', desc: 'Every 15m: surfaces mentions you haven\'t replied to past the SLA.' },
      { title: 'Morning digest (09:00 IST)', desc: 'DMs you the unified backlog. Also accessible via @<keyword> backlog.' },
    ],
  },
  {
    heading: 'P4 · Web dashboard',
    items: [
      { title: 'Today / Backlog / Messages views', desc: 'Fastify + HTMX + Tailwind. In-place resolve, filter chips, debug message stream.' },
    ],
  },
  {
    heading: 'P5 · Intent + linkage upgrades',
    items: [
      { title: 'task_update + status_check intents', desc: 'Added after backfill analysis showed 49 + 30 missed signals in 2 days.' },
      { title: 'MR ↔ task linkage', desc: 'Sheet-column scrape + LLM fuzzy match.' },
      { title: 'Backfill persistence + dashboard toggle', desc: 'Promote historical exports into backlog with a separate origin tag.' },
    ],
  },
  {
    heading: 'P6 · Summary / Evaluations',
    items: [
      { title: 'Daily / weekly summaries', desc: 'Per-member daily summary + weekly team rollup jobs.' },
      { title: 'Evaluations', desc: 'Weekly evaluation prefill + review surface.' },
    ],
  },
  {
    heading: 'P7 · Item-level UX',
    items: [
      { title: 'Notes, snooze, manual link, per-task timeline, bulk actions', desc: 'Per-item operations over backlog rows.' },
      { title: 'Chat about this', desc: 'One-shot LLM Q&A grounded in a single backlog item\'s history.' },
    ],
  },
  {
    heading: 'Approvals',
    items: [
      { title: 'Unified approvals', desc: 'WhatsApp outbound, sheet-edit appends, and Claude Code MR reviews all queued through one approval surface.' },
    ],
  },
  {
    heading: 'Admin',
    items: [
      { title: 'Manual job trigger', desc: 'Trigger any loaded cron job synchronously from /admin/jobs and view recent run history.' },
    ],
  },
];

export function aboutPage(): string {
  const section = (s: AboutSection) => `
    <section class="mb-6">
      <h2 class="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-2">${escapeHtml(s.heading)}</h2>
      ${s.blurb ? `<p class="text-xs text-slate-500 mb-2">${escapeHtml(s.blurb)}</p>` : ''}
      <ul class="space-y-1.5">
        ${s.items.map(it => `<li class="text-sm">
          <span class="font-medium text-slate-800">${escapeHtml(it.title)}</span>
          <span class="text-slate-600"> — ${escapeHtml(it.desc)}</span>
        </li>`).join('')}
      </ul>
    </section>`;

  return `
    <div class="mb-4">
      <h1 class="text-lg font-semibold">About · Features</h1>
      <p class="text-xs text-slate-500 mt-0.5">A running changelog of what this project does. Maintained by hand in <code>src/web/views.ts</code> (ABOUT_SECTIONS).</p>
    </div>
    <div class="bg-white border rounded-lg p-5">
      ${ABOUT_SECTIONS.map(section).join('')}
    </div>
  `;
}

// ───────────────────────── Feature suggestions ─────────────────────────

function suggestionConfChip(conf: number): string {
  const pct = Math.round(conf * 100);
  const color = conf >= 0.85 ? 'bg-emerald-100 text-emerald-800'
              : conf >= 0.7  ? 'bg-amber-100 text-amber-800'
              : 'bg-slate-100 text-slate-700';
  return `<span class="text-[10px] px-1.5 py-0.5 rounded ${color}">${pct}%</span>`;
}

function suggestionMemberChip(m: { item_id: number; source: string; title: string }): string {
  const src = m.source as BacklogSource;
  return `<a href="/task/${m.item_id}" target="_blank" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[src] || 'bg-slate-100 text-slate-700'} hover:opacity-80 max-w-xs">
    <span class="shrink-0">${SOURCE_LABEL[src] || m.source}</span>
    <span class="truncate">${escapeHtml(m.title.slice(0, 60))}</span>
  </a>`;
}

// Card for one pending new_feature suggestion, used inside /approvals.
export function featureSuggestionCard(s: SuggestionWithMembers): string {
  return `
  <div id="sugg-${s.id}" class="bg-white border rounded-lg p-4">
    <div class="flex items-start justify-between mb-2 gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium">🪄 Suggested feature
          <span class="text-xs text-slate-500 font-normal">· ${s.members.length} member${s.members.length === 1 ? '' : 's'}</span>
        </div>
        <div class="mt-1 text-sm text-slate-900">${escapeHtml(s.proposed_title || 'Untitled')}</div>
        ${s.proposed_desc ? `<div class="mt-0.5 text-xs text-slate-600">${escapeHtml(s.proposed_desc)}</div>` : ''}
        ${s.rationale ? `<div class="mt-1 text-[11px] text-slate-500 italic">${escapeHtml(s.rationale)}</div>` : ''}
      </div>
      ${suggestionConfChip(s.confidence)}
    </div>
    <div class="flex flex-wrap gap-1 mb-3">
      ${s.members.map(suggestionMemberChip).join('')}
    </div>
    <div class="flex items-center gap-2">
      <button hx-post="/features/suggestions/${s.id}/accept" hx-target="#sugg-${s.id}" hx-swap="outerHTML"
              hx-on::after-request="if (event.detail.successful) { const loc = event.detail.xhr.getResponseHeader('HX-Redirect'); if (loc) location.href = loc; }"
              class="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700">✓ Accept</button>
      <button hx-get="/features/suggestions/${s.id}/edit" hx-target="#chat-modal-mount" hx-swap="innerHTML"
              class="text-xs px-3 py-1.5 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">✏️ Edit & accept</button>
      <button hx-post="/features/suggestions/${s.id}/dismiss" hx-target="#sugg-${s.id}" hx-swap="outerHTML"
              class="text-xs px-3 py-1.5 rounded text-slate-500 hover:text-rose-700 hover:bg-rose-50">Dismiss</button>
    </div>
  </div>`;
}

export function suggestionEditModal(s: SuggestionWithMembers): string {
  return `
  <div class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
       onclick="if (event.target === this) document.getElementById('chat-modal-mount').innerHTML=''">
    <div class="bg-white border rounded-lg shadow-2xl w-full max-w-xl">
      <div class="px-4 py-3 border-b flex items-center justify-between">
        <div class="text-sm font-semibold">🪄 Review suggested feature</div>
        <button onclick="document.getElementById('chat-modal-mount').innerHTML=''" class="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
      </div>
      <form hx-post="/features/suggestions/${s.id}/accept-edit" hx-target="body" hx-swap="none"
            hx-on::after-request="if (event.detail.successful) { const loc = event.detail.xhr.getResponseHeader('HX-Redirect'); if (loc) location.href = loc; }"
            class="px-4 py-3 space-y-2">
        <label class="block text-xs text-slate-500">Title</label>
        <input type="text" name="title" required autofocus value="${escapeHtml(s.proposed_title || '')}"
               class="w-full px-3 py-2 text-sm border rounded outline-none focus:border-slate-400">
        <label class="block text-xs text-slate-500">Description</label>
        <textarea name="description" rows="3"
                  class="w-full px-3 py-2 text-sm border rounded outline-none focus:border-slate-400">${escapeHtml(s.proposed_desc || '')}</textarea>
        <label class="block text-xs text-slate-500 mt-2">Members (uncheck to drop)</label>
        <div class="space-y-1 max-h-48 overflow-y-auto border rounded p-2">
          ${s.members.map(m => {
            const src = m.source as BacklogSource;
            return `<label class="flex items-center gap-2 text-xs hover:bg-slate-50 px-1 py-0.5 rounded">
              <input type="checkbox" name="member_ids" value="${m.item_id}" checked class="shrink-0">
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[src] || 'bg-slate-100 text-slate-700'} shrink-0">${SOURCE_LABEL[src] || m.source}</span>
              <span class="flex-1 truncate">${escapeHtml(m.title)}</span>
            </label>`;
          }).join('')}
        </div>
        <div class="flex items-center justify-end gap-2 pt-2">
          <button type="button" onclick="document.getElementById('chat-modal-mount').innerHTML=''"
                  class="text-xs px-3 py-1.5 rounded text-slate-600 hover:bg-slate-100">Cancel</button>
          <button type="submit" class="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700">✓ Accept</button>
        </div>
      </form>
    </div>
  </div>`;
}

// "Suggested members" sub-block on /task/:featureId. Pending member_add
// suggestions for this feature, each with Add / Dismiss.
export function suggestedMembersBlock(featureId: number, rows: SuggestionWithMembers[]): string {
  if (rows.length === 0) return '';
  const items = rows.map(s => {
    const m = s.members[0];
    if (!m) return '';
    const src = m.source as BacklogSource;
    return `<li id="memsugg-${s.id}" class="py-2 flex items-center gap-2 text-sm">
      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${SOURCE_COLOR[src] || 'bg-slate-100 text-slate-700'} shrink-0">${SOURCE_LABEL[src] || m.source}</span>
      <a href="/task/${m.item_id}" class="flex-1 hover:underline truncate">${escapeHtml(m.title)}</a>
      ${suggestionConfChip(s.confidence)}
      <button hx-post="/features/${featureId}/suggestions/${s.id}/accept" hx-target="#memsugg-${s.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700">+ Add</button>
      <button hx-post="/features/suggestions/${s.id}/dismiss" hx-target="#memsugg-${s.id}" hx-swap="outerHTML"
              class="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-rose-700 hover:bg-rose-50">Dismiss</button>
    </li>`;
  }).join('');

  return `<section class="bg-white border border-purple-200 rounded-lg p-4">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">🪄 Suggested members <span class="text-slate-400 font-normal normal-case">· ${rows.length}</span></h2>
    <ul class="divide-y">${items}</ul>
  </section>`;
}

