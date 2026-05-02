import { getDatabase, type Db } from '../Database.js';

export type PeriodKind = 'day' | 'week';

export interface MemberSummary {
  member_jid: string;
  period_kind: PeriodKind;
  period_start: string;
  summary_md: string;
  evidence_json: string;
  generated_at: number;
}

export interface TeamSummary {
  period_kind: PeriodKind;
  period_start: string;
  summary_md: string;
  made_live_md: string;
  evidence_json: string;
  generated_at: number;
}

export class SummariesRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  upsertMember(s: Omit<MemberSummary, 'generated_at'>): void {
    this.db.prepare(`
      INSERT INTO member_summaries (member_jid, period_kind, period_start, summary_md, evidence_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_jid, period_kind, period_start) DO UPDATE SET
        summary_md    = excluded.summary_md,
        evidence_json = excluded.evidence_json,
        generated_at  = excluded.generated_at
    `).run(s.member_jid, s.period_kind, s.period_start, s.summary_md, s.evidence_json, Date.now());
  }

  getMember(memberJid: string, periodKind: PeriodKind, periodStart: string): MemberSummary | undefined {
    return this.db.prepare(
      'SELECT * FROM member_summaries WHERE member_jid = ? AND period_kind = ? AND period_start = ?'
    ).get(memberJid, periodKind, periodStart) as MemberSummary | undefined;
  }

  listMembersForPeriod(periodKind: PeriodKind, periodStart: string): MemberSummary[] {
    return this.db.prepare(
      'SELECT * FROM member_summaries WHERE period_kind = ? AND period_start = ? ORDER BY member_jid'
    ).all(periodKind, periodStart) as MemberSummary[];
  }

  // Returns daily summaries for a member across [startDate, endDate] inclusive.
  // Used by WeeklyTeamSummaryJob to feed the per-member weekly LLM call.
  listMemberDays(memberJid: string, startDate: string, endDate: string): MemberSummary[] {
    return this.db.prepare(
      `SELECT * FROM member_summaries
       WHERE member_jid = ? AND period_kind = 'day' AND period_start BETWEEN ? AND ?
       ORDER BY period_start`
    ).all(memberJid, startDate, endDate) as MemberSummary[];
  }

  upsertTeam(s: Omit<TeamSummary, 'generated_at'>): void {
    this.db.prepare(`
      INSERT INTO team_summaries (period_kind, period_start, summary_md, made_live_md, evidence_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_kind, period_start) DO UPDATE SET
        summary_md    = excluded.summary_md,
        made_live_md  = excluded.made_live_md,
        evidence_json = excluded.evidence_json,
        generated_at  = excluded.generated_at
    `).run(s.period_kind, s.period_start, s.summary_md, s.made_live_md, s.evidence_json, Date.now());
  }

  getTeam(periodKind: PeriodKind, periodStart: string): TeamSummary | undefined {
    return this.db.prepare(
      'SELECT * FROM team_summaries WHERE period_kind = ? AND period_start = ?'
    ).get(periodKind, periodStart) as TeamSummary | undefined;
  }
}
