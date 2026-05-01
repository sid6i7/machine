import path from 'path';
import fs from 'fs';
import { google, type sheets_v4 } from 'googleapis';
import { logger } from '../../utils/logger.js';

// Locate the service account JSON dropped under creds/. Plays well with the
// existing repo convention (creds/ is gitignored).
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
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
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
}
