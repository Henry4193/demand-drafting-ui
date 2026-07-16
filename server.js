require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const { fvFetch } = require('./lib/filevine');
const { extractText } = require('./lib/extract');
const { buildMessages } = require('./lib/prompt');
const monitor = require('./lib/monitor');
const cmMonitor = require('./lib/cm-monitor');

// ---------------------------------------------------------------------------
// Step 5 — startup checks (fail fast). Never proceed without a full config,
// and NEVER fall back to any Anthropic key other than this project's own env.
// ---------------------------------------------------------------------------
const REQUIRED = [
  'FV_PAT', 'FV_CLIENT_ID', 'FV_CLIENT_SECRET', 'FV_ORG_ID', 'FV_USER_ID',
  'ANTHROPIC_API_KEY', 'APP_USERNAME', 'APP_PASSWORD', 'SESSION_SECRET',
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('FATAL: missing required environment variable(s): ' + missing.join(', '));
  console.error('Refusing to start. See .env.example. Do NOT substitute a non-BAA Anthropic key.');
  process.exit(1);
}

// Standing reminder: the Anthropic (2026-07-13) and Filevine (2026-07-14) BAAs are
// signed, so real PHI is permitted — but ONLY through the dedicated BAA-track key.
// This process must run that key, never a non-BAA (chase-ui/webhook) key.
console.log('[baa] Anthropic + Filevine BAAs signed — real PHI permitted via the BAA-track key ONLY. Verify ANTHROPIC_API_KEY is the BAA/LIT-console key.');

// ---------------------------------------------------------------------------
// Inbox monitor — dormant unless MONITOR_ENABLED === 'true'. When enabled, its
// connection vars are required (fail fast, same posture as the core config).
// The banner makes the running mode auditable from the deploy logs.
// ---------------------------------------------------------------------------
const MONITOR_ENABLED = process.env.MONITOR_ENABLED === 'true';
if (MONITOR_ENABLED) {
  const MONITOR_REQUIRED = [
    'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID',
    'LIT_ATTORNEY_EMAILS', 'MONITOR_SENDER',
  ];
  const monMissing = MONITOR_REQUIRED.filter((k) => !process.env[k]);
  if (monMissing.length) {
    console.error('FATAL: MONITOR_ENABLED=true but missing: ' + monMissing.join(', '));
    console.error('Refusing to start. Unset MONITOR_ENABLED to run without the monitor.');
    process.exit(1);
  }
}
console.log(`[monitor] ${monitor.modeString()}`);

// ---------------------------------------------------------------------------
// CM Action Router — dormant unless CM_MONITOR_ENABLED === 'true'. Requires only
// what's needed to READ the inbox (so dry-run calibration can run before Teams is
// configured); CM_TEAMS_CHAT_ID is checked at post time, not startup.
// ---------------------------------------------------------------------------
const CM_MONITOR_ENABLED = process.env.CM_MONITOR_ENABLED === 'true';
if (CM_MONITOR_ENABLED) {
  const CM_REQUIRED = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'CM_MONITOR_MAILBOX'];
  const cmMissing = CM_REQUIRED.filter((k) => !process.env[k]);
  if (cmMissing.length) {
    console.error('FATAL: CM_MONITOR_ENABLED=true but missing: ' + cmMissing.join(', '));
    console.error('Refusing to start. Unset CM_MONITOR_ENABLED to run without the CM monitor.');
    process.exit(1);
  }
}
console.log(`[cm-monitor] ${cmMonitor.modeString()}`);

const IS_PROD = !!(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT);
const PORT = process.env.PORT || 3100;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Step 6 — security middleware
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  // Enforce HTTPS in production (Railway terminates TLS and sets x-forwarded-proto).
  if (IS_PROD && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  // PHI must never land in browser/proxy caches.
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 60 * 1000, // 30 minutes
  },
}));

// ---------------------------------------------------------------------------
// Step 7 — login gate
// ---------------------------------------------------------------------------
const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const LOCK_THRESHOLD = 10;
const LOCK_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rec = failedAttempts.get(ip);
  if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const { username, password } = req.body || {};
  const ok =
    typeof username === 'string' && typeof password === 'string' &&
    safeEqual(username, process.env.APP_USERNAME) &&
    safeEqual(password, process.env.APP_PASSWORD);

  if (!ok) {
    const next = rec ? { count: rec.count + 1 } : { count: 1 };
    if (next.count >= LOCK_THRESHOLD) next.lockedUntil = Date.now() + LOCK_MS;
    failedAttempts.set(ip, next);
    console.log(`[login] fail ip-hash=${ipHash(ip)} count=${next.count}`);
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  failedAttempts.delete(ip);
  req.session.authed = true;
  console.log('[login] ok');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed), baaPending: true });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'auth required' });
}

