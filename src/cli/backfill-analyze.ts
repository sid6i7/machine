import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GeminiClient } from '../llm/GeminiClient.js';
import { logger } from '../utils/logger.js';
import { migrate } from '../db/migrate.js';
import { BacklogRepo } from '../db/repos/BacklogRepo.js';
import {
  classifyTasklistSystem,
  classifyTasklistSchema,
  buildClassifyTasklistUser,
  type ClassifyTasklistOutput,
} from '../llm/prompts/classifyTasklist.js';
import {
  classifyWaIntentSystem,
  classifyWaIntentSchema,
  buildClassifyWaIntentUser,
  type ClassifyWaIntentOutput,
  type BatchInputItem,
} from '../llm/prompts/classifyWaIntent.js';

interface ParsedMessage {
  ts: number;        // ms epoch
  istHour: number;   // 0-23 in IST
  sender: string;
  text: string;
  hasMedia: boolean;
  mediaKind?: string;
}

interface ChatExample {
  sender: string;
  text: string;
  classifier: unknown;
  ts: string;
}

interface ChatAnalysis {
  chat: string;
  label: string;
  totalMessages: number;
  inWindow: number;
  classified: Record<string, number>;
  examples: Record<string, ChatExample[]>;
  topSenders: Array<{ sender: string; count: number }>;
  cost: { promptTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number; calls: number };
}

const BACKFILL_DIR = 'data/backfill';
const REPORT_PATH = path.join(BACKFILL_DIR, 'report.md');
const RAW_PATH = path.join(BACKFILL_DIR, 'raw.json');

const FILENAME_TO_LABEL: Record<string, string> = {
  'WhatsApp Chat - Meetings.zip':  'meetings',
  'WhatsApp Chat - Org-level.zip': 'org-level',
  'WhatsApp Chat - CSM.zip':       'csm',
  'WhatsApp Chat - Bugs.zip':      'bugs',
  'WhatsApp Chat - WebDev.zip':    'webdev',
};

function istHourFromUtcMs(ms: number): number {
  // IST is UTC+5:30. Compute the IST hour-of-day (0..23).
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours();
}

function istDateString(ms: number): string {
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 16).replace('T', ' ') + ' IST';
}

function parseChatTxt(content: string): ParsedMessage[] {
  const lineStart =
    /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s(\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM|am|pm)\]\s(.+?):\s?(.*)$/;

  const messages: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(lineStart);
    if (m) {
      if (current) messages.push(current);
      const [, dd, mm, yy, h, min, sec, ap, sender, text] = m;
      let year = parseInt(yy);
      if (year < 100) year += 2000;
      const month = parseInt(mm) - 1;
      const day = parseInt(dd);
      let hour = parseInt(h);
      const minute = parseInt(min);
      const second = parseInt(sec);
      const isPm = ap.toLowerCase() === 'pm';
      if (isPm && hour !== 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
      // Convert IST wall clock → UTC ms
      const utcMs = Date.UTC(year, month, day, hour - 5, minute - 30, second);

      const cleanedSender = sender
        .replace(/[‪-‮‎‏]/g, '')
        .replace(/^~\s+/, '')
        .trim();

      let hasMedia = false;
      let mediaKind: string | undefined;
      const t = text;
      if (/<attached:[^>]+>/.test(t)) { hasMedia = true; mediaKind = 'attached'; }
      else if (/^‎?(image|sticker|video|audio|document|GIF|Contact card|Location)\s+omitted$/i.test(t.trim())) {
        hasMedia = true;
        mediaKind = t.trim().replace(/^‎?/, '').split(/\s+/)[0].toLowerCase();
      }

      current = {
        ts: utcMs,
        istHour: istHourFromUtcMs(utcMs),
        sender: cleanedSender,
        text: hasMedia ? '' : t,
        hasMedia,
        mediaKind,
      };
    } else if (current) {
      current.text += '\n' + line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function isSystemMessage(msg: ParsedMessage): boolean {
  if (!msg.text && !msg.hasMedia) return true;
  const t = msg.text.trim();
  if (!t && msg.hasMedia) return false;
  return (
    /Messages and calls are end-to-end encrypted/.test(t) ||
    /created this group/.test(t) ||
    /joined using this group's invite link/.test(t) ||
    /Disappearing messages were/.test(t) ||
    /You added|You removed|added|removed/.test(t) && /\+\d|‪/.test(t) === false && t.length < 100 && /^You |^.+ added | removed /.test(t)
  );
}

function topSenders(msgs: ParsedMessage[], n = 10) {
  const counts = new Map<string, number>();
  for (const m of msgs) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([sender, count]) => ({ sender, count }));
}

function extractChatTxt(zipPath: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`unzip -o -j "${zipPath}" "_chat.txt" -d "${destDir}"`, { stdio: 'pipe' });
  return path.join(destDir, '_chat.txt');
}

