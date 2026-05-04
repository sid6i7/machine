import 'dotenv/config';
import { migrate } from '../db/migrate.js';
import { getDatabase } from '../db/Database.js';
import { SheetEditQueueRepo } from '../db/repos/SheetEditQueueRepo.js';
import { MR_URL_RE } from '../integrations/sheets/SheetsClient.js';
import { logger } from '../utils/logger.js';

// One-shot: walk every existing sheet_mr link in backlog_links and enqueue a
// pending sheet edit (subject to the "row already mentions an MR URL" guard).
// Idempotent: dedupKey on the enqueue means re-running won't duplicate.
async function main() {
  migrate();
  const db = getDatabase();
  const sheetEdits = new SheetEditQueueRepo(db);

  const links = db.prepare(`
    SELECT
      l.parent_id           AS sheet_id_pk,
      l.child_id            AS mr_id_pk,
      sheet.id              AS sheet_pk,
      sheet.external_id     AS sheet_external_id,
      sheet.metadata_json   AS sheet_metadata_json,
      mr.url                AS mr_url,
      mr.id                 AS mr_pk
    FROM backlog_links l
    JOIN backlog_items sheet ON sheet.id = l.parent_id AND sheet.source = 'sheet'
    JOIN backlog_items mr    ON mr.id    = l.child_id  AND mr.source    = 'gitlab'
    WHERE l.link_type = 'sheet_mr'
  `).all() as Array<{
    sheet_pk: number;
    sheet_external_id: string;
    sheet_metadata_json: string | null;
    mr_url: string | null;
    mr_pk: number;
  }>;

  const tab = parseTabFromRange(process.env.PRODUCT_SHEET_RANGE || 'Sheet1!A:Z');

  let enqueued = 0, skippedHasMr = 0, skippedNoUrl = 0, dedup = 0;
  for (const l of links) {
    if (!l.mr_url) { skippedNoUrl++; continue; }

    // Guard: skip if any cell on the row already mentions an MR URL. The
    // metadata_json snapshot is the same one the live SyncProductSheetJob
    // wrote on its last run — good enough for backfill triage; the runtime
    // guard re-checks at apply time.
    const meta = safeJsonObj(l.sheet_metadata_json || '');
    let hasMr = false;
    for (const v of Object.values(meta)) {
      if (typeof v === 'string' && MR_URL_RE.test(v)) { hasMr = true; }
      MR_URL_RE.lastIndex = 0;
      if (hasMr) break;
    }
    if (hasMr) { skippedHasMr++; continue; }

    const [sheetId, rowIdxStr] = l.sheet_external_id.split(':');
    const rowIndex = Number(rowIdxStr);
    if (!sheetId || !rowIndex) { skippedNoUrl++; continue; }

    const before = sheetEdits.pendingCount();
    sheetEdits.enqueue({
      sheetId,
      tab,
      rowIndex,
      columnMatch: 'Task Updates',
      appendText: `MR: ${l.mr_url}`,
      kind: 'mr_link',
      context: { sheetItemId: l.sheet_pk, mrItemId: l.mr_pk, mrUrl: l.mr_url, source: 'backfill' },
      dedupKey: `mr_link:${l.mr_url}`,
    });
    if (sheetEdits.pendingCount() === before) dedup++;
    else enqueued++;
  }

  logger.info({ links: links.length, enqueued, skippedHasMr, skippedNoUrl, dedup }, 'backfill:sheet-mr-edits done');
  process.exit(0);
}

function parseTabFromRange(range: string): string {
  const i = range.lastIndexOf('!');
  if (i < 0) return range;
  return range.slice(0, i).replace(/^'|'$/g, '');
}

function safeJsonObj(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

main().catch(err => {
  logger.error({ err }, 'backfill:sheet-mr-edits failed');
  process.exit(1);
});
