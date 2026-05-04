import { SheetsClient, MR_URL_RE } from './SheetsClient.js';
import type { PendingSheetEdit } from '../../db/repos/SheetEditQueueRepo.js';

export class SheetEditSkipped extends Error {
  constructor(reason: string) { super(reason); this.name = 'SheetEditSkipped'; }
}

// Reads headers + the row's current values, refuses if any cell already
// contains an MR URL (we treat the sheet as authoritative — never overwrite),
// then appends `\n<append_text>\n` to the target column's cell.
//
// Throws SheetEditSkipped on the guard trip so the caller can mark 'skipped'
// rather than 'error'.
export async function applySheetEdit(edit: PendingSheetEdit): Promise<void> {
  const client = new SheetsClient();

  const headers = await client.getHeaders(edit.sheet_id, edit.tab);
  if (headers.length === 0) throw new Error(`sheet "${edit.tab}" has no header row`);
  const colIndex = headers.findIndex(h => h.startsWith(edit.column_match));
  if (colIndex < 0) throw new Error(`no column header starts with "${edit.column_match}"`);

  const row = await client.getRowValues(edit.sheet_id, edit.tab, edit.row_index, headers.length);
  for (const v of row) {
    if (v && MR_URL_RE.test(v)) {
      MR_URL_RE.lastIndex = 0;
      throw new SheetEditSkipped('MR URL already present on this row');
    }
    MR_URL_RE.lastIndex = 0;
  }

  const existing = row[colIndex] || '';
  const newValue = existing.length === 0
    ? `${edit.append_text}\n`
    : `${existing}\n${edit.append_text}\n`;

  await client.updateCell(edit.sheet_id, edit.tab, edit.row_index, colIndex, newValue);
}
