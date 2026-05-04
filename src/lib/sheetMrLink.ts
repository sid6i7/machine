import type { JobContext } from '../jobs/Job.js';
import type { BacklogItem } from '../db/repos/BacklogRepo.js';
import { MR_URL_RE } from '../integrations/sheets/SheetsClient.js';
import { GitlabClient } from '../integrations/gitlab/GitlabClient.js';

export type LinkMrResult =
  | { ok: true; mrItem: BacklogItem; alreadyLinked: boolean; sheetEdit: EnqueueSheetMrResult }
  | { ok: false; error: string };

// Manually link an MR (by URL) to a sheet backlog item. If the MR is already
// in `backlog_items`, reuses it; otherwise fetches from GitLab and upserts a
// new row. Idempotent — a duplicate sheet_mr link is a no-op.
export async function linkMrUrlToSheetTask(
  ctx: JobContext,
  sheetItem: BacklogItem,
  mrUrl: string,
): Promise<LinkMrResult> {
  if (sheetItem.source !== 'sheet') {
    return { ok: false, error: 'target item is not a sheet task' };
  }

  const parsed = parseGitlabMrUrl(mrUrl);
  if (!parsed) return { ok: false, error: 'unrecognised GitLab MR URL' };

  const baseUrl = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/+$/, '');
  if (!mrUrl.startsWith(baseUrl)) {
    return { ok: false, error: `URL does not match GITLAB_BASE_URL (${baseUrl})` };
  }

  // Try to reuse an already-synced MR row.
  let mrItem: BacklogItem | undefined;
  const existingByUrl = ctx.db.prepare(
    `SELECT * FROM backlog_items WHERE source = 'gitlab' AND url = ? LIMIT 1`
  ).get(mrUrl) as BacklogItem | undefined;
  if (existingByUrl) {
    mrItem = existingByUrl;
  } else {
    let client: GitlabClient;
    try { client = new GitlabClient(); }
    catch (err) { return { ok: false, error: (err as Error).message }; }

    let projectId: number;
    try { projectId = await client.getProjectIdByPath(parsed.projectPath); }
    catch (err) { return { ok: false, error: `could not resolve project ${parsed.projectPath}: ${(err as Error).message}` }; }

    let mr;
    try { mr = await client.getMR(projectId, parsed.iid); }
    catch (err) { return { ok: false, error: `could not fetch MR: ${(err as Error).message}` }; }

    const externalId = `${mr.project_id}:${mr.iid}`;
    ctx.backlog.upsert({
      source: 'gitlab',
      externalId,
      title: `[${mr.target_branch}] ${mr.title}`,
      url: mr.web_url,
      metadata: {
        author: mr.author,
        source_branch: mr.source_branch,
        updated_at: mr.updated_at,
      },
    });
    if (mr.state !== 'opened') {
      // Already merged/closed — mark resolved so it doesn't pollute the open backlog.
      ctx.backlog.markResolved('gitlab', externalId);
    }
    mrItem = ctx.backlog.findByExternalId('gitlab', externalId);
    if (!mrItem) return { ok: false, error: 'failed to upsert MR row' };
  }

  // Dedup the link itself.
  const existingLink = ctx.db.prepare(
    `SELECT 1 FROM backlog_links WHERE parent_id = ? AND child_id = ? AND link_type = 'sheet_mr' LIMIT 1`
  ).get(sheetItem.id, mrItem.id);
  const alreadyLinked = !!existingLink;

  ctx.backlog.addLink(sheetItem.id, mrItem.id, 'sheet_mr', 'manual', 1.0);

  const sheetEdit = enqueueSheetMrAppend(ctx, sheetItem, mrItem.id, mrItem.url || mrUrl);

  return { ok: true, mrItem, alreadyLinked, sheetEdit };
}

// Parses URLs like:
//   https://gitlab.com/group/repo/-/merge_requests/42
//   https://gitlab.example.com/g/sub/repo/-/merge_requests/7
function parseGitlabMrUrl(url: string): { projectPath: string; iid: number } | null {
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (!m) return null;
  return { projectPath: m[1], iid: Number(m[2]) };
}

// When a sheet task is linked to an MR, queue a pending edit that appends
// "MR: <url>" to the row's "Task Updates" cell. Skipped if any cell on the row
// already mentions an MR URL (we treat the sheet as authoritative — never
// overwrite the human's existing notation).
export type EnqueueSheetMrResult =
  | { status: 'enqueued' | 'deduped'; editId: number }
  | { status: 'skipped_already_in_cell' | 'skipped_bad_external_id' };

export function enqueueSheetMrAppend(
  ctx: JobContext,
  sheetItem: { id: number; external_id: string; metadata_json: string | null },
  mrItemId: number,
  mrUrl: string,
): EnqueueSheetMrResult {
  const meta = sheetItem.metadata_json ? safeJsonObj(sheetItem.metadata_json) : {};
  for (const v of Object.values(meta)) {
    if (typeof v === 'string' && MR_URL_RE.test(v)) {
      MR_URL_RE.lastIndex = 0;
      return { status: 'skipped_already_in_cell' };
    }
    MR_URL_RE.lastIndex = 0;
  }

  const [sheetId, rowIdxStr] = sheetItem.external_id.split(':');
  const rowIndex = Number(rowIdxStr);
  if (!sheetId || !rowIndex) return { status: 'skipped_bad_external_id' };

  const tab = parseTabFromRange(process.env.PRODUCT_SHEET_RANGE || 'Sheet1!A:Z');

  // Detect dedupe vs fresh insert by comparing the highest existing edit id
  // before/after — enqueue() returns the existing row when dedupKey hits.
  const beforeMaxRow = ctx.db.prepare(
    `SELECT IFNULL(MAX(id), 0) AS m FROM pending_sheet_edits`
  ).get() as { m: number };

  const edit = ctx.sheetEdits.enqueue({
    sheetId,
    tab,
    rowIndex,
    columnMatch: 'Task Updates',
    appendText: `MR: ${mrUrl}`,
    kind: 'mr_link',
    context: { sheetItemId: sheetItem.id, mrItemId, mrUrl },
    dedupKey: `mr_link:${mrUrl}`,
  });

  return {
    status: edit.id > beforeMaxRow.m ? 'enqueued' : 'deduped',
    editId: edit.id,
  };
}

function parseTabFromRange(range: string): string {
  const i = range.lastIndexOf('!');
  if (i < 0) return range;
  const tab = range.slice(0, i);
  return tab.replace(/^'|'$/g, '');
}

function safeJsonObj(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
