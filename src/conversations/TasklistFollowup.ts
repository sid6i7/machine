// Pure state machine for the morning-tasklist follow-up DM thread.
// Driven by TasklistFollowupHook on inbound DMs and kicked off by
// MorningTasklistReminderJob at 12 IST. Resolved (cleared) by
// ClassifyTasklistHook when the member finally posts their tasklist
// in the meetings group.

export type FollowupState = 'asked_started' | 'awaiting_tasklist' | 'done';

export interface FollowupTransition {
  reply?: string;
  nextState: FollowupState | null;     // null = clear the conversation
  payloadPatch?: Record<string, unknown>;
}

export interface FollowupInput {
  state: FollowupState;
  intent: 'started' | 'not_started' | 'unclear';
  eta?: string;
}

export function next(input: FollowupInput): FollowupTransition {
  if (input.state === 'asked_started') {
    if (input.intent === 'started') {
      return {
        reply: "Great. Please share your tasklist in the meetings group when you have a moment — I'll pick it up automatically.",
        nextState: 'awaiting_tasklist'
      };
    }
    if (input.intent === 'not_started') {
      const etaPart = input.eta ? ` (noted: ${input.eta})` : '';
      return {
        reply: `No worries${etaPart}. Please share your tasklist in the meetings group when you start.`,
        nextState: 'awaiting_tasklist',
        payloadPatch: input.eta ? { eta: input.eta } : undefined
      };
    }
    // unclear
    return {
      reply: "Sorry, I didn't catch that. Have you started work today? (yes / not yet)",
      nextState: 'asked_started'
    };
  }

  if (input.state === 'awaiting_tasklist') {
    return {
      reply: "Please post your tasklist in the meetings group so the rest of the team sees it. I'll pick it up automatically.",
      nextState: 'awaiting_tasklist'
    };
  }

  return { nextState: null };
}

export const KICKOFF_REPLY = 'Hey — have you started work yet today?';
export const ACK_REPLY = 'Got your tasklist for today, thanks!';
