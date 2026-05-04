import path from 'path';
import fs from 'fs';
import { google, type sheets_v4 } from 'googleapis';
import { logger } from '../../utils/logger.js';

function findServiceAccountPath(): string | null {
  const credsDir = path.resolve(process.cwd(), 'creds');
  if (!fs.existsSync(credsDir)) return null;
  const candidate = fs.readdirSync(credsDir).find(f => f.endsWith('.json'));
  return candidate ? path.join(credsDir, candidate) : null;
}

let _service: sheets_v4.Sheets | null = null;

async function getService(): Promise<sheets_v4.Sheets> {
  if (_service) return _service;
  const keyFile = findServiceAccountPath();
  if (!keyFile) {
    throw new Error('Google service account JSON not found in creds/. Place it there and share the sheet with the SA email.');
  }
  // Read-write scope. The SA still only writes to sheets it's been shared on
  // with editor permission, so the broader scope doesn't expand reach beyond
  // the sheets we explicitly grant access to.
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  _service = google.sheets({ version: 'v4', auth: client as any });
  logger.info({ keyFile }, 'SheetsClient initialized');
  return _service;
}

export interface SheetRow {
  rowIndex: number;             // 1-based row index in the sheet
  data: Record<string, string>; // header → cell value
}

function colIndexToA1(idx0: number): string {
  // 0 -> A, 25 -> Z, 26 -> AA …
  let n = idx0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export class SheetsClient {
  // First row of the range is treated as the header.
  async listRows(sheetId: string, range: string): Promise<SheetRow[]> {
    const service = await getService();
    const resp = await service.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const values = resp.data.values || [];
    if (values.length === 0) return [];
    const headers = (values[0] || []).map(String);
    const rows: SheetRow[] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i] || [];
      const data: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        data[headers[j]] = String(row[j] ?? '');
      }
      rows.push({ rowIndex: i + 1, data });
    }
    return rows;
  }

  // Returns the header row of the given tab (raw cell strings, 0-indexed by column).
  async getHeaders(sheetId: string, tab: string): Promise<string[]> {
    const service = await getService();
    const resp = await service.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tab}!1:1`,
    });
    return ((resp.data.values || [])[0] || []).map(String);
  }

  async getCell(sheetId: string, tab: string, rowIndex: number, colIndex0: number): Promise<string> {
    const service = await getService();
    const a1 = `${tab}!${colIndexToA1(colIndex0)}${rowIndex}`;
    const resp = await service.spreadsheets.values.get({ spreadsheetId: sheetId, range: a1 });
    const v = (resp.data.values || [])[0]?.[0];
    return v == null ? '' : String(v);
  }

  async getRowValues(sheetId: string, tab: string, rowIndex: number, columnCount: number): Promise<string[]> {
    if (columnCount <= 0) return [];
    const service = await getService();
    const range = `${tab}!A${rowIndex}:${colIndexToA1(columnCount - 1)}${rowIndex}`;
    const resp = await service.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const row = (resp.data.values || [])[0] || [];
    const out: string[] = [];
    for (let i = 0; i < columnCount; i++) out.push(row[i] != null ? String(row[i]) : '');
    return out;
  }

  async updateCell(sheetId: string, tab: string, rowIndex: number, colIndex0: number, value: string): Promise<void> {
    const service = await getService();
    const a1 = `${tab}!${colIndexToA1(colIndex0)}${rowIndex}`;
    await service.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: a1,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}

// Captures gitlab.com (or self-hosted) merge request URLs. Exported so callers
// (sheet edit guard, sync jobs) can share one definition.
export const MR_URL_RE = /https?:\/\/[\w./-]+\/-\/merge_requests\/\d+/g;