async function analyzeMeetings(
  msgs: ParsedMessage[],
  gemini: GeminiClient,
  cost: ChatAnalysis['cost']
): Promise<{ classified: Record<string, number>; examples: Record<string, ChatExample[]> }> {
  // Window: extend slightly past noon to capture late tasklists.
  const candidates = msgs.filter(m => m.istHour >= 8 && m.istHour <= 16 && m.text && m.text.length >= 30);
  let tasklistCount = 0;
  let notTasklistCount = 0;
  const tasklistEx: ChatExample[] = [];
  const notTasklistEx: ChatExample[] = [];

  for (const msg of candidates) {
    try {
      const r = await gemini.classify<ClassifyTasklistOutput>({
        system: classifyTasklistSystem,
        user: buildClassifyTasklistUser({ senderName: msg.sender, text: msg.text }),
        schema: classifyTasklistSchema,
      });
      cost.calls++;
      cost.promptTokens += r.usage.promptTokens;
      cost.outputTokens += r.usage.outputTokens;
      cost.cachedTokens += r.usage.cachedTokens;
      cost.totalTokens += r.usage.totalTokens;

      const ex: ChatExample = {
        sender: msg.sender,
        text: msg.text.slice(0, 300),
        classifier: r.data,
        ts: istDateString(msg.ts),
      };
      if (r.data.is_tasklist && r.data.confidence >= 0.6) {
        tasklistCount++;
        if (tasklistEx.length < 15) tasklistEx.push(ex);
      } else {
        notTasklistCount++;
        if (notTasklistEx.length < 15) notTasklistEx.push(ex);
      }
    } catch (err) {
      logger.error({ err, sender: msg.sender }, 'tasklist classify failed');
    }
  }

  return {
    classified: { tasklist: tasklistCount, not_tasklist: notTasklistCount, candidates: candidates.length },
    examples: { tasklist: tasklistEx, not_tasklist: notTasklistEx },
  };
}

