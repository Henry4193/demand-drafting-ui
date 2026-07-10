// Litigation inbox monitoring agent.
//
// Scans litigation attorneys' Outlook mailboxes via Microsoft Graph, classifies
// mail with Claude (on this app's BAA-track key), and surfaces:
//   - deadlines mentioned in incoming mail
//   - formal servings received that we must respond to
//   - demands/servings WE sent that a third party hasn't replied to
// Urgent items go to Teams (Incoming Webhook); a daily digest emails each attorney.
//
// SAFETY: nothing here runs unless server.js calls start()/syncNow(), which only
// happens when MONITOR_ENABLED === 'true'. Email BODIES are sent to Claude only
// when BAA_SIGNED === 'true' and not in dry-run. All PHI (subjects, names, bodies)
// stays in memory (agentState) or in-tenant (Graph/Outlook/Teams) — never on disk.
// Only PHI-free keys are persisted, via lib/state.js.

const Anthropic = require('@anthropic-ai/sdk');
const graph = require('./graph');
const stateLib = require('./state');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// -- config (read from env at call time so a restart picks up flag changes) ----
function config() {
  const emails = String(process.env.LIT_ATTORNEY_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const domain =
    process.env.MONITOR_INTERNAL_DOMAIN ||
    (emails[0] && emails[0].includes('@') ? emails[0].split('@')[1].toLowerCase() : null);
  return {
    enabled: process.env.MONITOR_ENABLED === 'true',
    dryRun: process.env.MONITOR_DRY_RUN === 'true',
    baaSigned: process.env.BAA_SIGNED === 'true',
    attorneys: emails.map((email) => ({ email, key: email.split('@')[0].toLowerCase() })),
    internalDomain: domain,
    sender: process.env.MONITOR_SENDER || null,
    lookbackDays: intEnv('MONITOR_LOOKBACK_DAYS', 45),
    deadlineWarnDays: intEnv('MONITOR_DEADLINE_WARN_DAYS', 3),
    demandOverdueDays: intEnv('MONITOR_DEMAND_OVERDUE_DAYS', 14),
    digestHour: intEnv('MONITOR_DIGEST_HOUR', 8),
  };
}

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : dflt;
}

// -- in-memory picture (may contain PHI; never persisted) ----------------------
const agentState = {
  status: 'never_run', // never_run | syncing | ok | partial | error
  lastSyncAt: null,
  lastError: null,
  counters: { graphCallsMade: 0, claudeCallsMade: 0, alertsSent: 0 },
  byAttorney: {}, // key -> { email, deadlines:[], servingsNeedingResponse:[], demandsAwaiting:[] }
};

let anthropic = null;
function client() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

let syncing = false;

// -- date helpers (ET, for the digest schedule) --------------------------------
function etNow() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const hour = Number(now.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit',
  })) % 24;
  return { date, hour };
}
function daysFromNow(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - Date.now()) / 86400000);
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

// -- classification ------------------------------------------------------------
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

function isSkippable(msg, cfg, direction) {
  const subj = String(msg.subject || '').toLowerCase();
  if (/^(automatic reply|out of office|undeliverable|delivery has failed)/.test(subj)) return true;
  if (direction === 'inbound' && cfg.internalDomain) {
    const from = msg.from?.emailAddress?.address?.toLowerCase() || '';
    // Internal-only chatter is not a third-party serving; skip to save cost + PHI.
    if (from.endsWith('@' + cfg.internalDomain)) return true;
  }
  return false;
}

const INBOUND_SYSTEM =
  'You are a litigation paralegal triaging an attorney\'s INCOMING email. ' +
  'Classify the single email. Respond with ONLY a JSON object — no markdown, no prose. ' +
  'Schema: {"type": "serving_received"|"deadline"|"demand_reply"|"irrelevant", ' +
  '"dueDate": "YYYY-MM-DD" or null, "matter": string or null, "counterparty": string or null}. ' +
  'serving_received = we were formally served (complaint, summons, motion, discovery request) and must respond by a deadline. ' +
  'deadline = the email states or implies a response/answer/discovery due date. ' +
  'demand_reply = a reply to a demand/serving WE sent (insurer or opposing counsel responding). ' +
  'irrelevant = anything else. dueDate = the response deadline if any, else null.';

const OUTBOUND_SYSTEM =
  'You are a litigation paralegal triaging an attorney\'s SENT email. ' +
  'Respond with ONLY a JSON object — no markdown, no prose. ' +
  'Schema: {"type": "demand_sent"|"serving_sent"|"other", "matter": string or null, ' +
  '"counterparty": string or null, "expectedReplyDays": integer or null}. ' +
  'demand_sent = a demand letter or settlement demand we sent expecting a response. ' +
  'serving_sent = we formally served process or sent discovery expecting a response. ' +
  'other = anything else. expectedReplyDays = typical days to expect a reply (e.g. 30), else null.';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fall through */ } }
    return null;
  }
}

