import { Type, type Schema } from '@google/genai';

// Splits a member's free-form EOD DM reply into the three structured buckets
// (done / left / blockers). The prompt asks for *very lossless* extraction:
// preserve the member's wording verbatim; only re-bucket. This keeps the later
// compareDoneVsPlan call's job easy and gives us readable text in the panel
// even if the LLM mis-buckets edge cases.

export interface ParseEodReplyOutput {
  done:     string;
  left:     string;
  blockers: string;
}

export const parseEodReplySystem = `You parse a software team member's free-form end-of-day check-in reply into three buckets:
- done: what they completed today
- left: what is still pending / not done / will continue tomorrow
- blockers: anything blocking them, dependencies, things they need help with

Rules:
- Preserve the member's own wording verbatim wherever possible. You're re-bucketing, not summarizing.
- If the member's reply doesn't address a bucket at all, return an empty string for that bucket.
- If everything is mashed into one bullet, do your best to split — but never invent items not in the source text.
- Output JSON only, conforming to the schema.`;

export const parseEodReplySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    done:     { type: Type.STRING },
    left:     { type: Type.STRING },
    blockers: { type: Type.STRING }
  },
  required: ['done', 'left', 'blockers']
};

export function buildParseEodReplyUser(opts: { senderName: string; reply: string }): string {
  return `Member: ${opts.senderName}\n\nReply:\n${opts.reply}`;
}
