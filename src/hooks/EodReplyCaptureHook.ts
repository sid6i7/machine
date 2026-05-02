import type { Hook, HookContext } from './Hook.js';
import { istDateString } from '../utils/time.js';

// One-shot DM capture for the EOD async standup. Replaces the old multi-step
// EodResponseHook + state-machine conversation. The bot does NOT respond.
//
// Capture window: from when the kickoff DM was successfully sent to this
// member, up until the aggregate is posted. We look up the latest 'sent'
// pending_outbound of kind='eod_check_in' for this recipient — that's our
// signal that the kickoff actually went out and the member is in EOD mode.
//
// Last reply wins (overwrites the row) so members can amend before 20:30.

export class EodReplyCaptureHook implements Hook {
  name = 'EodReplyCaptureHook';
  description = 'Capture each team member\'s free-form EOD DM reply into eod_replies (no bot response).';

  appliesTo(ctx: HookContext): boolean {
    const m = ctx.message;
    if (m.isFromMe) return false;
    if (m.groupID) return false;                    // DMs only
    if (!ctx.team.exists()) return false;
    if (!ctx.team.isKnownMember(m.sender)) return false;
    if (!(m.text && m.text.trim().length > 0)) return false;

    const today = istDateString(m.timestamp * 1000);
    const session = ctx.eod.getSession(today);
    if (!session) return false;
    if (session.posted_at) return false;            // aggregate already posted; no more capture

    const lastKickoff = ctx.outbound.findLastSent(m.sender, 'eod_check_in');
    if (!lastKickoff || !lastKickoff.sent_at) return false;
    if (m.timestamp * 1000 < lastKickoff.sent_at) return false;

    return true;
  }

  async handle(ctx: HookContext): Promise<void> {
    const m = ctx.message;
    const today = istDateString(m.timestamp * 1000);
    const session = ctx.eod.getSession(today)!;
    ctx.eod.recordReply(session.id, m.sender, m.text || '');
    ctx.logger.info(
      { member: m.sender, sessionId: session.id, len: (m.text || '').length },
      'EodReplyCaptureHook: stored reply'
    );
  }
}
