import 'dotenv/config';
import fs from 'fs';
import makeWASocket, { useMultiFileAuthState, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';

// One-shot CLI: connect to WhatsApp using the existing auth, fetch group
// metadata for each JID passed on argv, dump JSON to stdout, exit.
// Conflicts with a running `npm start` (Baileys allows one connection per
// auth state), so stop the bot before invoking.

async function main() {
  const groupJids = process.argv.slice(2);
  if (groupJids.length === 0) {
    console.error('Usage: node --loader ts-node/esm src/cli/list-members.ts <groupJid> [<groupJid>...]');
    process.exit(2);
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestWaWebVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger as any,
    browser: ['BeyondChats-CLI', 'BeyondChats', '1.0.0'],
    markOnlineOnConnect: false,
  });
  sock.ev.on('creds.update', saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open') {
        try {
          const result: Record<string, { subject: string; participants: { id: string; admin: string | null }[] }> = {};
          for (const jid of groupJids) {
            const meta = await sock.groupMetadata(jid);
            result[jid] = {
              subject: meta.subject || '',
              participants: meta.participants.map(p => ({ id: p.id, admin: p.admin || null }))
            };
          }
          process.stdout.write('===GROUP_METADATA_START===\n');
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          process.stdout.write('===GROUP_METADATA_END===\n');
          // Optional: also dump to a file for easy programmatic consumption.
          fs.mkdirSync('data', { recursive: true });
          fs.writeFileSync('data/discovery.json', JSON.stringify(result, null, 2));
          await sock.end(undefined);
          resolve();
        } catch (err) {
          reject(err);
        }
      } else if (update.connection === 'close') {
        const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
        if (code === 401) reject(new Error('WhatsApp auth invalid (401). Re-link via npm start.'));
      }
    });
  });

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'list-members failed');
  process.exit(1);
});
