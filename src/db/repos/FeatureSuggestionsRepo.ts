import { getDatabase, type Db } from '../Database.js';
import type { BacklogRepo } from './BacklogRepo.js';
import type { BacklogEventRepo } from './BacklogEventRepo.js';

export type SuggestionKind = 'new_feature' | 'member_add';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'superseded';
export type MemberReason = 'hard_link' | 'token_overlap' | 'llm';

export interface FeatureSuggestion {
  id: number;
  kind: SuggestionKind;
  feature_id: number | null;
  proposed_title: string | null;
  proposed_desc: string | null;
  rationale: string | null;
  confidence: number;
  signals_json: string | null;
  member_set_hash: string;
  status: SuggestionStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  accepted_feature_id: number | null;
}

export interface SuggestionMember {
  item_id: number;
  reason: MemberReason | null;
  source: string;
  title: string;
  url: string | null;
  status: string;
}

export interface SuggestionWithMembers extends FeatureSuggestion {
  members: SuggestionMember[];
  feature_title: string | null;
}

export interface InsertNewFeatureInput {
  memberIds: number[];
  hash: string;
  title: string;
  description: string;
  rationale: string;
  confidence: number;
  signals: unknown;
  memberReasons: Record<number, MemberReason>;
}

export interface InsertMemberAddInput {
  featureId: number;
  itemId: number;
  hash: string;
  rationale: string;
  confidence: number;
  signals: unknown;
}

export interface AcceptOverrides {
  title?: string;
  description?: string;
  removeIds?: number[];
}

export class FeatureSuggestionsRepo {
  private db: Db;
  constructor(db?: Db) { this.db = db ?? getDatabase(); }