function ipHash(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Step 8 — case lookup routes (Filevine)
//
// Filevine's /projects endpoint does NOT support server-side name search — the
// search/projectName/q params are all ignored (verified against the live API).
// So we build an in-memory index of lightweight project records once, cache it,
// and filter against that. This paginates through ALL projects of the litigation
// type (matching chase-ui's proven pattern) so older cases are findable, while
// keeping API load to at most one full scan per INDEX_TTL.
// ---------------------------------------------------------------------------
const INDEX_TTL = 5 * 60 * 1000; // rebuild the project index at most every 5 min
const PAGE_SIZE = 200;
const MAX_PAGES = 200; // safety cap (200 * 200 = 40k projects)

let projectIndex = { at: 0, items: [] };
let indexBuilding = null; // in-flight promise, so concurrent searches share one scan

async function buildProjectIndex() {
  const ptid = process.env.FV_PROJ_TYPE_ID;
  const all = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Sequential paging (not parallel) — respects Filevine rate limits.
    const r = await fvFetch(`/fv-app/v2/projects?projectTypeId=${ptid}&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!r.ok) throw new Error(`filevine status ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    for (const p of items) {
      if (p.isArchived) continue;
      all.push({
        projectId: p.projectId?.native ?? p.projectId ?? p.id,
        name: p.projectOrClientName || p.projectName || p.clientName || '(unnamed)',
        phaseName: p.phaseName || p.phase || null,
      });
    }
    if (!data.hasMore || items.length === 0) break;
    offset += PAGE_SIZE;
  }
  projectIndex = { at: Date.now(), items: all };
  console.log(`[cases/index] rebuilt count=${all.length}`);
  return projectIndex;
}

async function getProjectIndex() {
  if (projectIndex.items.length && Date.now() - projectIndex.at < INDEX_TTL) {
    return projectIndex;
  }
  if (!indexBuilding) {
    indexBuilding = buildProjectIndex().finally(() => { indexBuilding = null; });
  }
  return indexBuilding;
}

app.get('/api/cases/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const idx = await getProjectIndex();
    const ql = q.toLowerCase();
    const results = idx.items
      .filter((p) => p.name.toLowerCase().includes(ql) || String(p.projectId).includes(q))
      .slice(0, 25);
    res.json(results);
  } catch (e) {
    console.log(`[cases/search] error type=${e.name}`);
    res.status(502).json({ error: 'Case lookup failed' });
  }
});

app.get('/api/cases/:projectId', requireAuth, async (req, res) => {
  const projectId = String(req.params.projectId).replace(/[^0-9]/g, '');
  if (!projectId) return res.status(400).json({ error: 'bad project id' });
  try {
    const r = await fvFetch(`/fv-app/v2/projects/${projectId}`);
    if (!r.ok) {
      console.log(`[cases/get] project=${projectId} filevine status=${r.status}`);
      return res.status(502).json({ error: 'Case lookup failed' });
    }
    const p = await r.json();
    res.json({
      projectId,
      name: p.projectOrClientName || p.projectName || p.clientName || null,
      phaseName: p.phaseName || p.phase || null,
      incidentDate: p.incidentDate || p.dateOfLoss || null,
      projectTypeName: p.projectTypeName || null,
    });
  } catch (e) {
    console.log(`[cases/get] project=${projectId} error type=${e.name}`);
    res.status(502).json({ error: 'Case lookup failed' });
  }
});

// ---------------------------------------------------------------------------
// Step 11 — generate route
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(), // never write PHI to disk
  limits: { fileSize: 25 * 1024 * 1024, files: 13 },
});

const uploadFields = upload.fields([
  { name: 'caseDocs', maxCount: 10 },
  { name: 'priorDemands', maxCount: 3 },
]);

