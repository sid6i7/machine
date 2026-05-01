import type { Hook, HookContext } from './Hook.js';
import { next, type EodState } from '../conversations/EodStandup.js';
import { istDateString } from '../utils/time.js';

export class EodResponseHook implements Hook {
  name = 'EodResponseHook';
  description = 'Advance the EOD standup DM conversation on member replies.';

  appliesTo(ctx: HookContext): boolean {
    const m = ctx.message;
    if (m.isFromMe) return false;
    if (m.groupID) return false;

    if (!ctx.team.getMember(m.sender)) return false;

    const conv = ctx.conversations.getState(m.sender, 'eod_standup');
    if (!conv) return false;
    return conv.state !== 'complete';
  }

  async handle(ctx: HookContext): Promise<void> {
    const m = ctx.message;
    const conv = ctx.conversations.getState(m.sender, 'eod_standup')!;
    const state = conv.state as EodState;

    const session = ctx.eod.getSession(istDateString(m.timestamp * 1000));
    if (!session) {
      ctx.logger.warn({ member: m.sender }, 'EodResponseHook: no EOD session for today');
      return;
    }

    const tx = next({ state, userText: m.text || '' });

    if (tx.answer) {
      ctx.eod.recordAnswer(session.id, m.sender, tx.answer.questionIdx, tx.answer.text);
    }

    if (tx.reply && ctx.inboundService) {
      try {
        await ctx.inboundService.sendMessage(m.sender, tx.reply);
      } catch (err) {
        ctx.logger.error({ err, sender: m.sender }, 'EodResponseHook: failed to send DM reply');
      }
    }

    if (tx.nextState === null) {
      ctx.conversations.clear(m.sender, 'eod_standup');
    } else {
      ctx.conversations.setState(m.sender, 'eod_standup', tx.nextState);
    }
  }
}
