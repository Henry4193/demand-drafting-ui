// Filevine API access — token cache + fetch helper.
// Ported from the proven pattern in chase-ui/server.js (getFilevineToken / fvHeaders).
// Personal-access-token grant against identity.filevine.com, token cached in memory
// with a 60s early-refresh buffer. Never fetches a fresh token per request.

const TOKEN_URL = 'https://identity.filevine.com/connect/token';
const SCOPE =
  'fv.api.gateway.access tenant filevine.v2.api.* openid email fv.auth.tenant.read';

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const pat = process.env.FV_PAT;
  const clientId = process.env.FV_CLIENT_ID;
  const secret = process.env.FV_CLIENT_SECRET;
  if (!pat || !clientId || !secret) {
    throw new Error('Filevine env vars missing (FV_PAT, FV_CLIENT_ID, FV_CLIENT_SECRET)');
  }

  const body = new URLSearchParams({
    token: pat,
    grant_type: 'personal_access_token',
    scope: SCOPE,
    client_id: clientId,
    client_secret: secret,
  }).toString();

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    // Do not log the response body — it can echo credentials.
    throw new Error(`Filevine token request failed: ${r.status}`);
  }
  const data = await r.json();
  tokenCache = {
    token: data.access_token,
    // Refresh 60s before the stated expiry.
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 1800) - 60) * 1000,
  };
  return tokenCache.token;
}

function clearToken() {
  tokenCache = { token: null, expiresAt: 0 };
}

function fvHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'x-fv-orgid': process.env.FV_ORG_ID,
    'x-fv-userid': process.env.FV_USER_ID,
    'Content-Type': 'application/json',
  };
}

// Fetch against the Filevine API base. Retries once on 401 after clearing the
// token cache (tokens can be revoked server-side before their stated expiry).
async function fvFetch(apiPath, opts = {}) {
  const base = process.env.FV_API_BASE || 'https://api.filevineapp.com';
  const url = apiPath.startsWith('http') ? apiPath : base + apiPath;

  let token = await getToken();
  let r = await fetch(url, { ...opts, headers: { ...fvHeaders(token), ...(opts.headers || {}) } });

  if (r.status === 401) {
    clearToken();
    token = await getToken();
    r = await fetch(url, { ...opts, headers: { ...fvHeaders(token), ...(opts.headers || {}) } });
  }
  return r;
}

module.exports = { getToken, clearToken, fvFetch };
