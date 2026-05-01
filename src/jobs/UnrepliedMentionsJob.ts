import type { Job, JobContext } from './Job.js';
import { workingHoursBetween } from '../utils/time.js';

interface MessageRow {
  id: string;
  remote_jid: string;
  participant_jid: string;
  text: string | null;
  ts: number;
  push_name: string | null;
}

export class UnrepliedMentionsJob implements Job {
  name = 'UnrepliedMentionsJob';
  schedule = '*/15 * * * 1-5';
  description = 'Every 15min on weekdays: surface mentions of the user that have not been replied to within MENTION_REPLY_SLA_HOURS working hours; resolve any that have since been answered.';

  async run(ctx: JobContext): Promise<void> {
    if (!ctx.team.exists()) {
      ctx.logger.warn({ job: this.name }, 'team.json missing; skipping');
      return;
    }
    const userJid = ctx.team.getUserJid();
    const slaHours = Number(process.env.MENTION_REPLY_SLA_HOURS || '4');
    const now = Date.now();

    // 1) Resolution sweep: any open wa_mention_unreplied where the user has
    //    since replied in the same chat → resolve.
    const open = ctx.backlog.listOpenBySource('wa_mention_unreplied');
    let resolvedCount = 0;
    for (const item of open) {
      if (!item.origin_jid || !item.origin_msg_id) continue;
      const original = ctx.messages.findById(item.origin_msg_id);
      if (!original) continue;
      const replyExists = ctx.db.prepare(`
        SELECT 1 FROM messages
        WHERE remote_jid = ? AND participant_jid = ? AND ts > ?
        LIMIT 1
      `).get(original.remote_jid, userJid, original.ts);
      if (replyExists) {
        ctx.backlog.markResolved('wa_mention_unreplied', item.external_id);
        resolvedCount++;
      }
    }

    // 2) Surface new unreplied: messages in monitored groups where the user is
    //    mentioned, no reply from user since, age in working hours > sla.
    const monitoredJids = ctx.team.getMonitoredGroupJids();
    if (monitoredJids.length === 0) {
      ctx.logger.info({ job: this.name }, 'no monitored groups; skipping surface step');
      ctx.logger.info({ job: this.name, resolved: resolvedCount }, 'UnrepliedMentionsJob done');
      return;
    }

    const placeholders = monitoredJids.map(() => '?').join(',');
    // Mentions stored as JSON array; LIKE match for the userJid string.
    const like = `%"${userJid}"%`;
    const candidates = ctx.db.prepare(`
      SELECT id, remote_jid, participant_jid, text, ts, push_name
      FROM messages
      WHERE remote_jid IN (${placeholders})
        AND is_from_me = 0
        AND mentions_json LIKE ?
      ORDER BY ts DESC
      LIMIT 500
    `).all(...monitoredJids, like) as MessageRow[];

    const existingIds = ctx.backlog.listOpenExternalIds('wa_mention_unreplied');
    let surfaced = 0;

    for (const m of candidates) {
      if (existingIds.has(m.id)) continue;

      // Has the user already replied in this chat after this mention?
      const reply = ctx.db.prepare(`
        SELECT 1 FROM messages
        WHERE remote_jid = ? AND participant_jid = ? AND ts > ?
        LIMIT 1
      `).get(m.remote_jid, userJid, m.ts);
      if (reply) continue;

      const elapsedHours = workingHoursBetween(m.ts * 1000, now);
      if (elapsedHours < slaHours) continue;

      const sender = m.push_name || ctx.team.getMember(m.participant_jid)?.name || m.participant_jid;
      const groupLabel = ctx.team.getGroupLabel(m.remote_jid) || m.remote_jid;
      const preview = (m.text || '').slice(0, 100);

      ctx.backlog.upsert({
        source: 'wa_mention_unreplied',
        externalId: m.id,
        title: `[${groupLabel}] ${sender}: ${preview || '<media>'}`,
        description: m.text ?? undefined,
        originJid: m.remote_jid,
        originMsgId: m.id,
        metadata: { sender_jid: m.participant_jid, elapsed_hours: Math.round(elapsedHours * 10) / 10 },
      });
      surfaced++;
    }

    ctx.logger.info({ job: this.name, resolved: resolvedCount, surfaced }, 'UnrepliedMentionsJob done');
  }
}
