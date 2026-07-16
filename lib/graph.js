// Microsoft Graph API access — token cache + fetch helpers for the inbox monitor.
// Client-credentials (application) grant against login.microsoftonline.com, token
// cached in memory with a 60s early-refresh buffer, mirroring lib/filevine.js.
// Reuses the existing "Chase list bot" app registration (MS_CLIENT_ID/SECRET/TENANT_ID).
//
// PHI note: this module fetches mailbox content into memory only. Callers must not
// persist message bodies/subjects/names to disk (see lib/state.js).

const fs = require('fs');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let tokenCache = { token: null, expiresAt: 0 };

async function getGraphToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const clientId = process.env.MS_CLIENT_ID;
  const secret = process.env.MS_CLIENT_SECRET;
  const tenant = process.env.MS_TENANT_ID;
  if (!clientId || !secret || !tenant) {
    throw new Error('Graph env vars missing (MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID)');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    // Do not log the response body — it can echo credentials.
    throw new Error(`Graph token request failed: ${r.status}`);
  }
  const data = await r.json();
  tokenCache = {
    token: data.access_token,
    // Refresh 60s before the stated expiry.
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
  return tokenCache.token;
}

function clearToken() {
  tokenCache = { token: null, expiresAt: 0 };
}

// Fetch against the Graph API base. Handles the two failure modes the inbox
// monitor cares about: 404/403 (mailbox not found / app has no access) → null so
// callers can skip that mailbox, and 429 (throttled) → wait Retry-After then retry.
// Ported from chase-ui's mailCount() pattern.
async function graphFetch(apiPath, opts = {}) {
  const url = apiPath.startsWith('http') ? apiPath : GRAPH_BASE + apiPath;
  const token = opts.token || (await getGraphToken());
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const r = await fetch(url, { ...opts, headers });

  if (r.status === 404 || r.status === 403) return null;
  if (r.status === 429) {
    const wait = (parseInt(r.headers.get('Retry-After') || '15', 10) + 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return graphFetch(apiPath, opts);
  }
  return r;
}

// Message fields we read. Bodies/subjects are PHI and stay in memory only.
const MSG_SELECT = [
  'id', 'conversationId', 'subject', 'from', 'toRecipients',
  'receivedDateTime', 'sentDateTime', 'bodyPreview', 'body', 'webLink',
].join(',');

// Fetch messages from a mailbox folder received/sent on or after sinceISO.
// folder is a well-known folder name ('inbox' | 'sentitems'). Pages through
// @odata.nextLink. Returns [] on no-access (graphFetch → null).
async function fetchMessages(token, email, folder, sinceISO) {
  const filterField = folder === 'sentitems' ? 'sentDateTime' : 'receivedDateTime';
  const filter = encodeURIComponent(`${filterField} ge ${sinceISO}`);
  let url =
    `${GRAPH_BASE}/users/${encodeURIComponent(email)}/mailFolders/${folder}/messages` +
    `?$filter=${filter}&$select=${MSG_SELECT}&$orderby=${filterField}%20desc&$top=50`;

  const out = [];
  while (url) {
    const r = await graphFetch(url, { token });
    if (!r) return out; // 404/403 — no access to this mailbox; skip.
    if (!r.ok) break;
    const data = await r.json();
    if (Array.isArray(data.value)) out.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

// Send an HTML email as `sender` (application permission Mail.Send). Used for the
// daily digest. Content is PHI but stays in-tenant (Microsoft BAA).
async function sendMail(token, sender, toAddr, subject, html) {
  const r = await graphFetch(`/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    token,
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: toAddr } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!r || !r.ok) {
    throw new Error(`sendMail failed: ${r ? r.status : 'no-access'}`);
  }
}

// ---------------------------------------------------------------------------
// Delegated (signed-in user) token — required for Teams chat posting, which
// Microsoft does NOT allow app-only (403 without Teamwork.Migrate.All, which is
// migration-only). Mirrors the Admin scripts' refresh-token flow exactly: same
// "Chase list bot" registration, same token cache file (Admin\.graph_token),
// PUBLIC-client refresh body (no secret), and the full token response written
// back so the rotated refresh_token is kept. Posts appear AS the signed-in user
// (Henry). If the refresh token is expired/revoked we throw with instructions —
// the interactive device-code re-auth lives in the Admin scripts, not here.
// ---------------------------------------------------------------------------
const DELEGATED_SCOPE = 'https://graph.microsoft.com/ChatMessage.Send Files.ReadWrite offline_access';
const DELEGATED_TOKEN_FILE = process.env.MS_DELEGATED_TOKEN_FILE ||
  'C:\\Users\\Henry Knotts\\Desktop\\Client Relations\\Admin\\.graph_token';

let delegatedCache = { token: null, expiresAt: 0 };

async function getDelegatedToken() {
  if (delegatedCache.token && Date.now() < delegatedCache.expiresAt) return delegatedCache.token;

  // First-boot seed (Railway): if the token file doesn't exist yet but a seed is
  // provided (base64 of the local .graph_token), write it once. Rotation then
  // maintains the file on the persistent volume; the seed env can be removed.
  if (!fs.existsSync(DELEGATED_TOKEN_FILE) && process.env.MS_DELEGATED_TOKEN_SEED) {
    try {
      fs.writeFileSync(DELEGATED_TOKEN_FILE,
        Buffer.from(process.env.MS_DELEGATED_TOKEN_SEED, 'base64').toString('utf8'));
      console.log('[graph] delegated token file seeded from MS_DELEGATED_TOKEN_SEED');
    } catch (e) {
      console.log(`[graph] token seed write failed name=${e.name}`);
    }
  }

  let saved;
  try {
    // Strip the BOM — the PS scripts write this file with Out-File -Encoding utf8,
    // which prepends U+FEFF, and JSON.parse rejects it.
    saved = JSON.parse(fs.readFileSync(DELEGATED_TOKEN_FILE, 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    throw new Error(
      `delegated token file missing/unreadable — sign in once via an Admin script (e.g. generate_chase_list.ps1), or set MS_DELEGATED_TOKEN_FILE`,
    );
  }
  if (!saved.refresh_token) {
    throw new Error('delegated token file has no refresh_token — re-auth via an Admin script');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.MS_CLIENT_ID,
    refresh_token: saved.refresh_token,
    scope: DELEGATED_SCOPE,
  }).toString();

  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    // Read only the error code — never log the full body.
    let code = '';
    try { code = (await r.json()).error || ''; } catch (_) { /* ignore */ }
    throw new Error(`delegated token refresh failed: ${r.status} ${code} — if invalid_grant, re-auth via an Admin script`);
  }
  const data = await r.json();
  // Persist the FULL response (rotated refresh_token included), like the PS flow.
  try {
    const tmp = DELEGATED_TOKEN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DELEGATED_TOKEN_FILE);
  } catch (_) { /* best-effort — keep going with the in-memory token */ }
  delegatedCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
  return delegatedCache.token;
}

// Resolve an email/UPN to its AAD user id (+ display name), for @mention targets.
// Needs User.Read.All (application). Returns null if the user isn't found.
async function resolveUserId(token, email) {
  const r = await graphFetch(
    `/users/${encodeURIComponent(email)}?$select=id,displayName`,
    { token },
  );
  if (!r || !r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, displayName: u.displayName || email } : null;
}

// Post an HTML message to a Teams chat by thread id, AS the signed-in user via
// the DELEGATED token (app-only chat posting is not permitted by Graph — verified
// 403 requiring migration-only Teamwork.Migrate.All). `mentions` is an optional
// array of { id, mentionText, mentioned: { user: { id, displayName,
// userIdentityType } } }; the html must reference each with <at id="N">Name</at>.
// PHI in the body stays in-tenant (Microsoft BAA). Throws on failure (with the
// real status) so callers can log + not mark posted.
async function postChatMessage(chatId, html, mentions = []) {
  const token = await getDelegatedToken();
  const r = await fetch(`${GRAPH_BASE}/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: { contentType: 'html', content: html },
      ...(mentions.length ? { mentions } : {}),
    }),
  });
  if (!r.ok) {
    let code = '';
    try { code = (await r.json())?.error?.code || ''; } catch (_) { /* ignore */ }
    throw new Error(`postChatMessage failed: ${r.status} ${code}`);
  }
  return r.json();
}

module.exports = {
  getGraphToken, clearToken, graphFetch, fetchMessages, sendMail,
  resolveUserId, getDelegatedToken, postChatMessage, GRAPH_BASE,
};
