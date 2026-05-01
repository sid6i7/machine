// Pure state machine for the EOD async standup DM thread.
// Driven by EodResponseHook on inbound DMs and kicked off by EodKickoffJob.

export type EodState = 'q1_done' | 'q2_left' | 'q3_blockers' | 'complete';

export interface EodTransition {
  reply: string;
  nextState: EodState | null;          // null = clear conversation
  answer?: { questionIdx: number; text: string };
}

export interface EodInput {
  state: EodState;
  userText: string;
}

const QUESTIONS = [
  'EOD check-in 🌙 — what did you complete today?',
  'What is left / not done?',
  'Any blockers I should know about?'
];

export const KICKOFF_QUESTION = QUESTIONS[0];

export function next(input: EodInput): EodTransition {
  if (input.state === 'q1_done') {
    return {
      reply: QUESTIONS[1],
      nextState: 'q2_left',
      answer: { questionIdx: 0, text: input.userText }
    };
  }
  if (input.state === 'q2_left') {
    return {
      reply: QUESTIONS[2],
      nextState: 'q3_blockers',
      answer: { questionIdx: 1, text: input.userText }
    };
  }
  if (input.state === 'q3_blockers') {
    return {
      reply: "Thanks — logged. Have a good evening!",
      nextState: null,
      answer: { questionIdx: 2, text: input.userText }
    };
  }
  // 'complete' or unknown
  return { reply: '', nextState: null };
}
