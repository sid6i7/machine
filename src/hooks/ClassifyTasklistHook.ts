import type { Hook, HookContext } from './Hook.js';
import { isWorkingDay, istDateString } from '../utils/time.js';
import {
  classifyTasklistSystem,
  classifyTasklistSchema,
  buildClassifyTasklistUser,
  type ClassifyTasklistOutput
} from '../llm/prompts/classifyTasklist.js';

// Cheap pre-filter cutoff. Anything shorter than this is almost certainly chatter.
const MIN_CHARS = 30;
// Confidence floor below which we don't trust the classifier's "is_tasklist".
const CONFIDENCE_FLOOR = 0.6;

export class ClassifyTasklistHook implements Hook {
  name = 'ClassifyTasklistHook';
  description = 'Classify meetings-group messages as tasklists; persist parsed items.';

  appliesTo(ctx: HookContext): boolean {
    const m = ctx.message;
    if (!m.id || !m.groupID) return false;

    const meetingsJid = ctx.team.getGroupJid('meetings');
    if (!meetingsJid || m.groupID !== meetingsJid) return false;

    const member = ctx.team.getMember(m.sender);
    if (!member || member.excludeFromTasklist) return false;

    if (!isWorkingDay(m.timestamp * 1000)) return false;
    if (ctx.tasklists.hasSubmittedToday(m.sender)) return false;

    const text = (m.text || '').trim();
    if (text.length < MIN_CHARS && !m.hasImage) return false;

    return true;
  }

  async handle(ctx: HookContext): Promise<void> {
    const m = ctx.message;
    const member = ctx.team.getMember(m.sender)!;

    const result = await ctx.gemini.classify<ClassifyTasklistOutput>({
      system: classifyTasklistSystem,
      user: buildClassifyTasklistUser({
        senderName: member.name || m.pushName || m.sender,
        text: m.text || '',
      }),
      schema: classifyTasklistSchema,
    });
    const out = result.data;

    if (!out.is_tasklist || out.confidence < CONFIDENCE_FLOOR) {
      ctx.logger.info(
        { sender: m.sender, is_tasklist: out.is_tasklist, confidence: out.confidence, msgId: m.id },
        'ClassifyTasklistHook: not a tasklist'
      );
      return;
    }

    const today = istDateString(m.timestamp * 1000);
    ctx.tasklists.upsert({
      memberJid: m.sender,
      date: today,
      sourceMsgId: m.id,
      items: out.items,
      rawText: m.text || '',
    });
    ctx.logger.info(
      { sender: m.sender, items: out.items.length, date: today, confidence: out.confidence },
      'ClassifyTasklistHook: tasklist stored'
    );
  }
}
