import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import type { Logger } from 'pino';
import type { MrReviewsRepo, SuggestionSeverity } from '../../db/repos/MrReviewsRepo.js';
import { WorktreeManager, projectPathFromMrUrl } from './WorktreeManager.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';

// stream-json events we care about. The full schema is much bigger; we only
// parse what we need.
interface StreamJsonAssistantContentText { type: 'text'; text: string }
interface StreamJsonAssistantContentTool { type: 'tool_use'; name: string; input: unknown }
interface StreamJsonAssistantContentThink { type: 'thinking'; thinking: string }
type StreamJsonAssistantContent =
  | StreamJsonAssistantContentText
  | StreamJsonAssistantContentTool
  | StreamJsonAssistantContentThink
  | { type: string };

interface StreamJsonEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'rate_limit_event' | string;
  subtype?: string;
  session_id?: string;
  message?: { content?: StreamJsonAssistantContent[] };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
}

const SUGGEST_RE = /```suggest-fix\s*\n([\s\S]*?)\n```/g;

interface ParsedSuggestion {
  file: string;
  line_start: number;
  line_end: number;
  severity: SuggestionSeverity;
  rationale: string;
  original: string;
  replacement: string;
}

function isSeverity(s: string): s is SuggestionSeverity {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

function parseSuggestion(jsonText: string): ParsedSuggestion | null {
  let obj: unknown;
  try { obj = JSON.parse(jsonText); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const file = typeof o.file === 'string' ? o.file : null;
  const line_start = typeof o.line_start === 'number' ? o.line_start : null;
  const line_end = typeof o.line_end === 'number' ? o.line_end : null;
  const severity = typeof o.severity === 'string' && isSeverity(o.severity) ? o.severity : null;
  const rationale = typeof o.rationale === 'string' ? o.rationale : null;
  const original = typeof o.original === 'string' ? o.original : null;
  const replacement = typeof o.replacement === 'string' ? o.replacement : null;
  if (!file || line_start === null || line_end === null || !severity || rationale == null || original == null || replacement == null) {
    return null;
  }
  return { file, line_start, line_end, severity, rationale, original, replacement };
}

export interface ReviewerCtx {
  logger: Logger;
  reviews: MrReviewsRepo;
}

interface RunningReview {
  reviewId: number;
  pid: number;
  abort: () => void;
}

const RUNNING = new Map<number, RunningReview>();

function maxConcurrent(): number {
  const n = Number(process.env.MR_REVIEW_MAX_CONCURRENT || '3');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function activeReviewCount(): number {
  return RUNNING.size;
}

// Boots the review for an already-created mr_reviews row. Resolves immediately
// after spawn — the subprocess runs to completion in the background, and we
// persist progress as it streams.
export async function startReview(ctx: ReviewerCtx, reviewId: number): Promise<{ pid: number; worktreePath: string }> {
  if (RUNNING.size >= maxConcurrent()) {
    throw new Error(`max concurrent reviews reached (${RUNNING.size}/${maxConcurrent()}). Try again when one finishes.`);
  }

  const review = ctx.reviews.getById(reviewId);
  if (!review) throw new Error(`review ${reviewId} not found`);
  if (review.status !== 'queued') throw new Error(`review ${reviewId} is not queued (status=${review.status})`);

  const projectId = Number(review.mr_external_id.split(':')[0]);
  if (!projectId) throw new Error(`bad mr_external_id ${review.mr_external_id}`);

  const projectPath = review.project_path || projectPathFromMrUrl(review.mr_url);
  if (!projectPath) throw new Error(`could not derive project path from ${review.mr_url}`);

  const wt = new WorktreeManager();
  const wtKey = `mr-${review.mr_external_id.replace(':', '-')}-r${review.id}`;
  const worktreePath = await wt.addWorktree(projectId, projectPath, review.source_branch, wtKey);

  // Make sure target ref is also fetched so `git diff origin/<target>...HEAD`
  // works inside the worktree. Worktree shares the cache's object store.
  // (ensureCache during addWorktree already did a full fetch, so we're set.)

  const logDir = path.resolve(process.env.MR_REVIEW_REPO_DIR || 'data/repos', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `review-${reviewId}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const cli = process.env.CLAUDE_CLI || 'claude';
  const systemPrompt = buildSystemPrompt(review.level);
  const userPrompt = buildUserPrompt({
    sourceBranch: review.source_branch,
    targetBranch: review.target_branch,
    mrTitle: review.mr_title,
    mrUrl: review.mr_url,
  });

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', review.model,
    '--allowedTools', 'Read,Glob,Grep,Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git rev-parse:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit,WebFetch,WebSearch',
    '--append-system-prompt', systemPrompt,
    userPrompt,
  ];

  const child = spawn(cli, args, {
    cwd: worktreePath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ctx.reviews.setRunning(reviewId, { pid: child.pid!, worktreePath, logPath });

  const seenSuggestionFingerprints = new Set<string>();
  let buf = '';

  child.stdout.on('data', (data: Buffer) => {
    const s = data.toString('utf8');
    logStream.write(s);
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: StreamJsonEvent;
      try { evt = JSON.parse(line) as StreamJsonEvent; }
      catch { continue; }
      handleEvent(ctx, reviewId, evt, seenSuggestionFingerprints);
    }
  });

  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stderr += s;
    logStream.write(`[stderr] ${s}`);
  });

  child.on('close', (code) => {
    logStream.end();
    RUNNING.delete(reviewId);
    const fresh = ctx.reviews.getById(reviewId);
    // Already terminal? leave it.
    if (fresh && (fresh.status === 'cancelled' || fresh.status === 'failed' || fresh.status === 'submitted' || fresh.status === 'discarded')) return;
    if (code === 0) {
      // setFinished may have already been called from a `result` event; in
      // that case we'd be a no-op. Check current status before overwriting.
      const cur = ctx.reviews.getById(reviewId);
      if (cur && cur.status === 'running') ctx.reviews.setFinished(reviewId, {});
    } else {
      ctx.reviews.setFinished(reviewId, { error: `claude exited with code ${code}: ${stderr.slice(0, 500)}` });
    }
  });

  child.on('error', (err) => {
    ctx.logger.error({ err, reviewId }, 'claude subprocess errored');
    RUNNING.delete(reviewId);
    ctx.reviews.setFinished(reviewId, { error: String(err) });
  });

  RUNNING.set(reviewId, {
    reviewId,
    pid: child.pid!,
    abort: () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
  });

  return { pid: child.pid!, worktreePath };
}

function handleEvent(ctx: ReviewerCtx, reviewId: number, evt: StreamJsonEvent, seen: Set<string>): void {
  if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
    ctx.reviews.setSessionId(reviewId, evt.session_id);
    return;
  }
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const c of evt.message.content) {
      if ((c as StreamJsonAssistantContentText).type === 'text') {
        const text = (c as StreamJsonAssistantContentText).text;
        ctx.reviews.appendTranscript(reviewId, text + '\n');
        scrapeSuggestions(ctx, reviewId, text, seen);
      } else if ((c as { type: string }).type === 'tool_use') {
        const tu = c as StreamJsonAssistantContentTool;
        ctx.reviews.appendTranscript(reviewId, `\n[tool: ${tu.name}]\n`);
      }
      // ignore 'thinking' — too noisy for the visible transcript
    }
    return;
  }
  if (evt.type === 'result') {
    const finalText = typeof evt.result === 'string' ? evt.result : '';
    if (finalText) {
      // Catch suggestions that lived only in the final result payload (which
      // is also emitted as a regular assistant text event in practice, but
      // belt + suspenders).
      scrapeSuggestions(ctx, reviewId, finalText, seen);
    }
    ctx.reviews.setFinished(reviewId, {
      costUsd: evt.total_cost_usd ?? null,
      durationMs: evt.duration_ms ?? null,
      error: evt.is_error ? (finalText.slice(0, 500) || 'agent reported error') : null,
    });
  }
}

function scrapeSuggestions(ctx: ReviewerCtx, reviewId: number, text: string, seen: Set<string>): void {
  SUGGEST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUGGEST_RE.exec(text)) !== null) {
    const json = m[1];
    const fp = json.length + ':' + json.slice(0, 100);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const parsed = parseSuggestion(json);
    if (!parsed) {
      ctx.logger.warn({ reviewId, snippet: json.slice(0, 200) }, 'unparseable suggest-fix block');
      continue;
    }
    ctx.reviews.insertSuggestion(reviewId, parsed);
  }
}

export function cancelReview(reviewId: number): boolean {
  const r = RUNNING.get(reviewId);
  if (!r) return false;
  r.abort();
  return true;
}
