import type { Hook, HookContext } from './Hook.js';
import { next, type FollowupState } from '../conversations/TasklistFollowup.js';
import {
  parseYesNoSystem,
  parseYesNoSchema,
  buildParseYesNoUser,
  type ParseYesNoOutput
} from '../llm/prompts/parseYesNo.js';

export class TasklistFollowupHook implements Hook {
  name = 'TasklistFollowupHook';
  description = 'Advance the tasklist follow-up DM conversation on member replies.';

  appliesTo(ctx: HookContext): boolean {
    const m = ctx.message;
    if (m.isFromMe) return false;
    if (m.groupID) return false;                    // DMs only

    if (!ctx.team.getMember(m.sender)) return false;

    const conv = ctx.conversations.getState(m.sender, 'tasklist_followup');
    if (!conv) return false;
    return conv.state === 'asked_started' || conv.state === 'awaiting_tasklist';
  }

  async handle(ctx: HookContext): Promise<void> {
    const m = ctx.message;
    const conv = ctx.conversations.getState(m.sender, 'tasklist_followup')!;
    const state = conv.state as FollowupState;

    let intent: ParseYesNoOutput['intent'] = 'unclear';
    let eta: string | undefined;

    // Only the asked_started state needs intent classification. awaiting_tasklist
    // doesn't care what they typed — we just nudge them to post in the group.
    if (state === 'asked_started') {
      try {
        const result = await ctx.gemini.classify<ParseYesNoOutput>({
          system: parseYesNoSystem,
          user: buildParseYesNoUser(m.text || ''),
          schema: parseYesNoSchema,
        });
        intent = result.data.intent;
        eta = result.data.eta;
      } catch (err) {
        ctx.logger.error({ err, sender: m.sender }, 'parseYesNo failed; treating as unclear');
      }
    }

    const tx = next({ state, intent, eta });

    if (tx.reply && ctx.inboundService) {
      try {
        await ctx.inboundService.sendMessage(m.sender, tx.reply);
      } catch (err) {
        ctx.logger.error({ err, sender: m.sender }, 'failed to send followup reply DM');
      }
    }

    if (tx.nextState === null) {
      ctx.conversations.clear(m.sender, 'tasklist_followup');
    } else {
      const existingPayload = conv.payload_json ? JSON.parse(conv.payload_json) : {};
      const newPayload = { ...existingPayload, ...(tx.payloadPatch || {}) };
      ctx.conversations.setState(m.sender, 'tasklist_followup', tx.nextState, newPayload);
    }
  }
}