async function analyzeIntent(
  msgs: ParsedMessage[],
  label: string,
  gemini: GeminiClient,
  cost: ChatAnalysis['cost'],
  persist?: BacklogRepo
): Promise<{ classified: Record<string, number>; examples: Record<string, ChatExample[]> }> {
  const buckets: Record<string, ChatExample[]> = { task: [], connect: [], task_update: [], status_check: [], noise: [] };
  const counts: Record<string, number> = { task: 0, connect: 0, task_update: 0, status_check: 0, noise: 0, dev_task: 0, total: msgs.length };

  // Pre-cluster: same sender + ≤180s gap (mirrors live ClassifyWaInboxJob)
  interface Cluster {
    msgIdxs: number[];     // indices into `msgs`
    sender: string;
    text: string;
    hasImage: boolean;
    latestTsMs: number;
  }
  const clusters: Cluster[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const last = clusters[clusters.length - 1];
    const text = m.text || (m.hasMedia ? `<${m.mediaKind || 'media'}>` : '');
    if (last && last.sender === m.sender && (m.ts - last.latestTsMs) <= 180_000) {
      last.msgIdxs.push(i);
      last.text = (last.text + '\n' + text).trim();
      last.hasImage = last.hasImage || m.mediaKind === 'image';
      last.latestTsMs = m.ts;
    } else {
      clusters.push({ msgIdxs: [i], sender: m.sender, text, hasImage: m.mediaKind === 'image', latestTsMs: m.ts });
    }
  }

  const batchSize = 20;
  for (let i = 0; i < clusters.length; i += batchSize) {
    const batch = clusters.slice(i, i + batchSize);
    const items: BatchInputItem[] = batch.map((c, idx) => ({
      id: String(i + idx),
      group: label,
      sender: c.sender,
      text: c.text || (c.hasImage ? '<image>' : ''),
      hasImage: c.hasImage,
    }));
    try {
      const r = await gemini.classify<ClassifyWaIntentOutput>({
        system: classifyWaIntentSystem,
        user: buildClassifyWaIntentUser(items),
        schema: classifyWaIntentSchema,
      });
      cost.calls++;
      cost.promptTokens += r.usage.promptTokens;
      cost.outputTokens += r.usage.outputTokens;
      cost.cachedTokens += r.usage.cachedTokens;
      cost.totalTokens += r.usage.totalTokens;

      for (const res of r.data.results) {
        const cIdx = parseInt(res.id);
        const cluster = clusters[cIdx];
        if (!cluster) continue;
        const firstMsg = msgs[cluster.msgIdxs[0]];
        const lastMsg = msgs[cluster.msgIdxs[cluster.msgIdxs.length - 1]];
        const ex: ChatExample = {
          sender: cluster.sender,
          text: (cluster.text || '<media>').slice(0, 300),
          classifier: res,
          ts: istDateString(lastMsg.ts),
        };
        const intent = res.intent in counts ? res.intent : 'noise';
        counts[intent] = (counts[intent] || 0) + 1;
        if (intent === 'task' && res.is_dev_task) counts.dev_task++;
        const limit = intent === 'noise' ? 15 : 20;
        if ((buckets[intent] || []).length < limit) {
          if (!buckets[intent]) buckets[intent] = [];
          buckets[intent].push(ex);
        }

        if (persist && intent !== 'noise') {
          const externalId = `bf:${label}:${cluster.msgIdxs[0]}`;
          const originJid = `backfill:${label}`;
          const sourceMap: Record<string, 'wa_task' | 'wa_connect' | 'wa_task_update' | 'wa_status_check'> = {
            task: 'wa_task',
            connect: 'wa_connect',
            task_update: 'wa_task_update',
            status_check: 'wa_status_check',
          };
          persist.upsert({
            source: sourceMap[intent],
            externalId,
            title: (res.summary || cluster.text || intent).slice(0, 200),
            description: cluster.text || undefined,
            originJid,
            originMsgId: externalId,
            isDevTask: intent === 'task' ? !!res.is_dev_task : undefined,
            metadata: {
              backfill: true,
              chat: label,
              sender: cluster.sender,
              firstMsgTs: firstMsg.ts,
              lastMsgTs: lastMsg.ts,
              confidence: res.confidence,
            },
          });
        }
      }
    } catch (err) {
      logger.error({ err, batchStart: i }, 'batch classify failed');
    }
  }

  return { classified: counts, examples: buckets };
}

