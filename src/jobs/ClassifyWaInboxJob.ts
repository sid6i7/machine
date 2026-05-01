import type { Job, JobContext } from './Job.js';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import {
  classifyWaIntentSystem,
  classifyWaIntentSchema,
  buildClassifyWaIntentUser,
  type ClassifyWaIntentOutput,
  type BatchInputItem,
} from '../llm/prompts/classifyWaIntent.js';
import {
  extractConnectSystem,
  extractConnectSchema,
  buildExtractConnectUser,
  type ExtractConnectOutput,
} from '../llm/prompts/extractConnect.js';
import {
  matchUpdateToTaskSystem,
  matchUpdateToTaskSchema,
  buildMatchUpdateToTaskUser,
  type MatchUpdateToTaskOutput,
} from '../llm/prompts/matchUpdateToTask.js';

interface MessageRow {
  id: string;
  remote_jid: string;
  participant_jid: string;
  text: string | null;
  has_image: number;
  raw_json: string | null;
  ts: number;
  push_name: string | null;
  quoted_id: string | null;
}

interface MsgCluster {
  msgIds: string[];
  remoteJid: string;
  participantJid: string;
  senderName: string;
  text: string;
  hasImage: boolean;
  rawJsonOfFirstImage: string | null;
  latestTs: number;
  latestQuotedId?: string;
  group: string;
}

const CLUSTER_GAP_SECONDS = 180;

function clusterMessages(
  rows: MessageRow[],
  ctx: JobContext,
  groupLabelByJid: Map<string, string>
): MsgCluster[] {
  const clusters: MsgCluster[] = [];
  for (const row of rows) {
    const senderName = row.push_name || ctx.team.getMember(row.participant_jid)?.name || row.participant_jid;
    const text = row.text || (row.has_image ? '<image>' : '');

    const last = clusters[clusters.length - 1];
    const sameSender = last && last.participantJid === row.participant_jid && last.remoteJid === row.remote_jid;
    const withinGap = last && (row.ts - last.latestTs) <= CLUSTER_GAP_SECONDS;

    if (last && sameSender && withinGap) {
      last.msgIds.push(row.id);
      last.text = (last.text + '\n' + text).trim();
      last.hasImage = last.hasImage || !!row.has_image;
      if (!last.rawJsonOfFirstImage && row.has_image && row.raw_json) last.rawJsonOfFirstImage = row.raw_json;
      last.latestTs = row.ts;
      if (row.quoted_id) last.latestQuotedId = row.quoted_id;
    } else {
      clusters.push({
        msgIds: [row.id],
        remoteJid: row.remote_jid,
        participantJid: row.participant_jid,
        senderName,
        text,
        hasImage: !!row.has_image,
        rawJsonOfFirstImage: row.has_image ? row.raw_json : null,
        latestTs: row.ts,
        latestQuotedId: row.quoted_id || undefined,
        group: groupLabelByJid.get(row.remote_jid) || row.remote_jid,
      });
    }
  }
  return clusters;
}

export class ClassifyWaInboxJob implements Job {
  name = 'ClassifyWaInboxJob';
  schedule = '0 * * * *';
  description = 'Hourly: classify monitored-group messages into backlog tasks/connects/updates/status-checks. Pre-clusters consecutive same-sender messages within 3 minutes.';

