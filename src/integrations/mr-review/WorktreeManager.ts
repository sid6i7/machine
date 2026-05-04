import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

// Per-project bare cache + per-review worktree. Bare cache lives at
// <root>/<project_id>/cache.git; worktrees at <root>/<project_id>/worktrees/<key>.
//
// Bare cache is shared across reviews of the same project so disk + bandwidth
// stay bounded; worktrees are cheap (just checked-out files).
export class WorktreeManager {
  constructor(
    private root = process.env.MR_REVIEW_REPO_DIR || 'data/repos',
    private base = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/+$/, ''),
    private token = process.env.GITLAB_TOKEN || '',
  ) {
    if (!this.token) throw new Error('GITLAB_TOKEN missing');
  }

  private cacheDir(projectId: number | string): string {
    return path.resolve(this.root, String(projectId), 'cache.git');
  }
  private worktreesDir(projectId: number | string): string {
    return path.resolve(this.root, String(projectId), 'worktrees');
  }
  private cloneUrl(projectPath: string): string {
    // oauth2:<token>@host/<path>.git — same scheme works for both push & fetch.
    const host = this.base.replace(/^https?:\/\//, '');
    return `https://oauth2:${this.token}@${host}/${projectPath}.git`;
  }

  async ensureCache(projectId: number | string, projectPath: string): Promise<string> {
    const cache = this.cacheDir(projectId);
    if (!fs.existsSync(cache)) {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      await execFileP('git', ['clone', '--bare', this.cloneUrl(projectPath), cache]);
    }
    // refresh: fetch all branches into cache. --prune removes deleted refs.
    await execFileP('git', ['--git-dir', cache, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*']);
    return cache;
  }

  async addWorktree(projectId: number | string, projectPath: string, branch: string, key: string): Promise<string> {
    const cache = await this.ensureCache(projectId, projectPath);
    const wtDir = this.worktreesDir(projectId);
    fs.mkdirSync(wtDir, { recursive: true });
    const wt = path.join(wtDir, key);
    if (fs.existsSync(wt)) {
      // Stale leftover — remove it first.
      await this.removeWorktreeQuietly(cache, wt);
    }
    // Detached HEAD at the source branch tip. We don't want to mess with
    // local branch creation/tracking — submit-time push uses an explicit
    // refspec.
    await execFileP('git', ['--git-dir', cache, 'worktree', 'add', '--detach', wt, branch]);
    return wt;
  }

  async removeWorktree(projectId: number | string, wtPath: string): Promise<void> {
    const cache = this.cacheDir(projectId);
    if (!fs.existsSync(cache)) return;
    await this.removeWorktreeQuietly(cache, wtPath);
  }

  private async removeWorktreeQuietly(cacheDir: string, wt: string): Promise<void> {
    try { await execFileP('git', ['--git-dir', cacheDir, 'worktree', 'remove', '--force', wt]); }
    catch { /* fall through to manual rm */ }
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Used by ApplyAndPush to push the source branch back to origin.
  async pushBranch(projectId: number | string, projectPath: string, wtPath: string, branch: string): Promise<void> {
    const cache = this.cacheDir(projectId);
    // Ensure the remote URL on the cache has the auth token (it was set at
    // clone time, but rotate-safe to overwrite each push).
    await execFileP('git', ['--git-dir', cache, 'remote', 'set-url', 'origin', this.cloneUrl(projectPath)]);
    // Push from worktree HEAD to the named branch on origin.
    await execFileP('git', ['-C', wtPath, 'push', 'origin', `HEAD:refs/heads/${branch}`]);
  }
}

// Parse "namespace/repo" from a GitLab MR web URL like
//   https://gitlab.com/Pankaj-Baranwal/chatgpt3_backend/-/merge_requests/717
export function projectPathFromMrUrl(mrUrl: string): string | null {
  const m = mrUrl.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/);
  return m ? m[1] : null;
}
