import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  MessageUpsertType,
  fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import { logger } from '../utils/logger.js';
import { AbstractInboundService, InboundMessage, SendOptions, ParticipantInfo } from './InboundService.js';

// Strip Baileys device suffix from a JID (e.g. '12345:0@s.whatsapp.net' -> '12345@s.whatsapp.net').
function canonicalJid(jid: string | undefined | null): string {
  if (!jid) return '';
  const [user, domain] = jid.split('@');
  if (!domain) return jid;
  const userOnly = user.split(':')[0];
  return `${userOnly}@${domain}`;
}

export class WhatsAppService extends AbstractInboundService {
  private sock?: WASocket;
  private mentionKeyword = process.env.MENTION_KEYWORD || '@siddhant';
  private myJid: string = '';

  constructor(private sessionPath: string = 'auth_info_baileys') {
    super();
  }

  getSocket(): WASocket | undefined {
    return this.sock;
  }

  getMyJid(): string {
    return this.myJid;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version, isLatest } = await fetchLatestWaWebVersion();
    logger.info({ version: version.join('.'), isLatest }, 'Using Baileys version');

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: logger as any,
      browser: ['BeyondChats', 'BeyondChats', '1.0.0'],
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('Received QR event from Baileys; scan to link this account');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.error({ err: lastDisconnect?.error }, 'connection closed');
        if (shouldReconnect) {
          this.start();
        }
      } else if (connection === 'open') {
        this.myJid = canonicalJid(this.sock?.user?.id);
        logger.info({ myJid: this.myJid }, 'WhatsApp connection open');

        // One-shot dump so the user can populate team.json without messaging in real groups.
        try {
          const groups = await this.sock!.groupFetchAllParticipating();
          const list = Object.values(groups).map(g => ({ jid: g.id, name: g.subject, members: g.participants?.length }));
          logger.info({ count: list.length, groups: list }, '== Groups you are in (copy JIDs into team.json) ==');
        } catch (err) {
          logger.error({ err }, 'groupFetchAllParticipating failed');
        }
      }
    });

    this.sock.ev.on('messages.upsert', async (m: { messages: proto.IWebMessageInfo[], type: MessageUpsertType }) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message || !msg.key) continue;
        // Drop delivery/read receipts and other protocol noise
        if (msg.message.protocolMessage) continue;

        const text = msg.message.conversation
                  || msg.message.extendedTextMessage?.text
                  || msg.message.imageMessage?.caption
                  || msg.message.videoMessage?.caption
                  || msg.message.buttonsResponseMessage?.selectedButtonId
                  || '';

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');
        const isFromMe = !!msg.key.fromMe;

        // True sender JID for any of the four (group|dm) x (fromMe|incoming) cases:
        let senderJid: string;
        if (isGroup) {
          senderJid = canonicalJid(msg.key.participant || '');
        } else if (isFromMe) {
          senderJid = this.myJid || canonicalJid(msg.key.participant || remoteJid);
        } else {
          senderJid = canonicalJid(remoteJid);
        }

        const hasImage = !!msg.message.imageMessage;
        const hasOtherMedia = !!(msg.message.videoMessage || msg.message.audioMessage || msg.message.documentMessage || msg.message.stickerMessage);

        // Skip empty messages with no content of any kind.
        if (!text && !hasImage && !hasOtherMedia) continue;

        const ctxInfo = msg.message.extendedTextMessage?.contextInfo
                     || msg.message.imageMessage?.contextInfo
                     || msg.message.videoMessage?.contextInfo;
        const mentions = ctxInfo?.mentionedJid?.map(canonicalJid).filter(Boolean) ?? [];
        const quotedId = ctxInfo?.stanzaId || undefined;

        const inboundMsg: InboundMessage = {
          id: msg.key.id || undefined,
          sender: senderJid,
          groupID: isGroup ? remoteJid : '',
          text,
          isMentioned: text.includes(this.mentionKeyword),
          isFromMe,
          mentions,
          hasImage,
          hasMedia: hasImage || hasOtherMedia,
          quotedId,
          pushName: msg.pushName || undefined,
          timestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
          raw: msg,
        };

        logger.info({
          dir: isFromMe ? 'out' : 'in',
          chat: isGroup ? 'group' : 'dm',
          remoteJid,
          sender: senderJid,
          textPreview: text ? text.slice(0, 80) : '<media>'
        }, 'message');

        this.emitMessage(inboundMsg);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
    }
  }

  async sendMessage(to: string, text: string, opts?: SendOptions): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(to, { text, mentions: opts?.mentions });
  }

  async getGroupParticipants(groupJid: string): Promise<ParticipantInfo[] | undefined> {
    if (!this.sock) return undefined;
    try {
      const meta = await this.sock.groupMetadata(groupJid);
      return meta.participants.map(p => ({
        id: canonicalJid(p.id),
        lid: p.lid ? canonicalJid(p.lid) : undefined,
        phoneNumber: p.phoneNumber ? canonicalJid(p.phoneNumber) : undefined,
      }));
    } catch (err) {
      logger.error({ err, groupJid }, 'groupMetadata fetch failed');
      return undefined;
    }
  }
}