  // Returns the inserted id, or null on UNIQUE conflict (same hash+kind already
  // proposed). Wraps insert + member rows in one transaction.
  insertNewFeature(input: InsertNewFeatureInput): number | null {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT OR IGNORE INTO feature_suggestions
          (kind, proposed_title, proposed_desc, rationale, confidence, signals_json,
           member_set_hash, status, created_at)
        VALUES ('new_feature', ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        input.title, input.description, input.rationale, input.confidence,
        JSON.stringify(input.signals), input.hash, Date.now()
      );
      if (info.changes === 0) return null;
      const id = Number(info.lastInsertRowid);
      const stmt = this.db.prepare(
        'INSERT INTO feature_suggestion_members (suggestion_id, item_id, reason) VALUES (?, ?, ?)'
      );
      for (const memberId of input.memberIds) {
        stmt.run(id, memberId, input.memberReasons[memberId] ?? 'llm');
      }
      return id;
    });
    return tx();
  }

  insertMemberAdd(input: InsertMemberAddInput): number | null {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT OR IGNORE INTO feature_suggestions
          (kind, feature_id, rationale, confidence, signals_json,
           member_set_hash, status, created_at)
        VALUES ('member_add', ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        input.featureId, input.rationale, input.confidence,
        JSON.stringify(input.signals), input.hash, Date.now()
      );
      if (info.changes === 0) return null;
      const id = Number(info.lastInsertRowid);
      this.db.prepare(
        'INSERT INTO feature_suggestion_members (suggestion_id, item_id, reason) VALUES (?, ?, ?)'
      ).run(id, input.itemId, 'llm');
      return id;
    });
    return tx();
  }

  // True if a non-pending suggestion already exists for this set+kind. Cheap
  // pre-LLM check used by the job to avoid spending tokens on already-decided sets.
  hashAlreadyDecided(hash: string, kind: SuggestionKind): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM feature_suggestions
      WHERE member_set_hash = ? AND kind = ? AND status IN ('accepted','dismissed','superseded')
      LIMIT 1
    `).get(hash, kind);
    return !!row;
  }

  findById(id: number): FeatureSuggestion | undefined {
    return this.db.prepare('SELECT * FROM feature_suggestions WHERE id = ?').get(id) as FeatureSuggestion | undefined;
  }

  // Pending suggestions with members resolved + filtered. A suggestion is
  // hidden if any of its members are no longer open or have already been
  // attached to a feature_member link (including a different feature). Keeps
  // the UI honest without a sweeper job.
  listPending(opts: { kind?: SuggestionKind; featureId?: number; limit?: number } = {}): SuggestionWithMembers[] {
    const conds: string[] = [`fs.status = 'pending'`];
    const params: unknown[] = [];
    if (opts.kind) { conds.push('fs.kind = ?'); params.push(opts.kind); }
    if (opts.featureId !== undefined) { conds.push('fs.feature_id = ?'); params.push(opts.featureId); }
    const limit = opts.limit ?? 50;

    const rows = this.db.prepare(`
      SELECT fs.*, fi.title AS feature_title
      FROM feature_suggestions fs
      LEFT JOIN backlog_items fi ON fi.id = fs.feature_id
      WHERE ${conds.join(' AND ')}
      ORDER BY fs.confidence DESC, fs.created_at DESC
      LIMIT ${limit}
    `).all(...params) as Array<FeatureSuggestion & { feature_title: string | null }>;

    if (rows.length === 0) return [];

    const memberStmt = this.db.prepare(`
      SELECT m.item_id, m.reason, b.source, b.title, b.url, b.status
      FROM feature_suggestion_members m
      JOIN backlog_items b ON b.id = m.item_id
      WHERE m.suggestion_id = ?
    `);

    // Pre-fetch which items are already feature_members so we can filter stale suggestions.
    const memberOf = new Set<number>(
      (this.db.prepare(`SELECT child_id FROM backlog_links WHERE link_type = 'feature_member'`).all() as { child_id: number }[])
        .map(r => r.child_id)
    );

    const out: SuggestionWithMembers[] = [];
    for (const row of rows) {
      const members = memberStmt.all(row.id) as SuggestionMember[];
      if (members.length === 0) continue;
      const stale = members.some(m => m.status !== 'open' || (row.kind === 'new_feature' && memberOf.has(m.item_id)) || (row.kind === 'member_add' && memberOf.has(m.item_id)));
      if (stale) continue;
      out.push({ ...row, members });
    }
    return out;
  }

  // Member-add suggestions for a specific feature, used inside the feature edit modal.
  listMemberSuggestionsForFeature(featureId: number): SuggestionWithMembers[] {
    return this.listPending({ kind: 'member_add', featureId, limit: 20 });
  }

  // Accept a suggestion. For 'new_feature' creates the feature item + links;
  // for 'member_add' just adds the link. Returns the resulting feature id.
  // Wrapped in a transaction.
  accept(
    id: number,
    repos: { backlog: BacklogRepo; backlogEvents: BacklogEventRepo },
    overrides?: AcceptOverrides,
  ): number {
    const sug = this.findById(id);
    if (!sug) throw new Error(`Suggestion ${id} not found`);
    if (sug.status !== 'pending') throw new Error(`Suggestion ${id} already ${sug.status}`);

    const memberRows = this.db.prepare(
      'SELECT item_id FROM feature_suggestion_members WHERE suggestion_id = ?'
    ).all(id) as { item_id: number }[];
    const removeSet = new Set(overrides?.removeIds ?? []);
    const finalMemberIds = memberRows.map(r => r.item_id).filter(mid => !removeSet.has(mid));

    const tx = this.db.transaction(() => {
      let featureId: number;
      if (sug.kind === 'new_feature') {
        const title = (overrides?.title ?? sug.proposed_title ?? '').trim();
        if (!title) throw new Error('Cannot accept new_feature suggestion without a title');
        if (finalMemberIds.length === 0) throw new Error('Cannot accept new_feature suggestion with no members');
        const desc = overrides?.description ?? sug.proposed_desc ?? undefined;
        featureId = repos.backlog.createFeature(title, desc ?? undefined);
        for (const mid of finalMemberIds) {
          repos.backlog.addLink(featureId, mid, 'feature_member', 'suggestion', sug.confidence);
        }
        repos.backlogEvents.insert(featureId, 'created', `Feature created from suggestion #${id}`, {
          suggestion_id: id, member_count: finalMemberIds.length,
        });
      } else {
        if (sug.feature_id == null) throw new Error('member_add suggestion missing feature_id');
        if (finalMemberIds.length !== 1) throw new Error('member_add suggestion must have exactly one member');
        featureId = sug.feature_id;
        repos.backlog.addLink(featureId, finalMemberIds[0]!, 'feature_member', 'suggestion', sug.confidence);
        repos.backlogEvents.insert(featureId, 'member_added', `Member added from suggestion #${id}`, {
          suggestion_id: id, item_id: finalMemberIds[0],
        });
      }

      this.db.prepare(`
        UPDATE feature_suggestions
        SET status = 'accepted', decided_at = ?, decided_by = ?, accepted_feature_id = ?
        WHERE id = ?
      `).run(Date.now(), 'ui', featureId, id);

      // Mark other pending new_feature suggestions whose member set is a strict
      // subset of this one as superseded — cheap dedup post-accept.
      if (sug.kind === 'new_feature' && finalMemberIds.length >= 2) {
        const others = this.db.prepare(`
          SELECT id FROM feature_suggestions WHERE kind = 'new_feature' AND status = 'pending' AND id != ?
        `).all(id) as { id: number }[];
        const setA = new Set(finalMemberIds);
        for (const other of others) {
          const otherMembers = this.db.prepare(
            'SELECT item_id FROM feature_suggestion_members WHERE suggestion_id = ?'
          ).all(other.id) as { item_id: number }[];
          if (otherMembers.length === 0) continue;
          const isSubset = otherMembers.every(m => setA.has(m.item_id));
          if (isSubset) {
            this.db.prepare(`
              UPDATE feature_suggestions
              SET status = 'superseded', decided_at = ?, decided_by = 'system'
              WHERE id = ?
            `).run(Date.now(), other.id);
          }
        }
      }

      return featureId;
    });
    return tx();
  }

  dismiss(id: number, decidedBy: string = 'ui'): void {
    this.db.prepare(`
      UPDATE feature_suggestions
      SET status = 'dismissed', decided_at = ?, decided_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(Date.now(), decidedBy, id);
  }

  countPending(): { newFeature: number; memberAdd: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'new_feature' THEN 1 ELSE 0 END) AS nf,
        SUM(CASE WHEN kind = 'member_add'  THEN 1 ELSE 0 END) AS ma
      FROM feature_suggestions WHERE status = 'pending'
    `).get() as { nf: number | null; ma: number | null };
    return { newFeature: row.nf ?? 0, memberAdd: row.ma ?? 0 };
  }
}
