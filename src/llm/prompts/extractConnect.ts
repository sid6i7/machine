import { Type, type Schema } from '@google/genai';

export interface ExtractConnectOutput {
  topic: string;                    // short summary of what they want to discuss
  proposed_time?: string;           // free text e.g. "tomorrow 4pm IST", "early next week"
  duration_minutes?: number;        // best guess; defaults handled downstream
}

export const extractConnectSystem = `Given a WhatsApp message that asks for a meeting/call with the user, extract structured details to pre-fill a calendar event.

Be terse. If the sender hinted at a time, capture it verbatim in proposed_time. If they suggested a duration, set duration_minutes. Topic should be concise (under 60 chars).

Output JSON conforming to the schema.`;

export const extractConnectSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    topic:            { type: Type.STRING },
    proposed_time:    { type: Type.STRING },
    duration_minutes: { type: Type.INTEGER }
  },
  required: ['topic']
};

export function buildExtractConnectUser(opts: { senderName: string; text: string }): string {
  return `Sender: ${opts.senderName}\n\nMessage:\n${opts.text}`;
}
