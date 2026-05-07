import type { Action } from './Action.js';
import type { InboundMessage } from '../services/InboundService.js';
import { BacklogRepo, type BacklogItem, type BacklogSource } from '../db/repos/BacklogRepo.js';

const KEYWORD = process.env.MENTION_KEYWORD || '@siddhant';

export class BacklogAction implements Action {
  name = 'backlog';
  template = `${KEYWORD} backlog`;
  description = 'Show the unified backlog: sheet, GitLab MRs, WA tasks, connects, unreplied mentions.';

  matches(message: InboundMessage): boolean {
    const text = (message.text || '').toLowerCase().trim();
    return text.startsWith(`${KEYWORD.toLowerCase()} backlog`);
  }

  async execute(_message: InboundMessage): Promise<string> {
    const items = new BacklogRepo().listAllOpen();
    return formatBacklog(items);
  }
}

const SECTION_LIMIT = 10;

export function formatBacklog(items: BacklogItem[]): string {
  const groups: Record<BacklogSource, BacklogItem[]> = {
    sheet: [],
    gitlab: [],
    wa_task: [],
    wa_connect: [],
    wa_task_update: [],
    wa_status_check: [],
    wa_mention_unreplied: [],
    feature: [],
    manual: [],
  };
  for (const it of items) groups[it.source].push(it);

  const sections: string[] = [];

  const repo = new BacklogRepo();
  if (groups.sheet.length) {
    const top = groups.sheet.slice(0, SECTION_LIMIT).map(i => {
      const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, string> : {};
      const status = meta['Status'] || '';
      const assignee = meta['Allotted to'] || '';
      const eta = meta['ETA'] || '';
      const tags: string[] = [];
      if (status && status.toLowerCase() !== 'pending') tags.push(status);
      if (assignee) tags.push(assignee);
      if (eta) tags.push(`ETA ${eta}`);
      const tagStr = tags.length ? ` _(${tags.join(' • ')})_` : '';
      const linkedMrs = repo.getChildrenOf(i.id).filter(c => c.source === 'gitlab');
      const mrTag = linkedMrs.length ? ` 🔀×${linkedMrs.length}` : '';
      return `• ${i.title}${tagStr}${mrTag}`;
    }).join('\n');
    sections.push(`*📋 Sheet (${groups.sheet.length})*\n${top}`);
  }
  if (groups.gitlab.length) {
    const top = groups.gitlab.slice(0, SECTION_LIMIT).map(i => {
      const parents = repo.getParentsOf(i.id);
      const parentTag = parents.length ? ` _(↩ ${parents[0].title.slice(0, 50)})_` : '';
      return `• ${i.title}${parentTag}${i.url ? `\n  ${i.url}` : ''}`;
    }).join('\n');
    sections.push(`*🔀 GitLab MRs (${groups.gitlab.length})*\n${top}`);
  }
  if (groups.wa_task.length) {
    const dev = groups.wa_task.filter(i => i.is_dev_task === 1);
    const nonDev = groups.wa_task.filter(i => i.is_dev_task !== 1);
    const parts: string[] = [`*✅ WA Tasks (${groups.wa_task.length})*`];
    if (dev.length)    parts.push(`_Dev_:\n` + dev.slice(0, SECTION_LIMIT).map(i => `• ${i.title}`).join('\n'));
    if (nonDev.length) parts.push(`_Non-dev_:\n` + nonDev.slice(0, SECTION_LIMIT).map(i => `• ${i.title}`).join('\n'));
    sections.push(parts.join('\n'));
  }
  if (groups.wa_connect.length) {
    const top = groups.wa_connect.slice(0, SECTION_LIMIT).map(i => `• ${i.title}${i.url ? `\n  ${i.url}` : ''}`).join('\n');
    sections.push(`*📞 Connects (${groups.wa_connect.length})*\n${top}`);
  }
  if (groups.wa_task_update.length) {
    const top = groups.wa_task_update.slice(0, SECTION_LIMIT).map(i => {
      const meta = i.metadata_json ? JSON.parse(i.metadata_json) as Record<string, unknown> : {};
      const linkedTag = meta.linked_backlog_id ? ` _(→ #${meta.linked_backlog_id})_` : ' _(unlinked)_';
      return `• ${i.title}${linkedTag}`;
    }).join('\n');
    sections.push(`*🔁 Updates (${groups.wa_task_update.length})*\n${top}`);
  }
  if (groups.wa_status_check.length) {
    const top = groups.wa_status_check.slice(0, SECTION_LIMIT).map(i => `• ${i.title}`).join('\n');
    sections.push(`*❓ Status checks (${groups.wa_status_check.length})*\n${top}`);
  }
  if (groups.wa_mention_unreplied.length) {
    const top = groups.wa_mention_unreplied.slice(0, SECTION_LIMIT).map(i => `• ${i.title}`).join('\n');
    sections.push(`*🔔 Unreplied mentions (${groups.wa_mention_unreplied.length})*\n${top}`);
  }

  if (sections.length === 0) return 'Backlog is empty. 🎉';
  return `*Backlog*\n\n` + sections.join('\n\n');
}
