import type { Hook, HookContext } from './Hook.js';
import type { MessageRow } from '../db/repos/MessagesRepo.js';

// Persists every message we care about (monitored groups + DMs from known
// members + anything from the user themselves) into SQLite. Powers every
// downstream feature: tasklist scans, hourly classification, unreplied-mention
// tracking, EOD comparison, etc.

export class PersistMessageHook implements Hook {
  name = 'PersistMessageHook';
  description = 'Insert every relevant inbound/outbound message into the messages table.';

  appliesTo(ctx: HookContext): boolean {
    const msg = ctx.message;
    const monitoredGroups = ctx.team.getMonitoredGroupJids();
    const userJid = ctx.team.exists() ? ctx.team.getUserJid() : null;

    // Monitored group: always persist
    if (msg.groupID && monitoredGroups.includes(msg.groupID)) return true;
    // DM from a known team member
    if (!msg.groupID && ctx.team.isKnownMember(msg.sender)) return true;
    // User's own messages — needed for tasklist self-submission and reply
    // detection on mentions.
    if (msg.isFromMe && userJid && msg.sender === userJid) return true;
    return false;
  }

  async handle(ctx: HookContext): Promise<void> {
    const m = ctx.message;
    const remoteJid = m.groupID || m.sender;
    if (!m.id || !remoteJid) return;

    const row: MessageRow = {
      id: m.id,
      remote_jid: remoteJid,
      participant_jid: m.sender,
      is_group: m.groupID ? 1 : 0,
      is_from_me: m.isFromMe ? 1 : 0,
      text: m.text || null,
      has_image: m.hasImage ? 1 : 0,
      has_media: m.hasMedia ? 1 : 0,
      media_path: null,                         // populated lazily by P3 jobs
      mentions_json: m.mentions && m.mentions.length ? JSON.stringify(m.mentions) : null,
      quoted_id: m.quotedId || null,
      ts: Math.floor(m.timestamp),              // already unix seconds in our context
      raw_json: m.raw ? JSON.stringify(m.raw) : null,
      classified_at: null,
    };

    ctx.messages.insert(row);
  }
}
