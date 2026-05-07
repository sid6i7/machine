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

// Split a `| a | b |` table row into cells. Trims outer pipes + whitespace.
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    // GitHub-flavored table: header row, separator (---|---), then body rows.
    if (line.trim().startsWith('|') && idx + 1 < lines.length && TABLE_SEP.test(lines[idx + 1])) {
      closeList();
      const header = splitTableRow(line);
      idx++; // skip the separator
      const bodyRows: string[][] = [];
      while (idx + 1 < lines.length && lines[idx + 1].trim().startsWith('|')) {
        idx++;
        // Some sources (e.g. LLM output, copy-pasted tables) emit a separator
        // row between every data row. Skip those — they're not real data.
        if (TABLE_SEP.test(lines[idx])) continue;
        bodyRows.push(splitTableRow(lines[idx]));
      }
      const thead = `<thead><tr>${header.map(c =>
        `<th class="px-2 py-1 text-left font-medium border border-slate-300 bg-slate-50">${inline(esc(c))}</th>`
      ).join('')}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map(r =>
        `<tr>${r.map(c => `<td class="px-2 py-1 align-top border border-slate-200">${inline(esc(c))}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;
      out.push(`<table class="my-2 text-xs border-collapse border border-slate-300">${thead}${tbody}</table>`);
      continue;
    }

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
