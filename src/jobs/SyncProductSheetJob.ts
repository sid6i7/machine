import type { Job, JobContext } from './Job.js';
import { SheetsClient } from '../integrations/sheets/SheetsClient.js';

const CLOSED_STATUSES = new Set(['completed', 'aborted', 'done', 'cancelled', 'closed']);
// Captures gitlab.com (or self-hosted) merge request URLs.
const MR_URL_RE = /https?:\/\/[\w./-]+\/-\/merge_requests\/(\d+)/g;

export class SyncProductSheetJob implements Job {
  name = 'SyncProductSheetJob';
  schedule = '0 * * * 1-5';
  description = 'Hourly on weekdays: pull product-sheet rows that are still open into backlog_items source=sheet.';

  async run(ctx: JobContext): Promise<void> {
    const sheetId = process.env.PRODUCT_SHEET_ID;
    const range = process.env.PRODUCT_SHEET_RANGE || 'Sheet1!A:Z';
    const statusCol = process.env.PRODUCT_SHEET_STATUS_COL || 'status';
    const titleCol = process.env.PRODUCT_SHEET_TITLE_COL || 'title';
    const descCol = process.env.PRODUCT_SHEET_DESCRIPTION_COL || '';
    const idCol = process.env.PRODUCT_SHEET_ID_COL || '';

    if (!sheetId) {
      ctx.logger.warn({ job: this.name }, 'PRODUCT_SHEET_ID missing in env; skipping');
      return;
    }

    let rows;
    try {
      rows = await new SheetsClient().listRows(sheetId, range);
    } catch (err) {
      ctx.logger.error({ err }, 'sheet read failed');
      return;
    }

    const seen = new Set<string>();
    let upserted = 0;
    let resolved = 0;
    let sheetMrLinks = 0;

    for (const row of rows) {
      const status = (row.data[statusCol] || '').toLowerCase().trim();
      const externalId = (idCol && row.data[idCol]) ? row.data[idCol] : `${sheetId}:${row.rowIndex}`;
      seen.add(externalId);

      if (status && CLOSED_STATUSES.has(status)) {
        ctx.backlog.markResolved('sheet', externalId);
        resolved++;
        continue;
      }

      const description = descCol ? (row.data[descCol] || undefined) : undefined;

      // Title preference: SA → first line of Task Details → first non-empty cell
      // (skipping status/priority/assignee/date noise) → Row N as last resort.
      const NOISE_COLS = new Set([statusCol, descCol, 'Allotted to', 'ETA', 'ATA', 'Priority', 'New Priority', 'Sprint']);
      let title: string = row.data[titleCol] || '';
      if (!title && description) {
        title = description.split('\n').find(l => l.trim().length > 0)?.trim() || '';
      }
      if (!title) {
        for (const [k, v] of Object.entries(row.data)) {
          if (NOISE_COLS.has(k) || k.startsWith('Task Updates')) continue;
          const s = String(v || '').trim();
          if (s.length > 2) { title = s; break; }
        }
      }
      if (!title) title = `Row ${row.rowIndex}`;
      ctx.backlog.upsert({
        source: 'sheet',
        externalId,
        title: String(title).slice(0, 200),
        description: description ? String(description).slice(0, 1000) : undefined,
        url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#range=A${row.rowIndex}`,
        metadata: row.data,
      });
      upserted++;

      // Scan every cell value for gitlab MR URLs and link to the matching
      // gitlab backlog item if we already have it.
      const sheetItem = ctx.backlog.findByExternalId('sheet', externalId);
      if (!sheetItem) continue;
      for (const value of Object.values(row.data)) {
        if (typeof value !== 'string') continue;
        const matches = value.matchAll(MR_URL_RE);
        for (const m of matches) {
          const url = m[0];
          // Parse project namespace + iid. project_id isn't in the URL, so we
          // look up by the URL substring instead.
          const iid = m[1];
          // Find gitlab backlog rows whose URL ends with /-/merge_requests/<iid>
          const candidate = ctx.db.prepare(`
            SELECT id, external_id FROM backlog_items
            WHERE source = 'gitlab' AND url LIKE ?
            LIMIT 1
          `).get(url) as { id: number; external_id: string } | undefined;
          if (candidate) {
            ctx.backlog.addLink(sheetItem.id, candidate.id, 'sheet_mr', 'sheet_column', 1.0);
            sheetMrLinks++;
          }
          // Reset regex lastIndex when using matchAll iter — not needed but defensive.
          MR_URL_RE.lastIndex = 0;
        }
      }
    }

    // Anything previously open whose row vanished from the sheet entirely → resolve.
    for (const item of ctx.backlog.listOpenBySource('sheet')) {
      if (!seen.has(item.external_id)) {
        ctx.backlog.markResolved('sheet', item.external_id);
        resolved++;
      }
    }

    ctx.logger.info({ job: this.name, rows: rows.length, upserted, resolved, sheetMrLinks }, 'SyncProductSheetJob done');
  }
}