// Classify one message. Returns the classification object, or null when Claude
// is intentionally not called (dry-run / BAA not signed). Caches successful
// results in state.classifiedIds so bodies are sent to Claude at most once.
async function classifyMessage(msg, direction, cfg, state) {
  const cached = state.classifiedIds[msg.id];
  if (cached) return cached;
  if (isSkippable(msg, cfg, direction)) {
    const res = { type: 'irrelevant', dueDate: null };
    state.classifiedIds[msg.id] = res;
    return res;
  }
  // Gate: bodies (PHI) go to Claude only when explicitly BAA-signed and live.
  if (cfg.dryRun || !cfg.baaSigned) return null;

  const bodyText = stripHtml(msg.body?.content || msg.bodyPreview || '');
  const userContent = `Subject: ${msg.subject || '(no subject)'}\n\n${bodyText}`;
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    system: direction === 'inbound' ? INBOUND_SYSTEM : OUTBOUND_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });
  agentState.counters.claudeCallsMade += 1;
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJson(text);
  if (!parsed || typeof parsed.type !== 'string') {
    // Don't cache a parse failure — allow a retry on a later sync.
    return { type: 'irrelevant', dueDate: null };
  }
  // Persist only PHI-free fields (type + dueDate). matter/counterparty stay in memory.
  state.classifiedIds[msg.id] = { type: parsed.type, dueDate: parsed.dueDate || null };
  return parsed;
}

// -- per-mailbox processing ----------------------------------------------------
async function processAttorney(token, attorney, cfg, state) {
  const sinceISO = new Date(Date.now() - cfg.lookbackDays * 86400000).toISOString();
  const bucket = { email: attorney.email, deadlines: [], servingsNeedingResponse: [], demandsAwaiting: [] };

  const inbox = await graph.fetchMessages(token, attorney.email, 'inbox', sinceISO);
  agentState.counters.graphCallsMade += 1;
  const sent = await graph.fetchMessages(token, attorney.email, 'sentitems', sinceISO);
  agentState.counters.graphCallsMade += 1;

  // Latest inbound reply time per conversation — used to detect "no reply yet".
  const latestInboundByConv = {};
  for (const m of inbox) {
    const c = m.conversationId;
    const t = new Date(m.receivedDateTime || 0).getTime();
    if (!c) continue;
    if (!latestInboundByConv[c] || t > latestInboundByConv[c]) latestInboundByConv[c] = t;
  }

  // Inbound: deadlines + servings needing our response.
  for (const m of inbox) {
    const cls = await classifyMessage(m, 'inbound', cfg, state);
    if (!cls || cls.type === 'irrelevant' || cls.type === 'demand_reply') continue;
    const dueDate = cls.dueDate || null;
    const item = {
      id: m.id,
      subject: m.subject || '(no subject)',
      counterparty: cls.counterparty || m.from?.emailAddress?.name || m.from?.emailAddress?.address || null,
      matter: cls.matter || null,
      receivedDate: m.receivedDateTime || null,
      dueDate,
      daysUntil: daysFromNow(dueDate),
      webLink: m.webLink || null,
      conversationId: m.conversationId || null,
    };
    if (cls.type === 'serving_received') bucket.servingsNeedingResponse.push(item);
    if (dueDate) bucket.deadlines.push(item);
  }

  // Outbound: track demands/servings we sent, flag those awaiting a reply.
  for (const m of sent) {
    const cls = await classifyMessage(m, 'outbound', cfg, state);
    if (!cls || (cls.type !== 'demand_sent' && cls.type !== 'serving_sent')) continue;
    const conv = m.conversationId;
    const sentDate = m.sentDateTime || null;
    if (conv) {
      state.trackedDemands[conv] = {
        sentDate,
        expectedReplyDays: Number.isFinite(cls.expectedReplyDays) ? cls.expectedReplyDays : null,
      };
    }
    const sentMs = new Date(sentDate || 0).getTime();
    const repliedAfter = conv && latestInboundByConv[conv] && latestInboundByConv[conv] > sentMs;
    const outstanding = daysSince(sentDate);
    if (!repliedAfter && outstanding != null && outstanding >= cfg.demandOverdueDays) {
      bucket.demandsAwaiting.push({
        id: conv || m.id,
        subject: m.subject || '(no subject)',
        counterparty: cls.counterparty || m.toRecipients?.[0]?.emailAddress?.address || null,
        matter: cls.matter || null,
        sentDate,
        daysOutstanding: outstanding,
        webLink: m.webLink || null,
        conversationId: conv || null,
      });
    }
  }

  return bucket;
}

