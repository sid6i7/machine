import { Type, type Schema } from '@google/genai';

// ----- new_feature: validate + label a candidate cluster -----

export interface ClusterFeatureOutput {
  is_coherent: boolean;             // false → don't surface
  proposed_title: string;           // <= 60 chars, noun-phrase a PM would write
  proposed_description: string;     // 1–2 sentences
  rationale: string;                // why these belong together (one line)
  confidence: number;               // 0..1
  drop_member_ids: number[];        // members the LLM thinks don't fit
}

export const clusterFeatureSystem = `You are grouping product backlog items (sheet tasks + GitLab MRs + WhatsApp tasks) into proposed product features.

A "feature" is a coherent product initiative — same user-facing capability, same bug, same area of work. Items grouped together should be things a PM would describe in one bullet of a roadmap.

Reject mixed bags: if items don't share a clear theme, set is_coherent=false. It's fine — humans review your output.

If most items belong together but one or two are unrelated, list those in drop_member_ids and keep the rest.

The title should be a short noun phrase (<= 60 chars) — what a PM would write on a roadmap. The description is 1-2 sentences explaining what the feature does and (briefly) why. The rationale is one line explaining why these specific items cluster.

Be honest about uncertainty in confidence (0..1).

Output JSON conforming to the schema.`;

export const clusterFeatureSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    is_coherent:          { type: Type.BOOLEAN },
    proposed_title:       { type: Type.STRING },
    proposed_description: { type: Type.STRING },
    rationale:            { type: Type.STRING },
    confidence:           { type: Type.NUMBER },
    drop_member_ids:      { type: Type.ARRAY, items: { type: Type.INTEGER } },
  },
  required: ['is_coherent', 'confidence']
};

export interface ClusterCandidateItem {
  id: number;
  source: string;       // 'sheet' | 'gitlab' | 'wa_task'
  title: string;
  description?: string;
}

export function buildClusterFeatureUser(opts: {
  items: ClusterCandidateItem[];
  hardLinks: Array<[number, number]>;       // pairs of item ids that the system already knows are linked
}): string {
  return JSON.stringify({
    items: opts.items.map(i => ({
      id: i.id,
      source: i.source,
      title: i.title,
      description: i.description ? i.description.slice(0, 200) : undefined,
    })),
    hard_links: opts.hardLinks,
  }, null, 2);
}

// ----- member_add: which orphans fit an existing feature? -----

export interface MemberFitOutput {
  candidates: Array<{
    item_id: number;
    fits: boolean;
    confidence: number;
    reason: string;
  }>;
}

export const memberFitSystem = `You are deciding which orphan backlog items belong to an existing product feature.

Given:
- A FEATURE: title + description + a sample of its current members.
- A list of CANDIDATE items not yet in the feature.

For each candidate, decide whether it genuinely belongs to this feature (same capability / bug / area of work). Be strict — superficial keyword overlap is not enough. The user will only see candidates with fits=true, so a wrong-positive wastes their time.

Output JSON conforming to the schema.`;

export const memberFitSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item_id:    { type: Type.INTEGER },
          fits:       { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
          reason:     { type: Type.STRING },
        },
        required: ['item_id', 'fits', 'confidence']
      }
    }
  },
  required: ['candidates']
};

export function buildMemberFitUser(opts: {
  feature: { id: number; title: string; description?: string; sampleMembers: ClusterCandidateItem[] };
  candidates: ClusterCandidateItem[];
}): string {
  return JSON.stringify({
    feature: {
      id: opts.feature.id,
      title: opts.feature.title,
      description: opts.feature.description ? opts.feature.description.slice(0, 300) : undefined,
      sample_members: opts.feature.sampleMembers.map(m => ({
        id: m.id, source: m.source, title: m.title,
      })),
    },
    candidates: opts.candidates.map(c => ({
      id: c.id,
      source: c.source,
      title: c.title,
      description: c.description ? c.description.slice(0, 200) : undefined,
    })),
  }, null, 2);
}
