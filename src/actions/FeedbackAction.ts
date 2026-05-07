import type { Action } from './Action.js';
import type { InboundMessage } from '../services/InboundService.js';
import { MemberFeedbackRepo } from '../db/repos/MemberFeedbackRepo.js';
import { TeamRepo } from '../db/repos/TeamRepo.js';
import { BacklogRepo } from '../db/repos/BacklogRepo.js';
import { istDateString } from '../utils/time.js';

const KEYWORD = process.env.MENTION_KEYWORD || '@siddhant';

// Logs free-form feedback about a team member. Surfaces in /evaluations
// the following Saturday morning so the PM has a recall of the week.
//
// Usage:
//   @siddhant feedback @member <text>            — minimal
//   @siddhant feedback @member <text> #123       — attach to backlog item id 123
//   @siddhant feedback @member <text> https://… — best-effort lookup by URL
export class FeedbackAction implements Action {
  name = 'feedback';
  template = `${KEYWORD} feedback @<member> <text> [#<backlog_id> | <url>]`;
  description = 'Log a daily feedback note about a team member, optionally tied to an MR / sheet item / feature.';

  matches(message: InboundMessage): boolean {
    if (!message.isMentioned) return false;
    const tokens = (message.text || '').split(/\s+/);
    const i = tokens.findIndex(t => t.toLowerCase().includes(KEYWORD.toLowerCase()));
    return i >= 0 && (tokens[i + 1] || '').toLowerCase() === 'feedback';
  }

  async execute(message: InboundMessage): Promise<string> {
    const team = new TeamRepo();
    const repo = new MemberFeedbackRepo();
    const backlog = new BacklogRepo();

    // Pick the first mentioned JID that isn't the bot itself. The bot is
    // identified as whichever member has `managedByUser=false` on the calling
    // side — but at the simplest level, any non-sender mention is a candidate.
    const mentions = (message.mentions || []).filter(j => j && j !== message.sender);
    if (!mentions.length) {
      return `Need to @-mention the team member.\nTemplate: ${this.template}`;
    }

    // If multiple mentions, prefer one that resolves to a configured team member.
    let targetJid: string | undefined;
    for (const jid of mentions) {
      const m = team.getMember(jid);
      if (m && !m.excludeFromEod) { targetJid = jid; break; }
    }
    if (!targetJid) {
      // Fall back to first non-sender mention (might be a @lid alias the bot can't resolve).
      targetJid = mentions[0];
    }

    // Strip the bot keyword, the literal "feedback" word, and all @<digits> mention tokens.
    let text = (message.text || '');
    text = text.replace(new RegExp(KEYWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    text = text.replace(/^\s*feedback\s+/i, ' ');           // first occurrence after keyword
    text = text.replace(/\bfeedback\b/i, '');
    text = text.replace(/@\d+/g, '');                        // @-mention tokens
    // Pull out optional #<id> reference and any URL before trimming.
    let backlogItemId: number | null = null;
    const idMatch = text.match(/#(\d+)\b/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const item = backlog.findById(id);
      if (item) backlogItemId = id;
      text = text.replace(idMatch[0], '');
    }
    if (backlogItemId === null) {
      const urlMatch = text.match(/https?:\/\/\S+/);
      if (urlMatch) {
        const url = urlMatch[0];
        // Best-effort: any backlog row whose stored url matches.
        const found = backlog.findByUrl(url);
        if (found) backlogItemId = found.id;
        // Leave the URL in the text — it's part of the feedback context.
      }
    }
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) {
      return `Feedback text is empty.\nTemplate: ${this.template}`;
    }

    const today = istDateString();
    const row = repo.insert({
      memberJid: targetJid,
      feedbackDate: today,
      text,
      backlogItemId,
      source: 'whatsapp',
    });

    const memberName = team.getMember(targetJid)?.name || targetJid.split('@')[0];
    const refTag = backlogItemId ? ` (→ #${backlogItemId})` : '';
    return `📝 Feedback logged for *${memberName}*${refTag} — ${today}\n_${row.text.slice(0, 140)}${row.text.length > 140 ? '…' : ''}_`;
  }
}
