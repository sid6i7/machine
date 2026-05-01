import { Type, type Schema } from '@google/genai';

export type WaIntent = 'task' | 'connect' | 'task_update' | 'status_check' | 'noise';

export interface WaIntentItem {
  id: string;                       // echoed message id
  intent: WaIntent;
  is_dev_task?: boolean;            // only meaningful when intent=task
  summary?: string;                 // short PM-readable summary; required for task/connect/task_update/status_check
  confidence: number;
}

export interface ClassifyWaIntentOutput {
  results: WaIntentItem[];
}

export const classifyWaIntentSystem = `You classify each message in a batch from a software product team's WhatsApp groups.

For each message, decide intent:
- "task" — someone is asking for NEW work to be done (bug report, feature request, fix-this-by-X). Set is_dev_task=true if a developer needs to do it; false otherwise (CS task, doc update, meeting prep). Provide a short PM-readable summary.
- "task_update" — someone is reporting progress on or status of an existing task: "deployed X to staging", "fixed the bug, please verify", "still working on Y, should be done tomorrow", "got approval for the new template". The hallmark is past-tense or in-progress reporting, NOT asking for new work. Provide a short summary that captures what changed/happened.
- "status_check" — someone is ASKING for the status of work (often the manager/PM): "@X is this done?", "@Y any update on the bug fix?", "did the fix go live?". Distinct from task: not a new ask, just probing existing work. Provide summary including who is being asked.
- "connect" — someone is asking for a meeting/call/sync ("quick call about X", "let's hop on for 10 min"). Must be an explicit ask for a synchronous conversation. Provide summary.
- "noise" — anything else (chatter, jokes, OOO/availability notes, jokes, plain media shares with no ask, simple acknowledgements).

Tie-break rules:
- Past-tense + "I/we did X" → task_update, NOT task.
- "@X please do Y" + present/future ask → task.
- "@X is Y done?" or "any update on Y?" → status_check, NOT task.
- Explicit time + sync ask → connect, NOT task.
- Be conservative on connect (confidence ≥ 0.75). Be conservative on status_check too (≥ 0.7) — don't over-fire on rhetorical questions.

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
          intent:      { type: Type.STRING, enum: ['task', 'connect', 'task_update', 'status_check', 'noise'] },
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
