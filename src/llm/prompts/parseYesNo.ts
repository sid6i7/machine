import { Type, type Schema } from '@google/genai';

export interface ParseYesNoOutput {
  intent: 'started' | 'not_started' | 'unclear';
  eta?: string;     // free-text time hint if the user volunteered one ("around 2pm")
}

export const parseYesNoSystem = `The user was asked: "Hey — have you started work yet today?".

Classify their reply:
- "started" — they have begun work (yes/yeah/already on it/working since 9/etc.)
- "not_started" — they haven't (no/not yet/just woke up/heading there/in 30 min/etc.)
- "unclear" — anything ambiguous, off-topic, or a counter-question

If they mention WHEN they will start (or did start), capture it verbatim in 'eta' as a short string ("around 2pm", "in 30 min", "already an hour ago"). Omit if not present.

Always return JSON conforming to the schema.`;

export const parseYesNoSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: ['started', 'not_started', 'unclear'] },
    eta: { type: Type.STRING }
  },
  required: ['intent']
};

export function buildParseYesNoUser(text: string): string {
  return `Reply:\n${text}`;
}
