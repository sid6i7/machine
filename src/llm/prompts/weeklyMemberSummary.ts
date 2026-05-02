import { Type, type Schema } from '@google/genai';

export interface WeeklyMemberSummaryInput {
  name: string;
  weekStart: string;                  // Monday YYYY-MM-DD IST
  dailySummaries: { date: string; summary_md: string }[];
  weekStats: {
    tasklistsSubmitted: number;
    eodSubmitted: number;
    selfInitiatedUpdates: number;
    mrsMerged: number;
    sheetItemsAdvanced: number;
    workingDays: number;
  };
}

export interface WeeklyMemberSummaryOutput {
  summary_md: string;                 // 4-6 bullets covering the week
  themes: string[];                   // 1-3 top themes
  notable_blockers: string[];         // distilled across the week
}

export const weeklyMemberSummarySystem = `You produce a one-week recap of a single team member's work for their PM.

Inputs are the per-day summaries (already terse) plus aggregate stats. Combine them into a slightly longer recap.

Rules:
- summary_md: 4 to 6 bullets, each starting with "• ". Cover progress + reliability of updates + anything notable they shipped.
- themes: 1 to 3 short phrases capturing the dominant areas of work this week.
- notable_blockers: distilled from the daily blockers; dedupe across days.
- If the member had no activity at all, summary_md should say so plainly in one bullet.
- Output JSON conforming to the schema.`;

export const weeklyMemberSummarySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    summary_md:        { type: Type.STRING },
    themes:            { type: Type.ARRAY, items: { type: Type.STRING } },
    notable_blockers:  { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['summary_md', 'themes', 'notable_blockers']
};

export function buildWeeklyMemberSummaryUser(input: WeeklyMemberSummaryInput): string {
  return JSON.stringify(input, null, 2);
}
