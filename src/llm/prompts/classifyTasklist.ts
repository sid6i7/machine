import { Type, type Schema } from '@google/genai';

export interface ClassifyTasklistOutput {
  is_tasklist: boolean;
  items: { text: string; est_hours?: number }[];
  confidence: number;
}

export const classifyTasklistSystem = `You classify a single message from a software team's morning standup channel.

Decide whether the message is the sender's PLAN-FOR-TODAY (a "tasklist"). A tasklist message lists what the sender intends to work on today — usually 1-6 items.

NOT a tasklist:
- Casual chat ("good morning", "lol same", emoji-only)
- Status updates from yesterday or about other people
- Questions, jokes, links shared without context
- "Out today" / "OOO" notes
- Replies / acknowledgements

If is_tasklist=true, extract each task item as a short string (preserve the sender's wording but trim filler). If the sender provided estimates like "2h", "30m", set est_hours. Set confidence in [0,1] reflecting your certainty.

Always return JSON conforming to the schema.`;

export const classifyTasklistSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    is_tasklist: { type: Type.BOOLEAN },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          est_hours: { type: Type.NUMBER }
        },
        required: ['text']
      }
    },
    confidence: { type: Type.NUMBER }
  },
  required: ['is_tasklist', 'items', 'confidence']
};

export function buildClassifyTasklistUser(opts: { senderName: string; text: string }): string {
  return `Sender: ${opts.senderName}\n\nMessage:\n${opts.text}`;
}
