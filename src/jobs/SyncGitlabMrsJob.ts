import type { Job, JobContext } from './Job.js';
import { GitlabClient } from '../integrations/gitlab/GitlabClient.js';
import { MR_URL_RE } from '../integrations/sheets/SheetsClient.js';
import {
  matchUpdateToTaskSystem,
  matchUpdateToTaskSchema,
  buildMatchUpdateToTaskUser,
  type MatchUpdateToTaskOutput,
} from '../llm/prompts/matchUpdateToTask.js';

export class SyncGitlabMrsJob implements Job {
  name = 'SyncGitlabMrsJob';
  schedule = '* * * * 1-5';
  description = 'Every minute on weekdays: pull open GitLab MRs targeting staging/prod into backlog_items source=gitlab.';

  async run(ctx: JobContext): Promise<void> {
    const projectIdsRaw = process.env.GITLAB_PROJECT_IDS || '';
    const targetBranches = (process.env.GITLAB_TARGET_BRANCHES || 'staging,prod')
      .split(',').map(s => s.trim()).filter(Boolean);
    const projectIds = projectIdsRaw.split(',').map(s => s.trim()).filter(Boolean).map(Number);

    if (projectIds.length === 0) {
      ctx.logger.warn({ job: this.name }, 'GITLAB_PROJECT_IDS missing in env; skipping');
      return;
    }

    let client: GitlabClient;
    try { client = new GitlabClient(); }
    catch (err) { ctx.logger.error({ err }, 'GitlabClient init failed'); return; }

    const seen = new Set<string>();
    let upserted = 0;
    let newMrs = 0;
    let llmLinked = 0;

    for (const pid of projectIds) {
      let mrs;
      try { mrs = await client.listOpenMRsForProject(pid); }
      catch (err) { ctx.logger.error({ err, projectId: pid }, 'fetch MRs failed'); continue; }

      for (const mr of mrs) {
        if (!targetBranches.includes(mr.target_branch)) continue;
        const externalId = `${mr.project_id}:${mr.iid}`;
        seen.add(externalId);

        const existed = ctx.backlog.findByExternalId('gitlab', externalId);

        ctx.backlog.upsert({
          source: 'gitlab',
          externalId,
          title: `[${mr.target_branch}] ${mr.title}`,
          url: mr.web_url,
          metadata: {
            author: mr.author,
            source_branch: mr.source_branch,
            updated_at: mr.updated_at
          },
        });
        upserted++;

        // For genuinely-new MRs, fuzzy-match against open sheet + wa_task items.
        if (!existed) {
          newMrs++;
          const mrItem = ctx.backlog.findByExternalId('gitlab', externalId);
          if (!mrItem) continue;

          // Keyword pre-filter: only send the LLM candidates whose title or
          // description overlaps a meaningful word from the MR title or branch.
          // Without this, slicing the first 50 of ~1000 open items almost
          // never yields the right match.
          const stop = new Set(['the','a','an','and','or','of','for','fix','feat','chore','add','update','prod','staging','dev','to','on','in','by','with','wip','from','that','this','will','etc','and','as','is','it','be','at','do']);
          const tokens = `${mr.title} ${mr.source_branch}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !stop.has(w));
          const uniq = Array.from(new Set(tokens)).slice(0, 8);

          let candidates: typeof mrItem extends never ? never[] : Array<{ id: number; title: string; description: string | null }> = [];
          if (uniq.length > 0) {
            const conds = uniq.map(() => '(LOWER(title) LIKE ? OR LOWER(IFNULL(description,\'\')) LIKE ?)').join(' OR ');
            const params = uniq.flatMap(k => [`%${k}%`, `%${k}%`]);
            candidates = ctx.db.prepare(`
              SELECT id, title, description FROM backlog_items
              WHERE status = 'open' AND source IN ('sheet','wa_task') AND (${conds})
              ORDER BY source, created_at DESC
              LIMIT 30
            `).all(...params) as typeof candidates;
          }
          if (candidates.length === 0) continue;
          try {
            const r = await ctx.gemini.classify<MatchUpdateToTaskOutput>({
              system: matchUpdateToTaskSystem,
              user: buildMatchUpdateToTaskUser({
                sender: mr.author || 'gitlab',
                updateText: `MR title: ${mr.title}\nSource branch: ${mr.source_branch}\nTarget: ${mr.target_branch}`,
                openItems: candidates.map((c: { id: number; title: string; description: string | null }) => ({ id: c.id, title: c.title, description: c.description ?? undefined })),
              }),
              schema: matchUpdateToTaskSchema,
            });
            if (r.data.matched_id && r.data.confidence >= 0.7) {
              const parent = ctx.backlog.findById(Number(r.data.matched_id));
              const linkType = parent?.source === 'sheet' ? 'sheet_mr' : 'wa_task_mr';
              ctx.backlog.addLink(Number(r.data.matched_id), mrItem.id, linkType, 'llm', r.data.confidence);
              llmLinked++;
              if (parent?.source === 'sheet') {
                enqueueSheetMrAppend(ctx, parent, mrItem.id, mr.web_url);
              }
            }
          } catch (err) {
            ctx.logger.error({ err, mr: externalId }, 'matchUpdateToTask (MR) failed');
          }
        }
      }
    }

    // Items previously open but no longer in the open list (merged, closed, retargeted)
    let resolved = 0;
    for (const item of ctx.backlog.listOpenBySource('gitlab')) {
      if (!seen.has(item.external_id)) {
        ctx.backlog.markResolved('gitlab', item.external_id);
        resolved++;
      }
    }

    // Phase 6: capture merged MRs into gitlab_merged_log so the weekly summary
    // can answer "what did we ship this week?". Pagination stops on first
    // already-known external_id (cheap incremental sync).
    let mergedNew = 0;
    for (const pid of projectIds) {
      let merged: Awaited<ReturnType<typeof client.listMergedMRsForProject>>;
      try { merged = await client.listMergedMRsForProject(pid, { maxPages: 3 }); }
      catch (err) { ctx.logger.error({ err, projectId: pid }, 'fetch merged MRs failed'); continue; }
      for (const mr of merged) {
        if (!targetBranches.includes(mr.target_branch)) continue;
        const externalId = `${mr.project_id}:${mr.iid}`;
        if (ctx.mergedMrs.has(externalId)) continue;     // dedup → bail rest of page silently
        const mergedAt = mr.merged_at ? Date.parse(mr.merged_at) : Date.parse(mr.updated_at);
        if (isNaN(mergedAt)) continue;
        ctx.mergedMrs.upsert({
          externalId,
          title: mr.title,
          author: mr.author,
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
          mergedAt,
          url: mr.web_url,
          metadata: { author: mr.author, source_branch: mr.source_branch },
        });
        mergedNew++;
      }
    }

    ctx.logger.info({ job: this.name, projects: projectIds.length, upserted, resolved, newMrs, llmLinked, mergedNew }, 'SyncGitlabMrsJob done');
  }
}

// When the LLM links a sheet task to an MR, queue a pending edit that appends
// "MR: <url>" to the row's "Task Updates" cell. Skipped if any cell on the row
// already mentions an MR URL (we treat the sheet as authoritative — never
// overwrite the human's existing notation).
function enqueueSheetMrAppend(
  ctx: JobContext,
  sheetItem: { id: number; external_id: string; metadata_json: string | null },
  mrItemId: number,
  mrUrl: string,
): void {
  const meta = sheetItem.metadata_json ? safeJsonObj(sheetItem.metadata_json) : {};
  for (const v of Object.values(meta)) {
    if (typeof v === 'string' && MR_URL_RE.test(v)) {
      MR_URL_RE.lastIndex = 0;
      return;
    }
    MR_URL_RE.lastIndex = 0;
  }

  const [sheetId, rowIdxStr] = sheetItem.external_id.split(':');
  const rowIndex = Number(rowIdxStr);
  if (!sheetId || !rowIndex) return;

  const tab = parseTabFromRange(process.env.PRODUCT_SHEET_RANGE || 'Sheet1!A:Z');

  ctx.sheetEdits.enqueue({
    sheetId,
    tab,
    rowIndex,
    columnMatch: 'Task Updates',
    appendText: `MR: ${mrUrl}`,
    kind: 'mr_link',
    context: { sheetItemId: sheetItem.id, mrItemId, mrUrl },
    dedupKey: `mr_link:${mrUrl}`,
  });
}

function parseTabFromRange(range: string): string {
  const i = range.lastIndexOf('!');
  if (i < 0) return range;
  const tab = range.slice(0, i);
  // Sheets API returns the tab quoted if it contains spaces — strip quotes if present.
  return tab.replace(/^'|'$/g, '');
}

function safeJsonObj(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
