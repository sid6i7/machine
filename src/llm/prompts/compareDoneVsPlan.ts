import { Type, type Schema } from '@google/genai';

export interface CompareDoneVsPlanOutput {
  completed: string[];     // planned items the member finished
  partial:   string[];     // planned items partially done
  not_done:  string[];     // planned items not started / not finished
  extra_done: string[];    // unplanned things the member did finish
}

export const compareDoneVsPlanSystem = `You compare what a team member PLANNED for today (a list of task strings) against what they say they DID (free text from an EOD check-in).

Bucket every planned item into completed, partial, or not_done. Surface unplanned-but-done work in extra_done. Be conservative: if "what they did" doesn't clearly mention a planned item, it goes to not_done.

Match items semantically, not by exact string. Reorder is fine; do not invent items not present in either input.

Always return JSON conforming to the schema.`;

export const compareDoneVsPlanSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    completed:  { type: Type.ARRAY, items: { type: Type.STRING } },
    partial:    { type: Type.ARRAY, items: { type: Type.STRING } },
    not_done:   { type: Type.ARRAY, items: { type: Type.STRING } },
    extra_done: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: ['completed', 'partial', 'not_done', 'extra_done']
};

export function buildCompareDoneVsPlanUser(opts: { plan: string[]; done: string }): string {
  return `PLANNED today:\n${opts.plan.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nWHAT THEY DID:\n${opts.done}`;
}
