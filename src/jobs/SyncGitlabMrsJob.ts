import type { Job, JobContext } from './Job.js';
import { GitlabClient } from '../integrations/gitlab/GitlabClient.js';

export class SyncGitlabMrsJob implements Job {
  name = 'SyncGitlabMrsJob';
  schedule = '5 * * * 1-5';
  description = 'Hourly+5m on weekdays: pull open GitLab MRs targeting staging/prod into backlog_items source=gitlab.';

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

    for (const pid of projectIds) {
      let mrs;
      try { mrs = await client.listOpenMRsForProject(pid); }
      catch (err) { ctx.logger.error({ err, projectId: pid }, 'fetch MRs failed'); continue; }

      for (const mr of mrs) {
        if (!targetBranches.includes(mr.target_branch)) continue;
        const externalId = `${mr.project_id}:${mr.iid}`;
        seen.add(externalId);
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

    ctx.logger.info({ job: this.name, projects: projectIds.length, upserted, resolved }, 'SyncGitlabMrsJob done');
  }
}
