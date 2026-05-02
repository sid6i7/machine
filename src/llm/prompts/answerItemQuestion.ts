import { Type, type Schema } from '@google/genai';

export interface AnswerItemQuestionInput {
  item: {
    source: string;
    title: string;
    description?: string;
    url?: string;
    status: string;
    metadata?: Record<string, unknown>;
  };
  linkedMrs: { title: string; author?: string; url?: string; sourceBranch?: string; targetBranch?: string; updatedAt?: string; merged?: boolean }[];
  linkedDiscussions: { kind: string; title: string; sender?: string; ts: number }[];
  parentTasks?: { source: string; title: string; url?: string }[];
  recentMessages?: { sender: string; ts: number; text: string }[];   // chronological samples relevant to this item
  question: string;
}

export interface AnswerItemQuestionOutput {
  answer: string;          // Markdown ok
  confidence: number;      // 0-1 — caller can show a "low-confidence" marker
}

export const answerItemQuestionSystem = `You answer a PM's question about a SPECIFIC backlog item using ONLY the provided context.

The context includes the item itself (title, description, metadata, status), any linked MRs, linked discussion messages (task_updates / status_checks), parent items, and a sample of recent WA messages tied to this item.

Rules:
- Be concise and direct. PM is busy; one tight paragraph or 3-5 bullets, max.
- Quote the source when it adds confidence ("the latest update on Apr 30 says…", "MR !32 from PavaN…").
- If the answer isn't in the context, say "Not enough info in the linked context to answer this." — do NOT speculate or hallucinate.
- Confidence: 1.0 = directly stated; 0.7 = inferred from related signals; 0.3 = guessed; 0 = no info.
- Output JSON conforming to the schema.`;

export const answerItemQuestionSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    answer:     { type: Type.STRING },
    confidence: { type: Type.NUMBER },
  },
  required: ['answer', 'confidence']
};

export function buildAnswerItemQuestionUser(input: AnswerItemQuestionInput): string {
  return JSON.stringify(input, null, 2);
}
