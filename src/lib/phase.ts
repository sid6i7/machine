import type { BacklogItem, BacklogSource } from '../db/repos/BacklogRepo.js';
import type { Phase, ActionableTarget, BacklogActionableRepo } from '../db/repos/BacklogActionableRepo.js';

export const PHASES: Phase[] = ['intake', 'refined', 'in_sprint', 'in_dev', 'in_review', 'released'];

export const PHASE_LABEL: Record<Phase, string> = {
  intake:    'Intake',
  refined:   'Refined',
  in_sprint: 'In Sprint',
  in_dev:    'In Dev',
  in_review: 'In Review',
  released:  'Released',
};

export const PHASE_COLOR: Record<Phase, string> = {
  intake:    'bg-slate-200 text-slate-700',
  refined:   'bg-blue-100 text-blue-800',
  in_sprint: 'bg-indigo-100 text-indigo-800',
  in_dev:    'bg-amber-100 text-amber-800',
  in_review: 'bg-violet-100 text-violet-800',
  released:  'bg-emerald-100 text-emerald-800',
};

interface LinkedMrSummary {
  target_branch: string | null;     // "staging" | "prod" | other
  is_open: boolean;                 // open MR (still in backlog as gitlab item)
  is_merged_to_prod?: boolean;      // best-effort: derived from merged_log lookup
}

interface ComputePhaseInput {
  item: BacklogItem;
  linkedMrs?: LinkedMrSummary[];    // children MRs for sheet/wa_task; or [] for none
}

// Phase derivation. First match wins. See migration 014 + plan for rationale.
export function computePhase({ item, linkedMrs = [] }: ComputePhaseInput): Phase {
  if (item.phase_override && PHASES.includes(item.phase_override as Phase)) {
    return item.phase_override as Phase;
  }
  const meta = item.metadata_json ? JSON.parse(item.metadata_json) as Record<string, unknown> : {};

  // Released: resolved or any MR merged to prod.
  if (item.status === 'resolved') return 'released';
  if (linkedMrs.some(m => m.is_merged_to_prod)) return 'released';

  // For a standalone gitlab MR: target branch + open-ness drives the phase.
  if (item.source === 'gitlab') {
    const tm = item.title.match(/^\[([^\]]+)\]/);
    const target = tm ? tm[1] : '';
    if (target === 'prod') return 'in_review';
    return 'in_dev';   // staging or anything else
  }

  // For sheet / wa_task: use children MR state.
  const hasOpenProdMr    = linkedMrs.some(m => m.is_open && m.target_branch === 'prod');
  const hasOpenStagingMr = linkedMrs.some(m => m.is_open && m.target_branch === 'staging');
  if (hasOpenProdMr) return 'in_review';
  if (hasOpenStagingMr) return 'in_dev';

  if (item.source === 'sheet') {
    const assignee = meta['Allotted to'] ? String(meta['Allotted to']).trim() : '';
    const eta = meta.ETA ? String(meta.ETA).trim() : '';
    const sprint = meta.Sprint ? String(meta.Sprint).trim() : '';
    if (assignee && (eta || sprint)) return 'in_sprint';
    if (assignee || (item.description && item.description.trim())) return 'refined';
    return 'intake';
  }

  // Other sources (wa_task, wa_connect, …): start at intake until linked / progressed.
  return 'intake';
}

// ─── Templates ──────────────────────────────────────────────────────────────
// Static seeds. Each (source, phase) maps to a list of canonical micro-steps.
// Keys are stable slugs — never rename without a migration that rewrites them.

interface TemplateEntry {
  key: string;
  text: string;
  defaultTarget?: ActionableTarget;
}

type TemplateMap = Partial<Record<BacklogSource, Partial<Record<Phase, TemplateEntry[]>>>>;

export const PHASE_TEMPLATES: TemplateMap = {
  sheet: {
    intake: [
      { key: 'sheet_clarify_scope', text: 'Read the request — is the ask clear?' },
      { key: 'sheet_dm_requester',  text: 'If unclear: DM requester for missing context', defaultTarget: 'owner' },
    ],
    refined: [
      { key: 'sheet_acceptance',    text: 'Write acceptance criteria in Task Details' },
      { key: 'sheet_assign',        text: 'Assign owner ("Allotted to")' },
      { key: 'sheet_eta',           text: 'Set ETA' },
    ],
    in_sprint: [
      { key: 'sheet_kickoff',       text: 'Kickoff call (optional) with owner', defaultTarget: 'owner' },
      { key: 'sheet_sprint_set',    text: 'Confirm sprint label is set on the row' },
    ],
    in_dev: [
      { key: 'sheet_mr_linked',     text: 'MR opened and linked to this row' },
      { key: 'sheet_progress_ping', text: 'Mid-sprint progress ping to owner', defaultTarget: 'owner' },
    ],
    in_review: [
      { key: 'sheet_demo_video',    text: 'Request demo video from author', defaultTarget: 'mr_author' },
      { key: 'sheet_code_review',   text: 'Code review (Claude + human) complete' },
      { key: 'sheet_staging_qa',    text: 'Verified on staging' },
    ],
    released: [
      { key: 'sheet_prod_verify',   text: 'Verified in prod' },
      { key: 'sheet_resolve_row',   text: 'Mark sheet row resolved' },
    ],
  },
  gitlab: {
    in_dev: [
      { key: 'mr_what_fixes',       text: 'Ask author: what does this fix? Where is the request?', defaultTarget: 'mr_author' },
      { key: 'mr_link_to_row',      text: 'Link this MR to a sheet row if applicable' },
    ],
    in_review: [
      { key: 'mr_demo_video',       text: 'Request demo video from author', defaultTarget: 'mr_author' },
      { key: 'mr_claude_review',    text: 'Run Claude Code review' },
      { key: 'mr_human_review',     text: 'Human review pass' },
      { key: 'mr_staging_qa',       text: 'Test on staging branch' },
    ],
    released: [
      { key: 'mr_prod_verify',      text: 'Verified in prod' },
    ],
  },
  wa_task: {
    intake: [
      { key: 'wa_classify',         text: 'Decide: dev task, ops, or noise?' },
      { key: 'wa_link_or_create',   text: 'Link to existing row or create a new sheet entry' },
    ],
  },
};

export function templatesFor(source: BacklogSource, phase: Phase): TemplateEntry[] {
  return PHASE_TEMPLATES[source]?.[phase] ?? [];
}

// Idempotent seed. Inserts any templates for (source, phase) that aren't
// already present (UNIQUE on (backlog_id, template_key) provides the safety
// net but we also short-circuit when seeded count matches expected count).
export function seedIfEmpty(
  repo: BacklogActionableRepo,
  backlogId: number,
  source: BacklogSource,
  phase: Phase,
): void {
  const tpl = templatesFor(source, phase);
  if (tpl.length === 0) return;
  if (repo.countSeededForBacklogPhase(backlogId, phase) >= tpl.length) return;
  for (const t of tpl) {
    repo.insert({
      backlogId,
      phase,
      text: t.text,
      templateKey: t.key,
      target: t.defaultTarget ?? 'self',
    });
  }
}