app.post('/api/generate', requireAuth, (req, res) => {
  uploadFields(req, res, async (uErr) => {
    if (uErr) {
      const msg = uErr.code === 'LIMIT_FILE_SIZE'
        ? 'A file exceeds the 25 MB limit.'
        : 'Upload rejected: ' + (uErr.message || 'invalid upload');
      return res.status(400).json({ error: msg });
    }

    const started = Date.now();
    let caseDocs = (req.files?.caseDocs) || [];
    let priorDemands = (req.files?.priorDemands) || [];
    const customPrompt = String(req.body?.customPrompt || '').trim();
    const projectId = String(req.body?.projectId || '').replace(/[^0-9]/g, '') || null;

    if (!customPrompt) return res.status(400).json({ error: 'Custom prompt is required.' });
    if (caseDocs.length === 0) return res.status(400).json({ error: 'Attach at least one case document.' });

    try {
      // 1. Optional case metadata.
      let caseMeta = null;
      if (projectId) {
        const r = await fvFetch(`/fv-app/v2/projects/${projectId}`);
        if (r.ok) {
          const p = await r.json();
          caseMeta = {
            projectId,
            name: p.projectOrClientName || p.projectName || p.clientName || null,
            phaseName: p.phaseName || p.phase || null,
            incidentDate: p.incidentDate || p.dateOfLoss || null,
          };
        }
      }

      // 2. Extract text (local CPU work).
      const scannedWarnings = [];
      const extract = async (f) => {
        const { text, scannedLikely } = await extractText(f);
        if (scannedLikely) scannedWarnings.push(f.originalname);
        return { name: f.originalname, text };
      };
      const docTexts = await Promise.all(caseDocs.map(extract));
      const priorTexts = await Promise.all(priorDemands.map(extract));

      // 3. Build messages + call Claude.
      const { system, messages, truncated, truncationNote } = buildMessages({
        caseMeta,
        caseDocs: docTexts,
        priorDemands: priorTexts,
        customPrompt,
      });

      const inBytes = messages[0].content.length;
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system,
        messages,
      });
      const demand = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      console.log(
        `[generate] project=${projectId || '-'} docs=${caseDocs.length} priors=${priorDemands.length} ` +
        `in=${Math.round(inBytes / 1024)}kB out=${Math.round(demand.length / 1024)}kB ` +
        `${Math.round((Date.now() - started) / 1000)}s ok`
      );

      res.json({ demand, truncated, truncationNote, scannedWarnings });
    } catch (e) {
      // Never echo document content or case names.
      // Honor a 400 from text extraction (unsupported file type — message is
      // safe, contains only the extension).
      if (e.status === 400) {
        console.log(`[generate] project=${projectId || '-'} rejected=bad-file`);
        return res.status(400).json({ error: e.message });
      }
      // Anthropic wraps the real reason in a nested error object.
      const anthropicType = e?.error?.error?.type || e?.error?.type || e?.type;
      console.log(`[generate] project=${projectId || '-'} error name=${e.name}${anthropicType ? ' anthropic=' + anthropicType : ''}`);
      res.status(502).json({ error: 'Generation failed' + (anthropicType ? ` (${anthropicType})` : '') });
    } finally {
      // Drop references to PHI-bearing buffers/text promptly.
      caseDocs = null;
      priorDemands = null;
      if (req.files) req.files = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox monitor endpoints (all authed + no-store). Every one honors the master
// gate: a dormant agent (MONITOR_ENABLED off) cannot be woken by a manual call.
// ---------------------------------------------------------------------------
function requireMonitor(req, res, next) {
  if (!MONITOR_ENABLED) return res.status(409).json({ error: 'monitor disabled' });
  return next();
}

app.post('/api/monitor/sync', requireAuth, requireMonitor, (req, res) => {
  monitor.syncNow();
  res.json({ ok: true, message: 'monitor sync started' });
});

app.get('/api/monitor/status', requireAuth, (req, res) => {
  // Always safe to call; when dormant it reports enabled:false with zero counters.
  res.json(monitor.getStatus());
});

app.get('/api/monitor/debug', requireAuth, requireMonitor, async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email query param required' });
  try {
    res.json(await monitor.debugMailbox(email));
  } catch (e) {
    console.log(`[monitor/debug] error name=${e.name}`);
    res.status(502).json({ error: 'debug fetch failed' });
  }
});

// ---------------------------------------------------------------------------
// CM Action Router endpoints (authed + no-store). Same posture as the inbox
// monitor: a dormant agent (CM_MONITOR_ENABLED off) can't be woken by a call.
// ---------------------------------------------------------------------------
function requireCmMonitor(req, res, next) {
  if (!CM_MONITOR_ENABLED) return res.status(409).json({ error: 'cm monitor disabled' });
  return next();
}

app.post('/api/cm-monitor/sync', requireAuth, requireCmMonitor, (req, res) => {
  cmMonitor.syncNow();
  res.json({ ok: true, message: 'cm monitor sync started' });
});

app.get('/api/cm-monitor/status', requireAuth, (req, res) => {
  res.json(cmMonitor.getStatus());
});

// Calibration: routing chain on real mail. ?classify=1 also runs the Claude
// classifier per email (obeys the dry-run / BAA_SIGNED gate). No Teams posts either way.
app.get('/api/cm-monitor/debug', requireAuth, requireCmMonitor, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const classify = req.query.classify === '1' || req.query.classify === 'true';
    res.json(await cmMonitor.debugRoute(limit, classify));
  } catch (e) {
    console.log(`[cm-monitor/debug] error name=${e.name}`);
    res.status(502).json({ error: 'debug fetch failed' });
  }
});

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[server] demand-drafting-ui listening on :${PORT} (prod=${IS_PROD})`);
  monitor.start(); // no-op unless MONITOR_ENABLED === 'true'
  cmMonitor.start(); // no-op unless CM_MONITOR_ENABLED === 'true'
});
