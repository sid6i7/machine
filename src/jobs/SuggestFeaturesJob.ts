import crypto from 'crypto';
import type { Job, JobContext } from './Job.js';
import {
  clusterFeatureSystem,
  clusterFeatureSchema,
  buildClusterFeatureUser,
  memberFitSystem,
  memberFitSchema,
  buildMemberFitUser,
  type ClusterFeatureOutput,
  type ClusterCandidateItem,
  type MemberFitOutput,
} from '../llm/prompts/clusterFeatures.js';

// Tokenizer stop-list shared with SyncGitlabMrsJob's MR-matching pre-filter.
// Keep these in sync if you tune one — they're solving the same "noise words
// dominate Jaccard" problem.
const STOP = new Set([
  'the','a','an','and','or','of','for','fix','feat','chore','add','update',
  'prod','staging','dev','to','on','in','by','with','wip','from','that',
  'this','will','etc','as','is','it','be','at','do','new','old','ui','api'
]);

interface CandidateRow {
  id: number;
  source: string;
  title: string;
  description: string | null;
  url: string | null;
  metadata_json: string | null;
  updated_at: number;
}

interface TokenizedItem extends CandidateRow {
  tokens: Set<string>;
}

interface FeatureRow {
  id: number;
  title: string;
  description: string | null;
}

// Plain DSU. Items keyed by id.
class DSU {
  private parent = new Map<number, number>();
  add(x: number) { if (!this.parent.has(x)) this.parent.set(x, x); }
  find(x: number): number {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let cur = x;
    while (this.parent.get(cur)! !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, this.parent.get(next)!);
      cur = next;
    }
    return cur;
  }
  union(a: number, b: number) {
    this.add(a); this.add(b);
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  components(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      const arr = groups.get(r);
      if (arr) arr.push(x); else groups.set(r, [x]);
    }
    return groups;
  }
}

