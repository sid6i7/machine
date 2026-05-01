import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_JSON_PATH = path.resolve(__dirname, '../../config/team.json');

export interface TeamMember {
  jid: string;
  name: string;
  email?: string;
  role?: string;
  excludeFromTasklist?: boolean;
  excludeFromEod?: boolean;
}

export interface TeamGroupRef {
  jid: string;
  name: string;
}

export interface TeamConfig {
  userJid: string;
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

  getMember(jid: string): TeamMember | undefined {
    return this.loadOrNull()?.members.find(m => m.jid === jid);
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
}
