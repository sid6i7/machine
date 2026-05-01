import type { Job, JobContext } from './Job.js';
import { downloadMediaMessage, type proto, type WAMessage } from '@whiskeysockets/baileys';
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

interface MessageRow {
  id: string;
  remote_jid: string;
  participant_jid: string;
  text: string | null;
  has_image: number;
  raw_json: string | null;
  ts: number;
  push_name: string | null;
}

export class ClassifyWaInboxJob implements Job {
  name = 'ClassifyWaInboxJob';
  schedule = '0 * * * *';
  description = 'Hourly: classify new messages in monitored task-feed groups (org/csm/bugs) into backlog tasks or connects.';

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
      SELECT id, remote_jid, participant_jid, text, has_image, raw_json, ts, push_name
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

    const batchItems: BatchInputItem[] = rows.map(r => ({
      id: r.id,
      group: groupLabelByJid.get(r.remote_jid) || r.remote_jid,
      sender: r.push_name || ctx.team.getMember(r.participant_jid)?.name || r.participant_jid,
      text: r.text || (r.has_image ? '<image>' : ''),
      hasImage: !!r.has_image,
    }));

    let firstPass: ClassifyWaIntentOutput;
    try {
      const r = await ctx.gemini.classify<ClassifyWaIntentOutput>({
        system: classifyWaIntentSystem,
        user: buildClassifyWaIntentUser(batchItems),
        schema: classifyWaIntentSchema,
      });
      firstPass = r.data;
    } catch (err) {
      ctx.logger.error({ err }, 'batched classification failed');
      return;
    }

    const resultMap = new Map<string, ClassifyWaIntentOutput['results'][number]>();
    for (const r of firstPass.results) resultMap.set(r.id, r);

    let backlogged = 0;
    let unclassifiable = 0;

    for (const row of rows) {
      let result = resultMap.get(row.id);
      if (!result) { unclassifiable++; continue; }

      // Vision pass for low-confidence image messages.
      if (row.has_image && result.confidence < 0.7 && row.raw_json) {
        try {
          const protoMsg = JSON.parse(row.raw_json) as WAMessage;
          const buffer = await downloadMediaMessage(protoMsg, 'buffer', {}) as Buffer;
          const visionRes = await ctx.gemini.classifyWithVision<ClassifyWaIntentOutput>({
            system: classifyWaIntentSystem,
            user: buildClassifyWaIntentUser([batchItems.find(b => b.id === row.id)!]),
            schema: classifyWaIntentSchema,
            images: [{ data: buffer, mimeType: 'image/jpeg' }],
          });
          if (visionRes.data.results.length > 0) result = visionRes.data.results[0];
        } catch (err) {
          ctx.logger.error({ err, msgId: row.id }, 'vision pass failed; keeping text-only result');
        }
      }

      if (result.intent === 'task') {
        ctx.backlog.upsert({
          source: 'wa_task',
          externalId: row.id,
          title: (result.summary || row.text || 'task').slice(0, 200),
          description: row.text ?? undefined,
          originJid: row.remote_jid,
          originMsgId: row.id,
          isDevTask: !!result.is_dev_task,
          metadata: { confidence: result.confidence, sender: row.participant_jid, group: groupLabelByJid.get(row.remote_jid) },
        });
        backlogged++;
      } else if (result.intent === 'connect') {
        let topic = result.summary || (row.text || 'meeting').slice(0, 60);
        let proposed_time: string | undefined;
        try {
          const ex = await ctx.gemini.classify<ExtractConnectOutput>({
            system: extractConnectSystem,
            user: buildExtractConnectUser({
              senderName: row.push_name || row.participant_jid,
              text: row.text || '',
            }),
            schema: extractConnectSchema,
          });
          topic = ex.data.topic || topic;
          proposed_time = ex.data.proposed_time;
        } catch (err) {
          ctx.logger.error({ err, msgId: row.id }, 'extractConnect failed; using base topic');
        }

        const params = new URLSearchParams({ action: 'TEMPLATE', text: topic });
        const requesterEmail = ctx.team.getEmailForJid(row.participant_jid);
        if (requesterEmail) params.set('add', requesterEmail);
        const detailsParts: string[] = [];
        if (proposed_time) detailsParts.push(`Proposed: ${proposed_time}`);
        if (row.text) detailsParts.push(`Original message: ${row.text}`);
        if (detailsParts.length) params.set('details', detailsParts.join('\n'));
        const calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit?${params.toString()}`;

        ctx.backlog.upsert({
          source: 'wa_connect',
          externalId: row.id,
          title: topic.slice(0, 200),
          description: row.text ?? undefined,
          url: calendarUrl,
          originJid: row.remote_jid,
          originMsgId: row.id,
          metadata: { proposed_time, requester: row.participant_jid, requesterEmail, confidence: result.confidence },
        });
        backlogged++;
      }

      ctx.db.prepare(
        'UPDATE messages SET classified_at = ?, classified_intent = ? WHERE id = ?'
      ).run(Date.now(), result.intent, row.id);
    }

    ctx.logger.info(
      { job: this.name, processed: rows.length, backlogged, unclassifiable },
      'ClassifyWaInboxJob done'
    );
  }
}
