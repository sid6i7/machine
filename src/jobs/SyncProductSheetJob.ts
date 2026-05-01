import type { Job, JobContext } from './Job.js';
import { SheetsClient } from '../integrations/sheets/SheetsClient.js';

const CLOSED_STATUSES = new Set(['completed', 'aborted', 'done', 'cancelled', 'closed']);

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

    for (const row of rows) {
      const status = (row.data[statusCol] || '').toLowerCase().trim();
      const externalId = (idCol && row.data[idCol]) ? row.data[idCol] : `${sheetId}:${row.rowIndex}`;
      seen.add(externalId);

      if (status && CLOSED_STATUSES.has(status)) {
        ctx.backlog.markResolved('sheet', externalId);
        resolved++;
        continue;
      }

      const title = row.data[titleCol]
        || row.data[Object.keys(row.data)[0]]
        || `Row ${row.rowIndex}`;

      const description = descCol ? (row.data[descCol] || undefined) : undefined;
      ctx.backlog.upsert({
        source: 'sheet',
        externalId,
        title: String(title).slice(0, 200),
        description: description ? String(description).slice(0, 1000) : undefined,
        url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#range=A${row.rowIndex}`,
        metadata: row.data,
      });
      upserted++;
    }

    // Anything previously open whose row vanished from the sheet entirely → resolve.
    for (const item of ctx.backlog.listOpenBySource('sheet')) {
      if (!seen.has(item.external_id)) {
        ctx.backlog.markResolved('sheet', item.external_id);
        resolved++;
      }
    }

    ctx.logger.info({ job: this.name, rows: rows.length, upserted, resolved }, 'SyncProductSheetJob done');
  }
}