function tokenize(item: CandidateRow): Set<string> {
  let raw = `${item.title} ${item.description ?? ''}`;
  if (item.source === 'gitlab' && item.metadata_json) {
    try {
      const meta = JSON.parse(item.metadata_json) as { source_branch?: string };
      if (meta.source_branch) raw += ' ' + meta.source_branch.replace(/[/_-]+/g, ' ');
    } catch { /* ignore */ }
  }
  return new Set(
    raw.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function hashIds(ids: number[], prefix: string = ''): string {
  const sorted = [...ids].sort((x, y) => x - y).join(',');
  return crypto.createHash('sha1').update(prefix + ':' + sorted).digest('hex');
}

// Greedy split of an oversized component into ~maxSize chunks. Each chunk is
// seeded by the highest-degree remaining node and accretes its top-K most-
// connected neighbors. Cheap and produces human-reviewable clusters.
function splitComponent(memberIds: number[], pairScores: Map<string, number>, maxSize: number): number[][] {
  if (memberIds.length <= maxSize) return [memberIds];
  const remaining = new Set(memberIds);
  const chunks: number[][] = [];
  const score = (a: number, b: number) => pairScores.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0;

  while (remaining.size > 0) {
    // Highest-degree seed (sum of edge weights to other remaining members).
    let seed = -1, bestDeg = -1;
    for (const x of remaining) {
      let deg = 0;
      for (const y of remaining) if (y !== x) deg += score(x, y);
      if (deg > bestDeg) { bestDeg = deg; seed = x; }
    }
    const chunk: number[] = [seed];
    remaining.delete(seed);
    while (chunk.length < maxSize && remaining.size > 0) {
      let best = -1, bestS = -1;
      for (const y of remaining) {
        let s = 0;
        for (const x of chunk) s += score(x, y);
        if (s > bestS) { bestS = s; best = y; }
      }
      if (best < 0 || bestS <= 0) break;
      chunk.push(best);
      remaining.delete(best);
    }
    chunks.push(chunk);
    // If isolated leftover singletons remain (no edges to anyone left), drop them.
    if (remaining.size > 0) {
      let anyEdges = false;
      for (const x of remaining) for (const y of remaining) if (x !== y && score(x, y) > 0) { anyEdges = true; break; }
      if (!anyEdges) break;
    }
  }
  return chunks;
}

export class SuggestFeaturesJob implements Job {
  name = 'SuggestFeaturesJob';
  // Off-hours daily. SCHEDULER_TZ is Asia/Kolkata by default.
  schedule = '0 3 * * *';
  description = 'Daily: cluster orphan backlog items into proposed features (suggestions only — humans accept/reject in /backlog).';

  async run(ctx: JobContext): Promise<void> {
    const MAX_CANDIDATES   = parseInt(process.env.SUGGEST_FEATURES_MAX_CANDIDATES   || '300', 10);
    const JACCARD_MIN      = parseFloat(process.env.SUGGEST_FEATURES_JACCARD_MIN    || '0.25');
    const TIME_WINDOW_DAYS = parseInt(process.env.SUGGEST_FEATURES_TIME_WINDOW_DAYS || '21', 10);
    const MAX_COMPONENT    = parseInt(process.env.SUGGEST_FEATURES_MAX_COMPONENT_SIZE || '8', 10);
    const MIN_CONF         = parseFloat(process.env.SUGGEST_FEATURES_MIN_CONF       || '0.6');
    const MAX_LLM_CALLS    = parseInt(process.env.SUGGEST_FEATURES_MAX_LLM_CALLS    || '80', 10);
    const TIME_WINDOW_MS   = TIME_WINDOW_DAYS * 86_400_000;

    // --- Step 1: candidates (open items not already in any feature) ---
    const rows = ctx.db.prepare(`
      SELECT id, source, title, description, url, metadata_json, updated_at
      FROM backlog_items
      WHERE status = 'open'
        AND source IN ('sheet','gitlab','wa_task')
        AND id NOT IN (SELECT child_id FROM backlog_links WHERE link_type = 'feature_member')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(MAX_CANDIDATES) as CandidateRow[];

    if (rows.length < 2) {
      ctx.logger.info({ job: this.name, candidates: rows.length }, 'Not enough candidates; nothing to cluster');
      return;
    }
    const idSet = new Set(rows.map(r => r.id));

    // Hard-link edges (sheet_mr / wa_task_mr / manual). Includes edges where
    // exactly one side is in our candidate set — those are routes to existing
    // features (the other end is an item already attached to one).
    const allHardLinks = ctx.db.prepare(`
      SELECT parent_id, child_id, link_type FROM backlog_links
      WHERE link_type IN ('sheet_mr','wa_task_mr','manual')
    `).all() as { parent_id: number; child_id: number; link_type: string }[];

    // Items by id, tokenized.
    const items: TokenizedItem[] = rows.map(r => ({ ...r, tokens: tokenize(r) }));
    const byId = new Map(items.map(i => [i.id, i]));

    // --- Step 2: existing features + their member ids ---
    const features = ctx.db.prepare(`
      SELECT id, title, description FROM backlog_items WHERE source = 'feature' AND status = 'open'
    `).all() as FeatureRow[];
    const featureMembers = new Map<number, number[]>();
    if (features.length > 0) {
      const memberRows = ctx.db.prepare(`
        SELECT parent_id AS feature_id, child_id AS item_id
        FROM backlog_links WHERE link_type = 'feature_member'
      `).all() as { feature_id: number; item_id: number }[];
      for (const f of features) featureMembers.set(f.id, []);
      for (const m of memberRows) {
        const arr = featureMembers.get(m.feature_id);
        if (arr) arr.push(m.item_id);
      }
    }

    // --- Step 3: route orphans hard-linked to a featured item → member_add ---
    // Map: orphan_id → set of featureIds it should be a member_add candidate for.
    const memberAddByFeature = new Map<number, Set<number>>();
    const itemToFeature = new Map<number, number>();
    for (const [fid, members] of featureMembers) {
      for (const m of members) itemToFeature.set(m, fid);
    }
    const hardEdgesAmongOrphans: Array<[number, number]> = [];
    for (const link of allHardLinks) {
      const a = link.parent_id, b = link.child_id;
      const aOrphan = idSet.has(a), bOrphan = idSet.has(b);
      if (aOrphan && bOrphan) {
        hardEdgesAmongOrphans.push([a, b]);
      } else if (aOrphan && itemToFeature.has(b)) {
        const fid = itemToFeature.get(b)!;
        if (!memberAddByFeature.has(fid)) memberAddByFeature.set(fid, new Set());
        memberAddByFeature.get(fid)!.add(a);
      } else if (bOrphan && itemToFeature.has(a)) {
        const fid = itemToFeature.get(a)!;
        if (!memberAddByFeature.has(fid)) memberAddByFeature.set(fid, new Set());
        memberAddByFeature.get(fid)!.add(b);
      }
    }

    // --- Step 4: build similarity graph among orphans ---
    const dsu = new DSU();
    items.forEach(i => dsu.add(i.id));
    const pairScores = new Map<string, number>();   // key "a:b" with a<b → jaccard
    const memberReasons = new Map<number, Map<number, 'hard_link' | 'token_overlap'>>();
    const noteReason = (componentRoot: number, id: number, reason: 'hard_link' | 'token_overlap') => {
      let m = memberReasons.get(componentRoot);
      if (!m) { m = new Map(); memberReasons.set(componentRoot, m); }
      // Don't downgrade hard_link to token_overlap.
      if (m.get(id) !== 'hard_link') m.set(id, reason);
    };

    // Hard edges always union — but we still mark the reason on members.
    for (const [a, b] of hardEdgesAmongOrphans) {
      dsu.union(a, b);
      pairScores.set(a < b ? `${a}:${b}` : `${b}:${a}`, 1);
    }

    // Pairwise jaccard + time co-occurrence. O(N²) at ≤300 candidates is trivial.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i]!, B = items[j]!;
        if (Math.abs(A.updated_at - B.updated_at) > TIME_WINDOW_MS) continue;
        const s = jaccard(A.tokens, B.tokens);
        if (s >= JACCARD_MIN) {
          dsu.union(A.id, B.id);
          pairScores.set(A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`, s);
        }
      }
    }

    // --- Step 5: shape components → new_feature candidates ---
    const components = dsu.components();
    const newFeatureClusters: number[][] = [];
    for (const ids of components.values()) {
      if (ids.length < 2) continue;
      const chunks = splitComponent(ids, pairScores, MAX_COMPONENT);
      for (const chunk of chunks) if (chunk.length >= 2) newFeatureClusters.push(chunk);
    }

    // Annotate member reasons per cluster (hard_link if any incident hard edge, else token_overlap).
    const clusterReasons: Array<Record<number, 'hard_link' | 'token_overlap'>> = newFeatureClusters.map(chunk => {
      const set = new Set(chunk);
      const reasons: Record<number, 'hard_link' | 'token_overlap'> = {};
      for (const id of chunk) reasons[id] = 'token_overlap';
      for (const [a, b] of hardEdgesAmongOrphans) {
        if (set.has(a) && set.has(b)) { reasons[a] = 'hard_link'; reasons[b] = 'hard_link'; }
      }
      return reasons;
    });

    // --- Step 6: LLM passes ---
    let llmCalls = 0;
    let suggestionsInserted = 0;
    let skippedDup = 0;
    const llmBudget = () => llmCalls < MAX_LLM_CALLS;

    // 6a — new_feature: one Gemini call per cluster.
    for (let idx = 0; idx < newFeatureClusters.length; idx++) {
      if (!llmBudget()) { ctx.logger.warn({ job: this.name }, 'LLM budget exhausted; remaining clusters skipped'); break; }
      const chunk = newFeatureClusters[idx]!;
      const hash = hashIds(chunk, 'new_feature');
      if (ctx.featureSuggestions.hashAlreadyDecided(hash, 'new_feature')) { skippedDup++; continue; }

      const llmItems: ClusterCandidateItem[] = chunk.map(id => {
        const it = byId.get(id)!;
        return { id, source: it.source, title: it.title, description: it.description ?? undefined };
      });
      const hardLinkPairs: Array<[number, number]> = hardEdgesAmongOrphans
        .filter(([a, b]) => chunk.includes(a) && chunk.includes(b));

      try {
        llmCalls++;
        const r = await ctx.gemini.classify<ClusterFeatureOutput>({
          system: clusterFeatureSystem,
          user: buildClusterFeatureUser({ items: llmItems, hardLinks: hardLinkPairs }),
          schema: clusterFeatureSchema,
        });
        const out = r.data;
        if (!out.is_coherent || (out.confidence ?? 0) < MIN_CONF) continue;
        const drop = new Set(out.drop_member_ids ?? []);
        const finalIds = chunk.filter(id => !drop.has(id));
        if (finalIds.length < 2) continue;

        const finalHash = hashIds(finalIds, 'new_feature');
        if (ctx.featureSuggestions.hashAlreadyDecided(finalHash, 'new_feature')) { skippedDup++; continue; }

        const reasonsForFinal: Record<number, 'hard_link' | 'token_overlap'> = {};
        for (const id of finalIds) reasonsForFinal[id] = clusterReasons[idx]![id] ?? 'token_overlap';

        const inserted = ctx.featureSuggestions.insertNewFeature({
          memberIds: finalIds,
          hash: finalHash,
          title: (out.proposed_title ?? '').slice(0, 80) || 'Untitled feature',
          description: (out.proposed_description ?? '').slice(0, 1000),
          rationale: (out.rationale ?? '').slice(0, 500),
          confidence: out.confidence,
          signals: {
            llm_conf: out.confidence,
            hard_link_count: hardLinkPairs.length,
            time_window_days: TIME_WINDOW_DAYS,
            jaccard_min: JACCARD_MIN,
          },
          memberReasons: reasonsForFinal,
        });
        if (inserted) suggestionsInserted++;
        else skippedDup++;
      } catch (err) {
        ctx.logger.error({ err, cluster: chunk }, 'clusterFeature LLM call failed');
      }
    }

    // 6b — member_add: for each feature with candidate orphans, batched LLM call.
    // Candidates come from two sources: hard-linked (already decided yes) and
    // jaccard-similar to feature title+desc+sample-members (need LLM gating).
    if (features.length > 0 && llmBudget()) {
      for (const feature of features) {
        if (!llmBudget()) break;
        const featureTokens = tokenize({ id: feature.id, source: 'feature', title: feature.title, description: feature.description, url: null, metadata_json: null, updated_at: 0 });

        // Sample of feature's existing members for context (up to 3).
        const memberIds = featureMembers.get(feature.id) ?? [];
        const sampleMembers: ClusterCandidateItem[] = [];
        if (memberIds.length > 0) {
          const sampleRows = ctx.db.prepare(
            `SELECT id, source, title, description FROM backlog_items WHERE id IN (${memberIds.slice(0, 3).map(() => '?').join(',')})`
          ).all(...memberIds.slice(0, 3)) as Array<{ id: number; source: string; title: string; description: string | null }>;
          for (const s of sampleRows) sampleMembers.push({ id: s.id, source: s.source, title: s.title, description: s.description ?? undefined });
        }

        // Candidate orphans: hard-linked (always include) ∪ jaccard-similar to feature.
        const candidates = new Map<number, ClusterCandidateItem>();
        for (const oid of memberAddByFeature.get(feature.id) ?? []) {
          const it = byId.get(oid); if (!it) continue;
          candidates.set(oid, { id: oid, source: it.source, title: it.title, description: it.description ?? undefined });
        }
        for (const it of items) {
          if (candidates.has(it.id)) continue;
          if (jaccard(it.tokens, featureTokens) >= JACCARD_MIN) {
            candidates.set(it.id, { id: it.id, source: it.source, title: it.title, description: it.description ?? undefined });
          }
        }
        if (candidates.size === 0) continue;

        // Skip candidates whose hash for (this feature, item) is already decided.
        const fresh: ClusterCandidateItem[] = [];
        for (const c of candidates.values()) {
          const h = hashIds([c.id], `member_add:${feature.id}`);
          if (!ctx.featureSuggestions.hashAlreadyDecided(h, 'member_add')) fresh.push(c);
        }
        if (fresh.length === 0) continue;

        try {
          llmCalls++;
          const r = await ctx.gemini.classify<MemberFitOutput>({
            system: memberFitSystem,
            user: buildMemberFitUser({
              feature: { id: feature.id, title: feature.title, description: feature.description ?? undefined, sampleMembers },
              candidates: fresh,
            }),
            schema: memberFitSchema,
          });
          for (const c of r.data.candidates ?? []) {
            if (!c.fits || (c.confidence ?? 0) < MIN_CONF) continue;
            const h = hashIds([c.item_id], `member_add:${feature.id}`);
            const inserted = ctx.featureSuggestions.insertMemberAdd({
              featureId: feature.id,
              itemId: c.item_id,
              hash: h,
              rationale: (c.reason ?? '').slice(0, 300),
              confidence: c.confidence,
              signals: { llm_conf: c.confidence, hard_linked: (memberAddByFeature.get(feature.id)?.has(c.item_id)) ?? false },
            });
            if (inserted) suggestionsInserted++; else skippedDup++;
          }
        } catch (err) {
          ctx.logger.error({ err, feature: feature.id }, 'memberFit LLM call failed');
        }
      }
    }

    ctx.logger.info({
      job: this.name,
      candidates: rows.length,
      features: features.length,
      newFeatureClusters: newFeatureClusters.length,
      memberAddFeatures: features.filter(f => (memberAddByFeature.get(f.id)?.size ?? 0) > 0).length,
      llmCalls,
      suggestionsInserted,
      skippedDup,
    }, 'SuggestFeaturesJob done');
  }
}
