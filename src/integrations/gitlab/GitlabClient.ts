// Lightweight GitLab REST client. Uses native fetch and a personal access
// token. Only needs read_api scope.

export interface GitlabMR {
  iid: number;
  project_id: number;
  title: string;
  author: string;
  target_branch: string;
  source_branch: string;
  state: string;                  // 'opened' | 'merged' | 'closed'
  web_url: string;
  updated_at: string;
}

export class GitlabClient {
  private base: string;
  private token: string;

  constructor() {
    this.base = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/+$/, '');
    this.token = process.env.GITLAB_TOKEN || '';
    if (!this.token) {
      throw new Error('GITLAB_TOKEN is missing. Set it in .env.');
    }
  }

  private async fetchJson(pathWithQuery: string): Promise<unknown> {
    const url = `${this.base}/api/v4${pathWithQuery}`;
    const resp = await fetch(url, { headers: { 'PRIVATE-TOKEN': this.token } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GitLab ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }

  // Lists open MRs for one project, with pagination collected.
  async listOpenMRsForProject(projectId: number): Promise<GitlabMR[]> {
    const out: GitlabMR[] = [];
    for (let page = 1; page <= 10; page++) {
      const items = await this.fetchJson(
        `/projects/${projectId}/merge_requests?state=opened&per_page=100&page=${page}`
      ) as Array<Record<string, unknown>>;
      if (items.length === 0) break;
      for (const it of items) {
        out.push({
          iid: Number(it.iid),
          project_id: Number(it.project_id),
          title: String(it.title || ''),
          author: String((it.author as { name?: string })?.name || ''),
          target_branch: String(it.target_branch || ''),
          source_branch: String(it.source_branch || ''),
          state: String(it.state || ''),
          web_url: String(it.web_url || ''),
          updated_at: String(it.updated_at || ''),
        });
      }
      if (items.length < 100) break;
    }
    return out;
  }
}
