import { Type, type Schema } from '@google/genai';

export type WaIntent = 'task' | 'connect' | 'noise';

export interface WaIntentItem {
  id: string;                       // echoed message id
  intent: WaIntent;
  is_dev_task?: boolean;            // only meaningful when intent=task
  summary?: string;                 // short PM-readable summary; required for task/connect
  confidence: number;
}

export interface ClassifyWaIntentOutput {
  results: WaIntentItem[];
}

export const classifyWaIntentSystem = `You classify each message in a batch from a software product team's WhatsApp groups.

For each message, decide intent:
- "task" — someone is asking for work to be done (bug report, feature request, fix-this-by-X). Set is_dev_task=true if a developer needs to do it (engineering work); false otherwise (e.g., a CS task, a meeting prep, a doc update). Provide a short PM-readable summary.
- "connect" — someone is asking for a meeting/call/sync with the user (e.g., "@sid quick call about X", "let's hop on for 10 min"). Must be an explicit ask for a synchronous conversation. Provide summary.
- "noise" — anything else (chatter, status, replies, jokes, links shared without ask).

Be conservative on connect (confidence ≥ 0.75). Match by intent, not just keywords.

Always echo the input message id in each result. Output JSON conforming to the schema.`;

export const classifyWaIntentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id:          { type: Type.STRING },
          intent:      { type: Type.STRING, enum: ['task', 'connect', 'noise'] },
          is_dev_task: { type: Type.BOOLEAN },
          summary:     { type: Type.STRING },
          confidence:  { type: Type.NUMBER }
        },
        required: ['id', 'intent', 'confidence']
      }
    }
  },
  required: ['results']
};

export interface BatchInputItem {
  id: string;
  group: string;                    // 'org-level' | 'csm' | 'bugs' | etc.
  sender: string;                   // display name or JID
  text: string;
  hasImage?: boolean;
}

export function buildClassifyWaIntentUser(items: BatchInputItem[]): string {
  return JSON.stringify({ messages: items }, null, 2);
}
