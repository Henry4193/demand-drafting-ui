// Diagnostic: verify the DELEGATED-token Teams posting path (posts as the
// signed-in user). Default: token-refresh check ONLY (no message sent).
// Pass --post to actually send a plain + @mention test message to the chat.
// No PHI — test text only. Run:  node scripts/teams-post-check.js [--post]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const graph = require('../lib/graph');

(async () => {
  const chatId = process.env.CM_TEAMS_CHAT_ID;
  const mailbox = process.env.CM_MONITOR_MAILBOX;
  if (!chatId) { console.log('CM_TEAMS_CHAT_ID not set'); process.exit(1); }

  let token;
  try {
    token = await graph.getDelegatedToken();
    console.log('delegated token refresh: OK (posting will appear as the signed-in user)');
  } catch (e) {
    console.log(`delegated token refresh: FAILED — ${e.message}`);
    process.exit(1);
  }
  if (!process.argv.includes('--post')) {
    console.log('token-only check done. Re-run with --post to send the actual test messages.');
    return;
  }
  const url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`;

  async function tryPost(label, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let detail = '';
    try {
      const j = await r.json();
      detail = j?.error ? `${j.error.code}: ${String(j.error.message).slice(0, 160)}` : 'ok';
    } catch (_) { detail = '(no body)'; }
    console.log(`${label}: status=${r.status} ${detail}`);
    return r.status;
  }

  // Test 1 — plain text post
  await tryPost('plain post   ', {
    body: { contentType: 'html', content: 'CM Action Router — connectivity test (ignore)' },
  });

  // Test 2 — post with @mention (resolve via the APP token, like production does)
  const who = mailbox ? await graph.resolveUserId(await graph.getGraphToken(), mailbox) : null;
  if (!who) { console.log('mention post : skipped (could not resolve user)'); return; }
  await tryPost('mention post ', {
    body: { contentType: 'html', content: `CM Action Router — mention test <at id="0">${who.displayName}</at> (ignore)` },
    mentions: [{ id: 0, mentionText: who.displayName,
      mentioned: { user: { id: who.id, displayName: who.displayName, userIdentityType: 'aadUser' } } }],
  });
})().catch((e) => console.log(`setup error: ${e.name}: ${String(e.message).slice(0, 200)}`));
