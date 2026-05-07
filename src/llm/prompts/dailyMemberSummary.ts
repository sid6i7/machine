import { Type, type Schema } from '@google/genai';

export interface DailyMemberSummaryInput {
  name: string;
  date: string;                              // YYYY-MM-DD IST
  tasklist: string[];                        // morning plan items (may be empty)
  eod: { done: string; left: string; blockers: string } | null;  // null if no EOD reply
  groupMessages: string[];                   // all messages the member posted in monitored groups today
  groupMessageCount: number;
  dms: string[];                             // 1:1 DMs the member sent to the PM today
  dmCount: number;
  mrsTouched: { title: string; url: string; merged: boolean }[];
  sheetItemsAdvanced: string[];              // titles of sheet rows whose status changed today (member is allotted)
}

export interface DailyMemberSummaryOutput {
  summary_md: string;                        // 3-5 short bullets
}

export const dailyMemberSummarySystem = `You produce a tight one-day recap for a single team member, for their PM.

Inputs are structured signals: morning plan, EOD reply (done/left/blockers), all WhatsApp messages the member posted in team groups today, 1:1 DMs the member sent to the PM today, MR activity, sheet items advanced.

The group messages and DMs are raw and unfiltered — most will be chatter, replies, or noise. Mine them for actual work signal: status updates, things shipped, problems hit, decisions made. Ignore greetings, acknowledgements ("ok", "sure", "done bhaiya"), and pure conversation that conveys no work content. DMs often carry the most candid signal (private blockers, asks, "stuck on X") — weight them accordingly.

Rules:
- 3 to 5 short bullets, each starting with "• ".
- Lead with what got done. End with blockers if any.
- Use group messages to add detail or fill gaps when the EOD is missing or thin.
- The morning tasklist counts as evidence of planned work. If only a tasklist exists with no execution signal (no EOD, no group messages, no MRs), summarize it as planned work — prefix those bullets with "Planned:" so the PM can see intent vs. confirmed delivery.
- Only return "• No activity captured for this day." when the tasklist is empty AND there is no EOD, no group messages, no DMs, and no MR activity.
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
