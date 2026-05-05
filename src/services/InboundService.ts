import { EventEmitter } from 'events';
import type { proto } from '@whiskeysockets/baileys';

export interface SendOptions {
  mentions?: string[];   // JIDs to mention (must also appear as @<digits> in text)
}

export interface InboundMessage {
  id?: string;                    // WA message key.id
  sender: string;                 // canonical sender JID (participant in groups, real user in DMs)
  groupID: string;                // group JID, or '' for DM
  groupName?: string;
  text: string;
  isMentioned: boolean;
  isFromMe?: boolean;
  mentions?: string[];            // mentioned JIDs in this message
  hasImage?: boolean;
  hasMedia?: boolean;
  quotedId?: string;
  pushName?: string;              // display name the sender has set in WhatsApp
  timestamp: number;              // unix seconds
  raw?: proto.IWebMessageInfo;    // full Baileys proto for hooks/jobs (e.g., media download)
}

export interface ParticipantInfo {
  id: string;             // canonical id Baileys uses for this participant (often @lid)
  lid?: string;           // explicit @lid form when distinct from id
  phoneNumber?: string;   // @s.whatsapp.net form, when known
}

export abstract class AbstractInboundService extends EventEmitter {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(to: string, text: string, opts?: SendOptions): Promise<void>;

  // Returns participants for a group, or undefined when the socket is not
  // available / the call fails. Implementations should not throw — callers
  // (e.g. EOD kickoff validation) treat undefined as "skip validation".
  abstract getGroupParticipants(groupJid: string): Promise<ParticipantInfo[] | undefined>;

  protected emitMessage(message: InboundMessage) {
    this.emit('message', message);
  }
}
