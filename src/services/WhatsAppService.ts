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
import pino from 'pino';
import 'dotenv/config';
import { AbstractInboundService, InboundMessage } from './InboundService.js';

export class WhatsAppService extends AbstractInboundService {
  private sock?: WASocket;
  private logger = pino({ 
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true
      }
    }
  });
  private mentionKeyword = process.env.MENTION_KEYWORD || '@siddhant';

  constructor(private sessionPath: string = 'auth_info_baileys') {
    super();
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    const { version, isLatest } = await fetchLatestWaWebVersion();
    this.logger.info(`Using Baileys version ${version.join('.')}, isLatest: ${isLatest}`);

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger as any,
      browser: ['BeyondChats', 'BeyondChats', '1.0.0'],
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('Received QR event from Baileys');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        this.logger.error(lastDisconnect?.error as any, 'connection closed');
        if (shouldReconnect) {
          this.start();
        }
      } else if (connection === 'open') {
        this.logger.info('opened connection');
      }
    });

    this.sock.ev.on('messages.upsert', async (m: { messages: proto.IWebMessageInfo[], type: MessageUpsertType }) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.message || !msg.key) continue;

          // Ignore protocol messages which often carry delivery/seen statuses
          if (msg.message.protocolMessage) continue;

          const text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message.buttonsResponseMessage?.selectedButtonId || 
                       '';
          
          const sender = msg.key.remoteJid || '';
          const isGroup = sender.endsWith('@g.us');
          const isFromMe = msg.key.fromMe;
          
          // Determine message direction and chat type
          const direction = isFromMe ? 'Outbound' : 'Incoming';
          const chatType = isGroup ? 'Group' : 'DM';

          // We only care about logging actual messages (not empty state updates)
          if (text || msg.message.imageMessage || msg.message.videoMessage || msg.message.audioMessage || msg.message.documentMessage) {
             const logPayload = {
               direction,
               chatType,
               remoteJid: sender,
               participant: msg.key.participant || sender,
               text: text || '<Media>'
             };
             this.logger.info(logPayload, `[${direction} ${chatType}] Message Event`);
          }

          // Continue original logic: only process incoming messages
          if (!isFromMe) {
            const groupID = isGroup ? sender : undefined;
            const isMentioned = text.includes(this.mentionKeyword);

            const inboundMsg: InboundMessage = {
              sender: msg.key.participant || sender,
              groupID: groupID || '', // Ensure it's a string if expected, or allow undefined in interface
              text,
              isMentioned,
              timestamp: Number(msg.messageTimestamp)
            };

            this.emitMessage(inboundMsg);
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
    }
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (this.sock) {
      await this.sock.sendMessage(to, { text });
    }
  }
}
