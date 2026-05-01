import { Type, type Schema } from '@google/genai';

export interface MemberInput {
  name: string;
  plan: string[];                         // morning tasklist items
  done: string;                           // EOD answer 0
  remaining: string;                      // EOD answer 1
  blockers: string;                       // EOD answer 2
  comparison: {
    completed: string[];
    partial: string[];
    not_done: string[];
    extra_done: string[];
  } | null;                               // null if no morning tasklist
  responded: boolean;                     // false if no answers at all
}

export interface AggregateEodOutput {
  team_overview: string;                  // 2-3 sentence team-level summary for the meetings group
  top_blockers: string[];                 // distilled list, deduped, PM-actionable
  member_blocks: { name: string; markdown: string }[];   // per-member block for Sid's DM
}

export const aggregateEodSummarySystem = `You produce an end-of-day standup summary for a software team's PM.

Inputs: per-member structured data with their morning plan, what they finished, what's left, blockers, and an LLM-derived comparison of plan-vs-done. Some members may not have responded.

Outputs:
1) team_overview — 2-3 sentences capturing the day's progress at a team level. Suitable for posting in the meetings group. Neutral tone, no fluff.
2) top_blockers — distilled list of blockers needing PM attention. Dedupe across members. Prefix each with the member's name when context is needed.
3) member_blocks — for each member, a tight Markdown block with: planned vs. done count, completed (✓), partial (◐), not done (✗), extras done (+), blockers, response status. Keep each block under ~6 short lines. Use the member's name as the heading.

For non-responders, say "No EOD submitted" in their member_block and surface "did not submit EOD" in top_blockers if they're a known team member.

Always return JSON conforming to the schema.`;

export const aggregateEodSummarySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    team_overview: { type: Type.STRING },
    top_blockers:  { type: Type.ARRAY, items: { type: Type.STRING } },
    member_blocks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name:     { type: Type.STRING },
          markdown: { type: Type.STRING }
        },
        required: ['name', 'markdown']
      }
    }
  },
  required: ['team_overview', 'top_blockers', 'member_blocks']
};

export function buildAggregateEodSummaryUser(members: MemberInput[]): string {
  return JSON.stringify({ members }, null, 2);
}
