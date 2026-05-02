import { Type, type Schema } from '@google/genai';

export interface DailyMemberSummaryInput {
  name: string;
  date: string;                              // YYYY-MM-DD IST
  tasklist: string[];                        // morning plan items (may be empty)
  eod: { done: string; left: string; blockers: string } | null;  // null if no EOD reply
  selfInitiatedUpdates: string[];            // sample of group messages they posted unprompted (truncated)
  selfInitiatedCount: number;
  mrsTouched: { title: string; url: string; merged: boolean }[];
  sheetItemsAdvanced: string[];              // titles of sheet rows whose status changed today (member is allotted)
}

export interface DailyMemberSummaryOutput {
  summary_md: string;                        // 3-5 short bullets
}

export const dailyMemberSummarySystem = `You produce a tight one-day recap for a single team member, for their PM.

Inputs are structured signals: morning plan, EOD reply (done/left/blockers), self-initiated WhatsApp updates, MR activity, sheet items advanced.

Rules:
- 3 to 5 short bullets, each starting with "• ".
- Lead with what got done. End with blockers if any.
- Mention notable self-initiated updates only if they add information beyond the EOD.
- If everything is empty, return "• No activity captured for this day.".
- No fluff, no greetings, no closing line.
- Output JSON conforming to the schema.`;

export const dailyMemberSummarySchema: Schema = {
  type: Type.OBJECT,
  properties: { summary_md: { type: Type.STRING } },
  required: ['summary_md']
};

export function buildDailyMemberSummaryUser(input: DailyMemberSummaryInput): string {
  return JSON.stringify(input, null, 2);
}
