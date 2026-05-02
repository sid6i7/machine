import { Type, type Schema } from '@google/genai';

export interface WeeklyTeamSummaryInput {
  weekStart: string;                                         // Monday YYYY-MM-DD IST
  weekEnd: string;                                           // Friday YYYY-MM-DD IST
  members: {
    name: string;
    summary_md: string;
    themes: string[];
    notable_blockers: string[];
  }[];
  madeLive: { author: string; title: string; url: string; targetBranch: string }[];
}

export interface WeeklyTeamSummaryOutput {
  team_overview_md: string;                                  // 3-6 bullets at team level
  made_live_md:     string;                                  // grouped by author OR by target_branch
  top_themes:       string[];
  top_blockers:     string[];
}

export const weeklyTeamSummarySystem = `You produce a weekly team-level recap for the PM (not for the team).

Inputs: per-member weekly summaries + a list of MRs that merged to staging/prod this week.

Rules:
- team_overview_md: 3 to 6 bullets capturing team-level progress, reliability, and anything notable. Reference members by first name.
- made_live_md: a grouped Markdown list of merged MRs. Group by author (sub-bulleted under each name). Include the title and a (link) suffix that uses the URL. If empty, write "_Nothing merged this week._".
- top_themes: 2 to 4 short phrases — what did the team collectively focus on?
- top_blockers: distilled across members. Dedupe; keep PM-actionable items.
- Tone: neutral, terse. No fluff, no praise/criticism, no greetings.
- Output JSON conforming to the schema.`;

export const weeklyTeamSummarySchema: Schema = {
  type: Type.OBJECT,
  properties: {
    team_overview_md: { type: Type.STRING },
    made_live_md:     { type: Type.STRING },
    top_themes:       { type: Type.ARRAY, items: { type: Type.STRING } },
    top_blockers:     { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['team_overview_md', 'made_live_md', 'top_themes', 'top_blockers']
};

export function buildWeeklyTeamSummaryUser(input: WeeklyTeamSummaryInput): string {
  return JSON.stringify(input, null, 2);
}
