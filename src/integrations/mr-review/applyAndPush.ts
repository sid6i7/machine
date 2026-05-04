import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MrReviewsRepo, MrReview, MrReviewSuggestion } from '../../db/repos/MrReviewsRepo.js';
import { WorktreeManager } from './WorktreeManager.js';

const execFileP = promisify(execFile);

export interface ApplyAndPushResult {
  applied: number;
  failed: Array<{ id: number; reason: string }>;
  pushCommitSha: string | null;
}

// Submit step: walk every 'accepted' suggestion for the review, do literal
// string replacement in its file, then `git add -A && git commit && git push`
// from the worktree. Suggestions with no exact match are marked 'apply_failed'
// and the rest still proceed.
export async function applyAndPush(
  repo: MrReviewsRepo,
  review: MrReview,
): Promise<ApplyAndPushResult> {
  if (!review.worktree_path) throw new Error(`review ${review.id} has no worktree_path`);
  const wt = review.worktree_path;
  if (!fs.existsSync(wt)) throw new Error(`worktree ${wt} no longer exists`);

  const suggestions = repo.listSuggestions(review.id).filter(s => s.status === 'accepted');
  if (suggestions.length === 0) {
    return { applied: 0, failed: [], pushCommitSha: null };
  }

  const failed: Array<{ id: number; reason: string }> = [];
  let appliedCount = 0;

  // Group by file so we apply all suggestions to a file in one read/write
  // cycle. Apply in reverse line order within a file to keep line numbers
  // stable across edits — though we do literal replacement, ordering also
  // protects against overlapping ranges.
  const byFile = new Map<string, MrReviewSuggestion[]>();
  for (const s of suggestions) {
    const arr = byFile.get(s.file) || [];
    arr.push(s);
    byFile.set(s.file, arr);
  }

  for (const [file, sugs] of byFile.entries()) {
    const abs = path.join(wt, file);
    if (!fs.existsSync(abs)) {
      for (const s of sugs) {
        repo.setSuggestionStatus(s.id, 'apply_failed', `file not found: ${file}`);
        failed.push({ id: s.id, reason: 'file not found' });
      }
      continue;
    }
    let content = fs.readFileSync(abs, 'utf8');
    sugs.sort((a, b) => b.line_start - a.line_start);
    for (const s of sugs) {
      const idx = content.indexOf(s.original);
      if (idx < 0) {
        repo.setSuggestionStatus(s.id, 'apply_failed', `original text not found in ${file}`);
        failed.push({ id: s.id, reason: 'original not found in file (drifted?)' });
        continue;
      }
      // Guard: if original appears more than once we refuse rather than guess.
      const second = content.indexOf(s.original, idx + s.original.length);
      if (second >= 0) {
        repo.setSuggestionStatus(s.id, 'apply_failed', `ambiguous match: original text appears multiple times in ${file}`);
        failed.push({ id: s.id, reason: 'ambiguous match (multiple occurrences)' });
        continue;
      }
      content = content.slice(0, idx) + s.replacement + content.slice(idx + s.original.length);
      repo.setSuggestionStatus(s.id, 'applied');
      appliedCount++;
    }
    fs.writeFileSync(abs, content);
  }

  if (appliedCount === 0) {
    return { applied: 0, failed, pushCommitSha: null };
  }

  const userName  = process.env.MR_REVIEW_GIT_USER_NAME  || 'BeyondChats Bot';
  const userEmail = process.env.MR_REVIEW_GIT_USER_EMAIL || 'bot@beyondchats.com';
  const env = { ...process.env, GIT_AUTHOR_NAME: userName, GIT_AUTHOR_EMAIL: userEmail, GIT_COMMITTER_NAME: userName, GIT_COMMITTER_EMAIL: userEmail };

  await execFileP('git', ['-C', wt, 'add', '-A'], { env });
  const msg = `AI review fixes (Sid-approved) — review #${review.id}\n\n${appliedCount} suggestion(s) applied across ${byFile.size} file(s).\nMR: ${review.mr_url}`;
  await execFileP('git', ['-C', wt, 'commit', '-m', msg], { env });
  const sha = (await execFileP('git', ['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();

  const projectId = Number(review.mr_external_id.split(':')[0]);
  const wtMgr = new WorktreeManager();
  await wtMgr.pushBranch(projectId, review.project_path, wt, review.source_branch);

  return { applied: appliedCount, failed, pushCommitSha: sha };
}
