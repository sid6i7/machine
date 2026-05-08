import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_JSON_PATH = path.resolve(__dirname, '../../config/team.json');

export interface TeamMember {
  jid: string;
  // Alternate JID form (typically the member's @lid when `jid` is the
  // @s.whatsapp.net form, or vice-versa). When set, lookups and mention
  // matches consider both `jid` and `lid` as equivalent identities.
  lid?: string;
  name: string;
  email?: string;
  role?: string;
  excludeFromTasklist?: boolean;
  excludeFromEod?: boolean;
  // True for members the user actively manages (drives EOD/tasklist follow-ups).
  managedByUser?: boolean;
  // Force inclusion in DailyMemberSummaryJob even if not managed/excluded from
  // EOD. For peers on adjacent teams whose activity the user wants to track
  // without prompting them for EODs.
  includeInSummary?: boolean;
  // Where the EOD kickoff prompt is delivered: a key from groups (e.g. 'webdev',
  // 'ml-ai') for a group post, or 'dm' / unset for a direct message.
  eodChannel?: string;
}

export interface TeamGroupRef {
  jid: string;
  name: string;
}

export interface TeamConfig {
  userJid: string;
  // Manager's @lid form. Mentions in WhatsApp arrive as @lid, while outbound
  // sends use userJid (@s.whatsapp.net) — both are needed.
  userLid?: string;
  groups: Record<string, TeamGroupRef>;
  members: TeamMember[];
}

export class TeamRepo {
  private cache: TeamConfig | null = null;
  private cachedMtimeMs = 0;

  // Force a re-read on next access. Useful right after the wizard writes a
  // fresh team.json without restarting the bot.
  invalidate(): void {
    this.cache = null;
    this.cachedMtimeMs = 0;
  }

  // mtime-aware read; tolerates missing file (returns null).
  private loadOrNull(): TeamConfig | null {
    if (!fs.existsSync(TEAM_JSON_PATH)) return null;
    const stat = fs.statSync(TEAM_JSON_PATH);
    if (this.cache && stat.mtimeMs === this.cachedMtimeMs) {
      return this.cache;
    }
    const raw = fs.readFileSync(TEAM_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as TeamConfig;
    this.cache = parsed;
    this.cachedMtimeMs = stat.mtimeMs;
    logger.info(
      { members: parsed.members.length, groups: Object.keys(parsed.groups).length },
      'Loaded team.json'
    );
    return parsed;
  }

  private mustLoad(): TeamConfig {
    const cfg = this.loadOrNull();
    if (!cfg) {
      throw new Error(`team.json not found at ${TEAM_JSON_PATH}. Run 'npm run setup' first.`);
    }
    return cfg;
  }

  exists(): boolean {
    return fs.existsSync(TEAM_JSON_PATH);
  }

  getUserJid(): string {
    return this.mustLoad().userJid;
  }

  // Returns the manager's @lid (used for matching @-mentions in stored
  // mentions_json arrays). Falls back to userJid when not configured.
  getUserLid(): string {
    const cfg = this.mustLoad();
    return cfg.userLid || cfg.userJid;
  }

  getManagedMembers(): TeamMember[] {
    return this.loadOrNull()?.members.filter(m => m.managedByUser) ?? [];
  }

  getMember(jid: string): TeamMember | undefined {
    return this.loadOrNull()?.members.find(m => m.jid === jid || m.lid === jid);
  }

  getMembers(): TeamMember[] {
    return this.loadOrNull()?.members ?? [];
  }

  getGroupJid(label: string): string | undefined {
    return this.loadOrNull()?.groups[label]?.jid;
  }

  getMonitoredGroupJids(): string[] {
    const cfg = this.loadOrNull();
    if (!cfg) return [];
    return Object.values(cfg.groups).map(g => g.jid);
  }

  getEmailForJid(jid: string): string | undefined {
    return this.getMember(jid)?.email;
  }

  isKnownMember(jid: string): boolean {
    return this.getMember(jid) !== undefined;
  }

  // Returns the configured label for a chat ('meetings' | 'org-level' | etc.),
  // or undefined for unknown / non-monitored chats.
  getGroupLabel(jid: string): string | undefined {
    const cfg = this.loadOrNull();
    if (!cfg) return undefined;
    for (const [label, g] of Object.entries(cfg.groups)) {
      if (g.jid === jid) return label;
    }
    return undefined;
  }

  // Resolve a free-text sender name (as it appears in WhatsApp pushName or in
  // a chat-export "Sender: ..." line) to a configured TeamMember. Used by
  // backfill-analyze where the only sender identifier is the human name.
  // Match: exact (case-insensitive) on name, OR substring containment either way.
  // Returns undefined if no member matches.
  findMemberByName(rawName: string): TeamMember | undefined {
    const cfg = this.loadOrNull();
    if (!cfg) return undefined;
    const needle = rawName.trim().toLowerCase();
    if (!needle) return undefined;
    // Exact case-insensitive first
    const exact = cfg.members.find(m => (m.name || '').trim().toLowerCase() === needle);
    if (exact) return exact;
    // Substring either-way (handles "Siddhant" vs "Siddhant Jain")
    return cfg.members.find(m => {
      const cand = (m.name || '').trim().toLowerCase();
      if (!cand) return false;
      return cand.includes(needle) || needle.includes(cand);
    });
  }
}
