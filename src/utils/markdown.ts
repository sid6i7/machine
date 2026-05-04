// Tiny markdown helpers. Two boundaries:
//   renderMarkdown(md) — produces sanitized HTML for the dashboard.
//   mdToWhatsApp(md)   — converts LLM-emitted markdown into WA's flavored
//                        formatting (single-asterisk bold, no [](url), etc.)
//                        before we hand the body to Baileys.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inline pass: applied to already-escaped text. Order matters — bold (**)
// before italic (*) so we don't eat the bold delimiters.
function inline(html: string): string {
  return html
    // [text](url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
      `<a href="${u}" target="_blank" rel="noreferrer" class="text-blue-700 underline">${t}</a>`)
    // **bold**
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // _italic_  (WA style; LLM also sometimes uses *single* — leave that alone
    // here to avoid clobbering bullets)
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?:;)])/g, '$1<em>$2</em>')
    // `code`
    .replace(/`([^`\n]+)`/g, '<code class="px-1 rounded bg-slate-100 text-[0.85em]">$1</code>');
}

// A bullet whose text is just bold (e.g. `- **Nithin Rajaseharan**`) is
// treated as a section header — common shape from the team-summary prompt
// where authors precede their MR list.
const BOLD_ONLY = /^\*\*([^*\n]+)\*\*\s*:?\s*$/;

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<p class="font-semibold mt-3 mb-1">${inline(esc(h[2]))}</p>`);
      continue;
    }

    const bullet = line.match(/^(\s*)(?:[-*•])\s+(.*)$/);
    if (bullet) {
      const content = bullet[2];
      const isHeader = BOLD_ONLY.test(content);
      if (isHeader) {
        closeList();
        const name = content.match(BOLD_ONLY)![1];
        out.push(`<p class="font-semibold mt-3 mb-1">${inline(esc(name))}</p>`);
        continue;
      }
      if (!inList) { out.push('<ul class="list-disc list-inside space-y-0.5 ml-1">'); inList = true; }
      out.push(`<li>${inline(esc(content))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(esc(line))}</p>`);
  }
  closeList();
  return out.join('');
}

// Convert LLM markdown → WhatsApp-friendly text. WA supports:
//   *bold*  _italic_  ~strike~  ```code```
// It does NOT understand **bold**, [text](url), or # headings.
export function mdToWhatsApp(md: string): string {
  if (!md) return md;
  const lines = md.split('\n');
  const out: string[] = [];

  for (const raw of lines) {
    let line = raw;

    // Bullet with only bold inside → treat as section header: blank line
    // above, bold (no bullet) on its own line.
    const bulletBold = line.match(/^(\s*)[-*•]\s+\*\*([^*\n]+)\*\*\s*:?\s*$/);
    if (bulletBold) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`*${bulletBold[2]}*`);
      continue;
    }

    line = line
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      .replace(/^(#{1,6})\s+(.*)$/, '*$2*')
      .replace(/^(\s*)[-*]\s+/, '$1• ');

    out.push(line);
  }
  return out.join('\n');
}