function renderReport(results: ChatAnalysis[], days: number, since: number): string {
  const totalCost = results.reduce((acc, r) => ({
    promptTokens: acc.promptTokens + r.cost.promptTokens,
    outputTokens: acc.outputTokens + r.cost.outputTokens,
    cachedTokens: acc.cachedTokens + r.cost.cachedTokens,
    totalTokens: acc.totalTokens + r.cost.totalTokens,
    calls: acc.calls + r.cost.calls,
  }), { promptTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 });

  let out = `# Backfill analysis (last ${days} days)\n\n`;
  out += `**Window:** ${istDateString(since)} → ${istDateString(Date.now())}\n\n`;
  out += `## Per-chat summary\n\n`;
  out += `| Chat | Total | In window | Classified |\n|---|---:|---:|---|\n`;
  for (const r of results) {
    const cls = Object.entries(r.classified).map(([k, v]) => `${k}=${v}`).join(', ');
    out += `| ${r.label} | ${r.totalMessages} | ${r.inWindow} | ${cls} |\n`;
  }
  out += `\n**Total LLM cost:** ${totalCost.calls} calls, ${totalCost.promptTokens} prompt + ${totalCost.outputTokens} output tokens (${totalCost.cachedTokens} cached)\n\n`;

  for (const r of results) {
    out += `---\n\n## ${r.label} (${r.chat})\n\n`;
    out += `- ${r.totalMessages} total messages, ${r.inWindow} in window\n`;
    out += `- Classifier counts: ${JSON.stringify(r.classified)}\n`;
    out += `- LLM cost: ${r.cost.calls} calls, ${r.cost.totalTokens} total tokens\n\n`;
    out += `**Top senders in window:**\n`;
    for (const s of r.topSenders) out += `- ${s.sender}: ${s.count}\n`;
    out += `\n`;

    for (const [bucket, examples] of Object.entries(r.examples)) {
      out += `### ${bucket} (${examples.length} examples)\n\n`;
      if (examples.length === 0) { out += `_(none)_\n\n`; continue; }
      for (const ex of examples) {
        const cls = JSON.stringify(ex.classifier);
        const text = ex.text.replace(/\n+/g, ' / ');
        out += `- \`${ex.ts}\` **${ex.sender}**: ${text}\n  - \`${cls}\`\n`;
      }
      out += `\n`;
    }
  }
  return out;
}

async function main() {
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1]) : 2;
  const dryRun = process.argv.includes('--dry-run');
  const persist = process.argv.includes('--persist');

  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(BACKFILL_DIR)) {
    console.error(`No directory at ${BACKFILL_DIR}`);
    process.exit(2);
  }

  const zips = fs.readdirSync(BACKFILL_DIR).filter(f => f.endsWith('.zip'));
  if (zips.length === 0) {
    console.error(`No zips in ${BACKFILL_DIR}`);
    process.exit(2);
  }

  const tmpDir = path.join(BACKFILL_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Force dry-run env so GeminiClient skips real API if requested
  if (dryRun) process.env.LLM_DRY_RUN = 'true';
  const gemini = new GeminiClient();

  // Persist: ensure migrations are applied so the backlog table exists.
  let backlogRepo: BacklogRepo | undefined;
  if (persist) {
    migrate();
    backlogRepo = new BacklogRepo();
    logger.info({}, 'persist mode: backfilled items will land in backlog_items with origin_jid="backfill:<label>"');
  }

  const results: ChatAnalysis[] = [];

  for (const zip of zips) {
    const label = FILENAME_TO_LABEL[zip];
    if (!label) {
      logger.warn({ zip }, 'unknown chat filename; skipping');
      continue;
    }
    logger.info({ zip, label }, 'processing chat');

    const chatTxt = extractChatTxt(path.join(BACKFILL_DIR, zip), path.join(tmpDir, label));
    const content = fs.readFileSync(chatTxt, 'utf-8');
    const all = parseChatTxt(content).filter(m => !isSystemMessage(m));
    const inWindow = all.filter(m => m.ts >= since && m.ts <= now);

    logger.info({ label, total: all.length, inWindow: inWindow.length }, 'parsed');

    const cost = { promptTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    let analysis;
    if (label === 'meetings') {
      analysis = await analyzeMeetings(inWindow, gemini, cost);
    } else {
      analysis = await analyzeIntent(inWindow, label, gemini, cost, backlogRepo);
    }

    results.push({
      chat: zip,
      label,
      totalMessages: all.length,
      inWindow: inWindow.length,
      classified: analysis.classified,
      examples: analysis.examples,
      topSenders: topSenders(inWindow),
      cost,
    });
  }

  fs.writeFileSync(RAW_PATH, JSON.stringify(results, null, 2));
  fs.writeFileSync(REPORT_PATH, renderReport(results, days, since));
  logger.info({ report: REPORT_PATH, raw: RAW_PATH }, 'analysis complete');
  process.exit(0);
}

main().catch((err) => { logger.error({ err }, 'backfill analysis failed'); process.exit(1); });
