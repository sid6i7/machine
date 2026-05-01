import { Type, type Schema } from '@google/genai';

export interface MatchUpdateToTaskOutput {
  matched_id: number | null;        // backlog_items.id, or null if no good match
  confidence: number;               // 0..1
}

export const matchUpdateToTaskSystem = `You are matching a WhatsApp status-update message to one of a list of open backlog items from the same group.

Given:
- An UPDATE message (with sender + text).
- A list of OPEN BACKLOG ITEMS, each with id + title + (optional) description.

Pick the SINGLE best-matching item id. If nothing matches well, return matched_id=null.

Match by topic / subject — same project, same feature, same bug. Don't match on superficial keyword overlap. Be honest about uncertainty in confidence.

Output JSON conforming to the schema.`;

export const matchUpdateToTaskSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    matched_id: { type: Type.INTEGER },     // null encoded as JSON null in our parser
    confidence: { type: Type.NUMBER }
  },
  required: ['confidence']
};

export interface OpenItemForMatching { id: number; title: string; description?: string }

export function buildMatchUpdateToTaskUser(opts: {
  sender: string;
  updateText: string;
  openItems: OpenItemForMatching[];
}): string {
  return JSON.stringify({
    update: { sender: opts.sender, text: opts.updateText },
    open_items: opts.openItems.map(i => ({
      id: i.id,
      title: i.title,
      description: i.description ? i.description.slice(0, 200) : undefined
    }))
  }, null, 2);
}
