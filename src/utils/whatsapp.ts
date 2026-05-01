// Baileys requires both `mentions: ['<jid>']` AND the message text to literally
// contain `@<digits>` for the mentioned recipient to receive a notification.
// Always use this helper — formatting one without the other silently no-ops the
// notification.

export interface FormattedMention {
  text: string;
  mentions: string[];
}

export function jidToHandle(jid: string): string {
  // '9198xxxxxxxx@s.whatsapp.net' -> '@9198xxxxxxxx'
  return '@' + jid.split('@')[0];
}

// Replace `{0}`, `{1}`, ... in `template` with the @<digits> handle for each
// JID in `jids` (positional). Returns the substituted text plus the JIDs as
// the mentions array Baileys expects.
export function formatMentionText(template: string, jids: string[]): FormattedMention {
  const text = template.replace(/\{(\d+)\}/g, (match, idx) => {
    const i = Number(idx);
    if (jids[i] === undefined) return match;
    return jidToHandle(jids[i]);
  });
  return { text, mentions: jids };
}