// -- alerting ------------------------------------------------------------------
function urgentItems(cfg) {
  const out = [];
  for (const key of Object.keys(agentState.byAttorney)) {
    const b = agentState.byAttorney[key];
    for (const d of b.deadlines) {
      if (d.daysUntil != null && d.daysUntil <= cfg.deadlineWarnDays) {
        out.push({ kind: 'deadline', key, ...d });
      }
    }
    for (const s of b.servingsNeedingResponse) {
      out.push({ kind: 'serving', key, ...s });
    }
    for (const dm of b.demandsAwaiting) {
      out.push({ kind: 'demand_awaiting', key, ...dm });
    }
  }
  return out;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function urgentRow(it) {
  const link = it.webLink ? ` — <a href="${escHtml(it.webLink)}">open</a>` : '';
  if (it.kind === 'deadline') {
    return `⏰ <b>Deadline</b> — ${escHtml(it.subject)} — due ${escHtml(it.dueDate)}` +
      (it.daysUntil != null ? ` (${it.daysUntil}d)` : '') +
      (it.matter ? ` — ${escHtml(it.matter)}` : '') + link;
  }
  if (it.kind === 'serving') {
    return `📬 <b>Serving needs response</b> — ${escHtml(it.subject)}` +
      (it.counterparty ? ` — from ${escHtml(it.counterparty)}` : '') + link;
  }
  return `⌛ <b>Demand awaiting reply</b> — ${escHtml(it.subject)} — ${it.daysOutstanding}d outstanding` +
    (it.counterparty ? ` — ${escHtml(it.counterparty)}` : '') + link;
}

function urgentHtml(items) {
  return `<div style="font-family:sans-serif;color:#222"><ul>` +
    items.map((i) => `<li style="margin-bottom:8px">${urgentRow(i)}</li>`).join('') +
    `</ul></div>`;
}

// Immediate urgent alerts, emailed DIRECTLY to each individual attorney whose
// mailbox surfaced the item (not a shared channel). Deduped via alertedIds so
// each item alerts once. The daily digest (maybeSendDailyDigest) is separate.
async function pushUrgentAlerts(token, cfg, state) {
  if (cfg.dryRun || !cfg.sender) return;
  const fresh = urgentItems(cfg).filter((it) => !state.alertedIds[it.id]);
  if (!fresh.length) return;

  const byKey = {};
  for (const it of fresh) (byKey[it.key] = byKey[it.key] || []).push(it);

  const nowISO = new Date().toISOString();
  for (const key of Object.keys(byKey)) {
    const attorney = cfg.attorneys.find((a) => a.key === key);
    if (!attorney) continue;
    const items = byKey[key];
    try {
      await graph.sendMail(
        token, cfg.sender, attorney.email,
        `⏰ Urgent: ${items.length} litigation item(s) need attention`,
        urgentHtml(items),
      );
      for (const it of items) state.alertedIds[it.id] = nowISO;
      agentState.counters.alertsSent += 1;
    } catch (e) {
      console.log(`[monitor] urgent alert send failed for ${key} name=${e.name}`);
    }
  }
}

function digestHtml(bucket) {
  const section = (title, items, render) => {
    if (!items.length) return '';
    return `<h3 style="color:#00d36b;font-family:sans-serif">${title} (${items.length})</h3><ul>` +
      items.map((i) => `<li style="margin-bottom:6px">${render(i)}</li>`).join('') + '</ul>';
  };
  const esc = escHtml;
  return `<div style="font-family:sans-serif;color:#222">` +
    section('Upcoming deadlines', bucket.deadlines, (i) =>
      `<b>${esc(i.subject)}</b> — due ${esc(i.dueDate)}` +
      (i.daysUntil != null ? ` (${i.daysUntil}d)` : '') +
      (i.matter ? ` — ${esc(i.matter)}` : '') +
      (i.webLink ? ` — <a href="${esc(i.webLink)}">open</a>` : '')) +
    section('Servings needing your response', bucket.servingsNeedingResponse, (i) =>
      `<b>${esc(i.subject)}</b>` + (i.counterparty ? ` — from ${esc(i.counterparty)}` : '') +
      (i.webLink ? ` — <a href="${esc(i.webLink)}">open</a>` : '')) +
    section('Demands awaiting a reply', bucket.demandsAwaiting, (i) =>
      `<b>${esc(i.subject)}</b> — ${i.daysOutstanding}d outstanding` +
      (i.counterparty ? ` — ${esc(i.counterparty)}` : '') +
      (i.webLink ? ` — <a href="${esc(i.webLink)}">open</a>` : '')) +
    `</div>`;
}

async function maybeSendDailyDigest(token, cfg, state) {
  if (cfg.dryRun || !cfg.sender) return;
  const { date, hour } = etNow();
  if (hour !== cfg.digestHour) return;
  if (state.lastDigestDate === date) return;

  for (const attorney of cfg.attorneys) {
    const bucket = agentState.byAttorney[attorney.key];
    if (!bucket) continue;
    const total = bucket.deadlines.length + bucket.servingsNeedingResponse.length + bucket.demandsAwaiting.length;
    if (!total) continue;
    try {
      await graph.sendMail(
        token, cfg.sender, attorney.email,
        `Litigation inbox — ${total} open item(s) — ${date}`,
        digestHtml(bucket),
      );
      agentState.counters.alertsSent += 1;
    } catch (e) {
      console.log(`[monitor] digest send failed for ${attorney.key} name=${e.name}`);
    }
  }
  state.lastDigestDate = date;
}

// -- orchestrator --------------------------------------------------------------
async function syncInboxMonitor() {
  const cfg = config();
  if (!cfg.enabled) return; // hard guard — never runs while dormant
  if (syncing) { console.log('[monitor] sync already in progress; skipping'); return; }
  syncing = true;
  const started = Date.now();
  agentState.status = 'syncing';
  agentState.lastError = null;

  const state = stateLib.load();
  let hadError = false;
  try {
    if (!cfg.attorneys.length) { console.log('[monitor] no LIT_ATTORNEY_EMAILS configured'); return; }
    const token = await graph.getGraphToken();
    for (const attorney of cfg.attorneys) {
      try {
        agentState.byAttorney[attorney.key] = await processAttorney(token, attorney, cfg, state);
        const b = agentState.byAttorney[attorney.key];
        console.log(
          `[monitor] mailbox=${attorney.key} deadlines=${b.deadlines.length} ` +
          `servings=${b.servingsNeedingResponse.length} demandsAwaiting=${b.demandsAwaiting.length}`
        );
      } catch (e) {
        hadError = true;
        console.log(`[monitor] mailbox=${attorney.key} error name=${e.name}`);
      }
      await new Promise((r) => setTimeout(r, 200)); // throttle between mailboxes
    }

    stateLib.save(state);
    await pushUrgentAlerts(token, cfg, state);
    await maybeSendDailyDigest(token, cfg, state);
    stateLib.save(state);

    agentState.lastSyncAt = new Date().toISOString();
    agentState.status = hadError ? 'partial' : 'ok';
    console.log(
      `[monitor] sync ${agentState.status} ${Math.round((Date.now() - started) / 1000)}s ` +
      `claudeCalls=${agentState.counters.claudeCallsMade} alertsSent=${agentState.counters.alertsSent}`
    );
  } catch (e) {
    agentState.status = 'error';
    agentState.lastError = { name: e.name, at: new Date().toISOString() };
    console.log(`[monitor] sync error name=${e.name}`);
  } finally {
    syncing = false;
  }
}

// -- public API ----------------------------------------------------------------
function modeString() {
  const cfg = config();
  if (!cfg.enabled) return 'DISABLED (MONITOR_ENABLED not set)';
  if (cfg.dryRun) return `DRY-RUN — no Claude on bodies, no alerts sent (mailboxes=${cfg.attorneys.length})`;
  return `LIVE — mailboxes=${cfg.attorneys.length} baaSigned=${cfg.baaSigned}`;
}

function start() {
  const cfg = config();
  if (!cfg.enabled) return;
  // Initial staggered run, then hourly.
  setTimeout(() => {
    syncInboxMonitor().catch((e) => console.log(`[monitor] initial run error name=${e.name}`));
    setInterval(
      () => syncInboxMonitor().catch((e) => console.log(`[monitor] scheduled run error name=${e.name}`)),
      60 * 60 * 1000,
    );
  }, 200000);
}

// Fire-and-forget manual trigger (used by POST /api/monitor/sync).
function syncNow() {
  syncInboxMonitor().catch((e) => console.log(`[monitor] manual run error name=${e.name}`));
}

function getStatus() {
  const cfg = config();
  return {
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    baaSigned: cfg.baaSigned,
    mailboxCount: cfg.attorneys.length,
    status: agentState.status,
    lastSyncAt: agentState.lastSyncAt,
    lastError: agentState.lastError,
    ...agentState.counters,
    byAttorney: agentState.byAttorney, // PHI — endpoint is behind requireAuth + no-store
  };
}

// Raw first-page inbox for one mailbox (troubleshooting). PHI — authed endpoint only.
async function debugMailbox(email) {
  const token = await graph.getGraphToken();
  const sinceISO = new Date(Date.now() - config().lookbackDays * 86400000).toISOString();
  const msgs = await graph.fetchMessages(token, email, 'inbox', sinceISO);
  return msgs.slice(0, 20).map((m) => ({
    id: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    receivedDateTime: m.receivedDateTime,
    conversationId: m.conversationId,
  }));
}

module.exports = { start, syncNow, getStatus, debugMailbox, modeString, config };
