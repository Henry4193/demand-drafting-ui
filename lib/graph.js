// Microsoft Graph API access — token cache + fetch helpers for the inbox monitor.
// Client-credentials (application) grant against login.microsoftonline.com, token
// cached in memory with a 60s early-refresh buffer, mirroring lib/filevine.js.
// Reuses the existing "Chase list bot" app registration (MS_CLIENT_ID/SECRET/TENANT_ID).
//
// PHI note: this module fetches mailbox content into memory only. Callers must not
// persist message bodies/subjects/names to disk (see lib/state.js).

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

module.exports = { getGraphToken, clearToken, graphFetch, fetchMessages, sendMail, GRAPH_BASE };