  async run(ctx: JobContext): Promise<void> {
    const candidateLabels = (process.env.WA_CLASSIFY_GROUPS || 'org-level,csm,bugs')
      .split(',').map(s => s.trim()).filter(Boolean);

    const groupLabelByJid = new Map<string, string>();
    for (const lbl of candidateLabels) {
      const j = ctx.team.getGroupJid(lbl);
      if (j) groupLabelByJid.set(j, lbl);
    }
    const watchedJids = Array.from(groupLabelByJid.keys());
    if (watchedJids.length === 0) {
      ctx.logger.warn({ job: this.name, candidateLabels }, 'no watched groups configured in team.json; skipping');
      return;
    }

    const batchSize = Number(process.env.WA_CLASSIFY_BATCH_SIZE || '20');
    const placeholders = watchedJids.map(() => '?').join(',');

    const rows = ctx.db.prepare(`
      SELECT id, remote_jid, participant_jid, text, has_image, raw_json, ts, push_name, quoted_id
      FROM messages
      WHERE classified_at IS NULL
        AND remote_jid IN (${placeholders})
      ORDER BY ts ASC
      LIMIT ?
    `).all(...watchedJids, batchSize) as MessageRow[];

    if (rows.length === 0) {
      ctx.logger.info({ job: this.name }, 'no new messages to classify');
      return;
    }

    const clusters = clusterMessages(rows, ctx, groupLabelByJid);
    ctx.logger.info({ rows: rows.length, clusters: clusters.length }, 'pre-clustered');

    const items: BatchInputItem[] = clusters.map((c, idx) => ({
      id: String(idx),
      group: c.group,
      sender: c.senderName,
      text: c.text || (c.hasImage ? '<image>' : ''),
      hasImage: c.hasImage,
    }));

    let firstPass: ClassifyWaIntentOutput;
    try {
      const r = await ctx.gemini.classify<ClassifyWaIntentOutput>({
        system: classifyWaIntentSystem,
        user: buildClassifyWaIntentUser(items),
        schema: classifyWaIntentSchema,
      });
      firstPass = r.data;
    } catch (err) {
      ctx.logger.error({ err }, 'batched classification failed');
      return;
    }

    const resultByIdx = new Map<string, ClassifyWaIntentOutput['results'][number]>();
    for (const r of firstPass.results) resultByIdx.set(r.id, r);

    let counts = { task: 0, connect: 0, task_update: 0, status_check: 0, noise: 0 };
    let updatesLinkedByQuote = 0;
    let updatesLinkedByLlm = 0;
    let updatesUnlinked = 0;

    for (let idx = 0; idx < clusters.length; idx++) {
      const cluster = clusters[idx];
      let result = resultByIdx.get(String(idx));
      if (!result) continue;

      // Vision pass for low-confidence image-only clusters.
      if (cluster.hasImage && result.confidence < 0.7 && cluster.rawJsonOfFirstImage) {
        try {
          const protoMsg = JSON.parse(cluster.rawJsonOfFirstImage) as WAMessage;
          const buffer = await downloadMediaMessage(protoMsg, 'buffer', {}) as Buffer;
          const visionRes = await ctx.gemini.classifyWithVision<ClassifyWaIntentOutput>({
            system: classifyWaIntentSystem,
            user: buildClassifyWaIntentUser([items[idx]]),
            schema: classifyWaIntentSchema,
            images: [{ data: buffer, mimeType: 'image/jpeg' }],
          });
          if (visionRes.data.results.length > 0) result = visionRes.data.results[0];
        } catch (err) {
          ctx.logger.error({ err, cluster: cluster.msgIds }, 'vision pass failed');
        }
      }

      counts[result.intent] = (counts[result.intent] || 0) + 1;
      const externalId = cluster.msgIds[0];
      const lastMsgId = cluster.msgIds[cluster.msgIds.length - 1];

      if (result.intent === 'task') {
        ctx.backlog.upsert({
          source: 'wa_task',
          externalId,
          title: (result.summary || cluster.text || 'task').slice(0, 200),
          description: cluster.text || undefined,
          originJid: cluster.remoteJid,
          originMsgId: lastMsgId,
          isDevTask: !!result.is_dev_task,
          metadata: { confidence: result.confidence, sender: cluster.participantJid, group: cluster.group, msgIds: cluster.msgIds },
        });
      } else if (result.intent === 'connect') {
        let topic = result.summary || cluster.text.slice(0, 60);
        let proposed_time: string | undefined;
        try {
          const ex = await ctx.gemini.classify<ExtractConnectOutput>({
            system: extractConnectSystem,
            user: buildExtractConnectUser({ senderName: cluster.senderName, text: cluster.text }),
            schema: extractConnectSchema,
          });
          topic = ex.data.topic || topic;
          proposed_time = ex.data.proposed_time;
        } catch (err) {
          ctx.logger.error({ err, cluster: cluster.msgIds }, 'extractConnect failed; using base topic');
        }
        const params = new URLSearchParams({ action: 'TEMPLATE', text: topic });
        const requesterEmail = ctx.team.getEmailForJid(cluster.participantJid);
        if (requesterEmail) params.set('add', requesterEmail);
        const detailsParts: string[] = [];
        if (proposed_time) detailsParts.push(`Proposed: ${proposed_time}`);
        if (cluster.text) detailsParts.push(`Original message: ${cluster.text}`);
        if (detailsParts.length) params.set('details', detailsParts.join('\n'));
        const calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit?${params.toString()}`;

        ctx.backlog.upsert({
          source: 'wa_connect',
          externalId,
          title: topic.slice(0, 200),
          description: cluster.text || undefined,
          url: calendarUrl,
          originJid: cluster.remoteJid,
          originMsgId: lastMsgId,
          metadata: { proposed_time, requester: cluster.participantJid, requesterEmail, confidence: result.confidence, msgIds: cluster.msgIds },
        });
      } else if (result.intent === 'task_update') {
        let linkedId: number | null = null;
        let linkSource: 'quote' | 'llm' | null = null;

        if (cluster.latestQuotedId) {
          const linked = ctx.backlog.findByOriginMsgId(cluster.latestQuotedId);
          if (linked) { linkedId = linked.id; linkSource = 'quote'; updatesLinkedByQuote++; }
        }
        if (linkedId === null) {
          const candidates = [
            ...ctx.backlog.listOpenBySource('wa_task'),
            ...ctx.backlog.listOpenBySource('sheet').slice(0, 20),
          ].slice(0, 30);
          if (candidates.length > 0) {
            try {
              const r = await ctx.gemini.classify<MatchUpdateToTaskOutput>({
                system: matchUpdateToTaskSystem,
                user: buildMatchUpdateToTaskUser({
                  sender: cluster.senderName,
                  updateText: cluster.text,
                  openItems: candidates.map(i => ({ id: i.id, title: i.title, description: i.description ?? undefined })),
                }),
                schema: matchUpdateToTaskSchema,
              });
              if (r.data.matched_id && r.data.confidence >= 0.75) {
                linkedId = Number(r.data.matched_id);
                linkSource = 'llm';
                updatesLinkedByLlm++;
              }
            } catch (err) {
              ctx.logger.error({ err, cluster: cluster.msgIds }, 'matchUpdateToTask failed');
            }
          }
        }
        if (linkedId === null) updatesUnlinked++;

        ctx.backlog.upsert({
          source: 'wa_task_update',
          externalId,
          title: (result.summary || cluster.text || 'update').slice(0, 200),
          description: cluster.text || undefined,
          originJid: cluster.remoteJid,
          originMsgId: lastMsgId,
          metadata: { linked_backlog_id: linkedId, link_source: linkSource, sender: cluster.participantJid, confidence: result.confidence, msgIds: cluster.msgIds },
        });
      } else if (result.intent === 'status_check') {
        ctx.backlog.upsert({
          source: 'wa_status_check',
          externalId,
          title: (result.summary || cluster.text || 'status check').slice(0, 200),
          description: cluster.text || undefined,
          originJid: cluster.remoteJid,
          originMsgId: lastMsgId,
          metadata: { sender: cluster.participantJid, confidence: result.confidence, msgIds: cluster.msgIds },
        });
      }

      // Mark all source messages classified.
      const updateStmt = ctx.db.prepare('UPDATE messages SET classified_at = ?, classified_intent = ? WHERE id = ?');
      const now = Date.now();
      for (const mid of cluster.msgIds) updateStmt.run(now, result.intent, mid);
    }

    ctx.logger.info(
      { job: this.name, rows: rows.length, clusters: clusters.length, counts, updatesLinkedByQuote, updatesLinkedByLlm, updatesUnlinked },
      'ClassifyWaInboxJob done'
    );
  }
}
