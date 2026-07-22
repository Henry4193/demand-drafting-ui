// CM Action Router — inbox-monitoring agent for Henry's mailbox.
//
// Case managers email Henry asking for a direct action on a case. This agent detects
// those explicit asks, resolves WHICH intake specialist signed the case up (via the
// Filevine factsOfLoss "POC is {name}" line), and @mentions that person in Teams, with
// an escalation ladder so nothing is missed. Routing chain proven in
// scripts/prove-poc-field.js.
//
// SIBLING of lib/monitor.js (litigation) — same config/gates/state/orchestrator shape.
//
// SAFETY: nothing runs unless server.js calls start()/syncNow(), which only happens
// when CM_MONITOR_ENABLED === 'true'. Email BODIES go to Claude only when BAA_SIGNED
// and not dry-run. All PHI (subjects, names, actions, factsOfLoss, POC display names)
// stays in memory (agentState) or in-tenant (Graph/Filevine/Teams) — never on disk.
// Only PHI-free keys persist, via lib/cm-state.js.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const graph = require('./graph');
const { fvFetch } = require('./filevine');
const stateLib = require('./cm-state');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// -- config (read from env at call time so a restart picks up flag changes) ----
function config() {
  return {
    enabled: process.env.CM_MONITOR_ENABLED === 'true',
    dryRun: process.env.CM_MONITOR_DRY_RUN === 'true',
    baaSigned: process.env.BAA_SIGNED === 'true',
    mailbox: process.env.CM_MONITOR_MAILBOX || null,
    teamsChatId: process.env.CM_TEAMS_CHAT_ID || null,
    // Henry-facing traffic (unroutable/review items, escalations, daily digest)
    // goes to his personal chat when set; falls back to the team chat.
    henryChatId: process.env.CM_HENRY_CHAT_ID || null,
    sender: process.env.CM_MONITOR_SENDER || null,
    registryPath: process.env.CM_STAFF_REGISTRY_PATH || path.join(__dirname, 'staff-registry.js'),
    // Henry's inbox is high-volume (~1,100 msgs / 14 days) — keep the window tight.
    lookbackDays: intEnv('CM_MONITOR_LOOKBACK_DAYS', 3),
    escalateHours: intEnv('CM_ESCALATE_HOURS', 4),
    digestHour: intEnv('CM_MONITOR_DIGEST_HOUR', 8),
    // Safety valve: hard cap on NEW posts per sync — a stale-cache backlog must
    // never blast the chat (observed: 41 actionable queued on first live sync).
    maxPostsPerSync: intEnv('CM_MAX_POSTS_PER_SYNC', 5),
    // Unroutable asks (no intake resolved) default to SKIP — the email is already
    // in Henry's own inbox, so a "needs review" ping just duplicates it. Set
    // CM_REVIEW_FALLBACK=true to instead surface them to Henry's chat.
    reviewFallback: process.env.CM_REVIEW_FALLBACK === 'true',
    projTypeId: process.env.FV_PROJ_TYPE_ID || null,
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
  counters: { graphCallsMade: 0, claudeCallsMade: 0, fvCallsMade: 0, postsSent: 0 },
  items: {}, // msgId -> { subject, sender, action, dueDate, fileNumber, clientName,
             //           projectId, poc, intake, conversationId, receivedDate, webLink }
};

let anthropic = null;
function client() {
  // maxRetries 4 (SDK default 2): observed 529 overloaded bursts bounce ~1/3 of
  // calls — more backoff patience converts most of those into successes.
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return anthropic;
}

let syncing = false;

// -- date / business-hours helpers (ET) ----------------------------------------
function etParts(d = new Date()) {
  const date = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hour = Number(d.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit',
  })) % 24;
  const dow = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  return { date, hour, dow }; // dow: 0=Sun..6=Sat
}

// Approximate business hours (Mon–Fri, 09:00–18:00 ET) elapsed since an ISO time.
// Steps hour-by-hour; bounded because inputs are within the lookback window.
function businessHoursSince(iso) {
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return null;
  let count = 0;
  for (let t = start; t < Date.now(); t += 3600000) {
    const { hour, dow } = etParts(new Date(t));
    if (dow >= 1 && dow <= 5 && hour >= 9 && hour < 18) count += 1;
  }
  return count;
}

// -- staff registry ------------------------------------------------------------
// staff-registry.js has no module.exports (it's pasted into chase-ui inline), so we
// read + evaluate the file and capture STAFF_REGISTRY. Cached per-process.
let registryCache = null;
function loadRegistry(cfg) {
  if (registryCache) return registryCache;
  try {
    const src = fs.readFileSync(cfg.registryPath, 'utf8');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${src}\n;return typeof STAFF_REGISTRY!=='undefined'?STAFF_REGISTRY:[];`);
    registryCache = fn() || [];
  } catch (e) {
    console.log(`[cm-monitor] registry load failed name=${e.name}`);
    registryCache = [];
  }
  return registryCache;
}

// First name -> single Intake Specialist, or null when 0 or >1 match (→ fallback).
function matchIntake(firstName, cfg) {
  if (!firstName) return null;
  const first = firstName.toLowerCase();
  const hits = loadRegistry(cfg).filter((s) => {
    const name = String(s.name || '').toLowerCase();
    return name.split(/\s+/)[0] === first && /intake/i.test(String(s.role || ''));
  });
  return hits.length === 1 ? hits[0] : null;
}

// -- Filevine: file number -> projectId (cached index) -------------------------
const INDEX_TTL = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 200;
let projectIndex = { at: 0, byNumber: {} };
let indexBuilding = null;

// Leading file number from a project/client name: "5130 - Watts, Jacque" -> "5130".
function fileNumberFromName(name) {
  const m = /^\s*(\d+)/.exec(String(name || ''));
  return m ? m[1] : null;
}

async function buildProjectIndex(cfg) {
  const byNumber = {};
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await fvFetch(`/fv-app/v2/projects?projectTypeId=${cfg.projTypeId}&limit=${PAGE_SIZE}&offset=${offset}`);
    agentState.counters.fvCallsMade += 1;
    if (!r.ok) throw new Error(`filevine index status ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    for (const p of items) {
      if (p.isArchived) continue;
      const num = fileNumberFromName(p.projectOrClientName || p.projectName || p.clientName);
      const pid = p.projectId?.native ?? p.projectId ?? p.id;
      if (num && pid && !byNumber[num]) byNumber[num] = pid; // first (lowest offset) wins
    }
    if (!data.hasMore || items.length === 0) break;
    offset += PAGE_SIZE;
  }
  projectIndex = { at: Date.now(), byNumber };
  console.log(`[cm-monitor] project index rebuilt count=${Object.keys(byNumber).length}`);
  return projectIndex;
}

async function getProjectId(fileNumber, cfg) {
  if (!fileNumber) return null;
  if (!Object.keys(projectIndex.byNumber).length || Date.now() - projectIndex.at > INDEX_TTL) {
    if (!indexBuilding) indexBuilding = buildProjectIndex(cfg).finally(() => { indexBuilding = null; });
    await indexBuilding;
  }
  return projectIndex.byNumber[fileNumber] || null;
}

// -- Filevine: read factsOfLoss + extract POC ----------------------------------
function findKey(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// "POC is Gerald", "POC: Gerald", "MAIN POC - Gerald" -> "Gerald".
function extractPoc(text) {
  const m = String(text || '').match(/POC\b[\s:=–-]*(?:is\s+)?([A-Za-z][A-Za-z'’.-]+)/i);
  return m ? m[1].replace(/[.'’-]+$/, '') : null;
}

async function readPocName(projectId) {
  const r = await fvFetch(`/fv-app/v2/projects/${projectId}/forms/casesummary20164`);
  agentState.counters.fvCallsMade += 1;
  if (!r.ok) return null;
  const data = await r.json();
  const facts = stripHtml(findKey(data, 'factsOfLoss'));
  return extractPoc(facts);
}

// -- subject parsing -----------------------------------------------------------
// Assignment-thread subjects carry a file number and client name in two real formats
// (calibrated against live mail 2026-07-15):
//   "RE: New Case- Leah Dunmore 6388"        -> file 6388, name "Leah Dunmore"
//   "Re: 6106 - 2 - Zelaya Vasquez, Elvira"  -> file 6106, name "Vasquez, Elvira"
// The file-number match ignores long digit runs (phone numbers in "lead information" mail).
function parseSubject(subject) {
  const s = String(subject || '');
  const numMatch = s.match(/#\s*(\d{3,6})\b/) || s.match(/(?<!\d)(\d{3,6})(?!\d)/);
  const fileNumber = numMatch ? numMatch[1] : null;

  let clientName = null;
  const comma = s.match(/([A-Z][a-z]+,\s*[A-Z][a-z]+)/); // "Vasquez, Elvira"
  if (comma) {
    clientName = comma[1];
  } else {
    // "New Case- {First [Middle...] Last} {file#}"
    const nc = s.match(/New Case\s*[-–]\s*(.+?)\s+\d{3,6}\b/i);
    if (nc) clientName = nc[1].trim();
  }
  return { fileNumber, clientName };
}

// -- classification (Claude, BAA-track key) ------------------------------------
const CLASSIFY_SYSTEM =
  'You are triaging the INCOMING email of an operations manager at a personal-injury law firm. ' +
  'The signal you want: a CASE MANAGER (or teammate) is asking the intake team to DO or PROVIDE ' +
  'something on an active case — most often as a reply on a "New Case" assignment thread. ' +
  'Respond with ONLY a JSON object — no markdown, no prose. ' +
  'Schema: {"type":"action_required"|"irrelevant","action":<short imperative string or null>,"dueDate":"YYYY-MM-DD" or null}. ' +
  'action_required = the sender DIRECTLY and explicitly asks the recipient or the intake team ' +
  'to take a concrete action on the case — an imperative or question addressed TO THEM ' +
  '(e.g. "can you get the signed retainer", "please call the client", "resend the HIPAA"). ' +
  'irrelevant = ALL of the following: a bare new-case assignment notification with no request; ' +
  'statements of fact or case context (coverage, deductible, treatment details) even when follow-up ' +
  'work could be INFERRED — inferred to-dos are NOT asks; ' +
  'refer-out, sub-out, referral, or case-transfer coordination; FYI / thanks / acknowledgements; ' +
  'a status update or confirmation that someone is ALREADY handling it (e.g. "I have been reaching out to the client"); ' +
  'scheduling confirmations; newsletters, marketing, vendor, or automated system alerts. ' +
  'When there is no clear, explicit ask addressed to the recipient, choose irrelevant. ' +
  'action = a short imperative summary of the ask, else null.';

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fall through */ } }
    return null;
  }
}

function isSkippable(msg, cfg) {
  const subj = String(msg.subject || '').toLowerCase();
  if (/^(automatic reply|out of office|undeliverable|delivery has failed)/.test(subj)) return true;
  // Inbound referral notices are a different workflow — never CM action items (Henry, 2026-07-15).
  if (subj.includes('new referral')) return true;
  // Drop-review threads are attorney-team workflow, not intake action items (Henry, 2026-07-16).
  if (subj.includes('review for drop')) return true;
  return false;
}

// Returns { type, action, dueDate } or null when Claude is intentionally not called
// (dry-run / BAA not signed). Caches PHI-free { type, dueDate } per msg id.
async function classifyMessage(msg, cfg, state) {
  // Deterministic skip rules run BEFORE the cache so rule updates apply
  // immediately, even to messages classified under older rules.
  if (isSkippable(msg, cfg)) {
    state.classifiedIds[msg.id] = { type: 'irrelevant', dueDate: null };
    return { type: 'irrelevant', action: null, dueDate: null };
  }
  const cached = state.classifiedIds[msg.id];
  if (cached) return { type: cached.type, action: null, dueDate: cached.dueDate };
  if (cfg.dryRun || !cfg.baaSigned) return null; // gate: bodies (PHI) → Claude only when live

  const bodyText = stripHtml(msg.body?.content || msg.bodyPreview || '').slice(0, 6000);
  const resp = await client().messages.create({
    model: MODEL, max_tokens: 300, // no temperature — deprecated for claude-sonnet-5
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: `Subject: ${msg.subject || '(no subject)'}\n\n${bodyText}` }],
  });
  agentState.counters.claudeCallsMade += 1;
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJson(text);
  if (!parsed || typeof parsed.type !== 'string') return { type: 'irrelevant', action: null, dueDate: null };
  state.classifiedIds[msg.id] = { type: parsed.type, dueDate: parsed.dueDate || null };
  return parsed;
}

// -- routing (build the in-memory item for each action_required message) --------
async function buildItems(inbox, cfg, state) {
  agentState.items = {};
  for (const m of inbox) {
    // Per-email resilience: transient API errors (529 overloaded / 429) must not
    // kill the whole sync. An uncached failure simply retries next sync.
    let cls = null;
    try {
      cls = await classifyMessage(m, cfg, state);
    } catch (e) {
      console.log(`[cm-monitor] classify failed msg=${m.id} status=${e.status || '?'} name=${e.name}`);
      continue;
    }
    if (!cls || cls.type !== 'action_required') continue;

    const { fileNumber, clientName } = parseSubject(m.subject);
    let projectId = null;
    let poc = null;
    let intake = null;
    try {
      projectId = await getProjectId(fileNumber, cfg);
      if (projectId) poc = await readPocName(projectId);
      if (poc) intake = matchIntake(poc, cfg);
    } catch (e) {
      console.log(`[cm-monitor] route lookup failed msg=${m.id} name=${e.name}`);
    }

    // A message FROM the resolved POC isn't an ask TO them — e.g. the intake
    // confirming they're already reaching out. Suppress. (Henry, 2026-07-15)
    const senderAddr = (m.from?.emailAddress?.address || '').toLowerCase();
    if (intake && intake.email && senderAddr === intake.email.toLowerCase()) {
      console.log(`[cm-monitor] skip poc-self-reply msg=${m.id} intake=${intake.key}`);
      continue;
    }

    agentState.items[m.id] = {
      subject: m.subject || '(no subject)',
      sender: m.from?.emailAddress?.name || m.from?.emailAddress?.address || null,
      action: cls.action || null,
      dueDate: cls.dueDate || null,
      fileNumber, clientName, projectId, poc, intake,
      conversationId: m.conversationId || null,
      receivedDate: m.receivedDateTime || null,
      webLink: m.webLink || null,
    };
  }
}

// -- Teams posting -------------------------------------------------------------
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the message html + mentions array. `target` is a resolved { id, displayName }
// or null (unroutable → mention Henry via `fallback`).
function composePost(item, target, fallback) {
  const who = target || fallback;
  const mentions = who
    ? [{ id: 0, mentionText: who.displayName,
         mentioned: { user: { id: who.id, displayName: who.displayName, userIdentityType: 'aadUser' } } }]
    : [];
  const at = who ? `<at id="0">${escHtml(who.displayName)}</at>` : '(unassigned)';
  const client = item.clientName || 'a client';
  const file = item.fileNumber ? ` (#${escHtml(item.fileNumber)})` : '';
  const ask = item.action ? escHtml(item.action) : 'needs a response';
  const from = item.sender ? ` — from ${escHtml(item.sender)}` : '';
  const due = item.dueDate ? ` · due ${escHtml(item.dueDate)}` : '';
  // No email link: the webLink points into Henry's mailbox, which recipients can't open.
  const note = target ? '' : ' <i>(couldn’t auto-route — please reassign)</i>';
  // Reply-all on the email thread is the ONLY thing that clears this reminder —
  // spell it out on every routed post so the habit sticks.
  const hint = target ? '<br><i>↩️ Reply-all on the email thread when handled to clear this.</i>' : '';
  return {
    html: `🔔 ${at} — <b>${escHtml(client)}</b>${file}: ${ask}${from}${due}${note}${hint}`,
    mentions,
  };
}

// -- orchestration: post new items + escalate open ones ------------------------
async function routeAndPost(token, cfg, state, inbox) {
  if (cfg.dryRun || !cfg.teamsChatId) return;
  const henry = cfg.mailbox ? await graph.resolveUserId(token, cfg.mailbox) : null;
  const nowISO = new Date().toISOString();
  let newPosts = 0;

  // Latest inbound message time per conversation, from the FULL inbox — not just
  // flagged items. A reply that resolves an ask ("done, I called them") classifies
  // as irrelevant, so it never lands in agentState.items; scanning only those would
  // mean items essentially never auto-resolve. (Same approach as lib/monitor.js.)
  const latestByConv = {};
  for (const m of inbox) {
    const c = m.conversationId;
    if (!c) continue;
    const t = new Date(m.receivedDateTime || 0).getTime();
    if (!latestByConv[c] || t > latestByConv[c]) latestByConv[c] = t;
  }

  for (const msgId of Object.keys(agentState.items)) {
    const item = agentState.items[msgId];
    const rec = state.routed[msgId];
    const target = item.intake
      ? await graph.resolveUserId(token, item.intake.email)
      : null;
    // Routable items → team chat; Henry-review items → his personal chat when set.
    const dest = target ? cfg.teamsChatId : (cfg.henryChatId || cfg.teamsChatId);

    // (a) New item → post once (bounded by the per-sync cap; the rest wait for
    // the next hourly sync, so a backlog trickles instead of blasting).
    if (!rec) {
      // Unroutable ask (no intake) → skip unless the review fallback is on.
      if (!target && !cfg.reviewFallback) {
        console.log(`[cm-monitor] skip unroutable msg=${msgId} (no intake, review fallback off)`);
        continue;
      }
      if (newPosts >= cfg.maxPostsPerSync) continue;
      const { html, mentions } = composePost(item, target, henry);
      try {
        await graph.postChatMessage(dest, html, mentions);
        newPosts += 1;
        agentState.counters.postsSent += 1;
        state.routed[msgId] = {
          postedAt: nowISO, intakeKey: item.intake?.key || null,
          fileNumber: item.fileNumber || null, stage: 'posted',
          conversationId: item.conversationId || null,
        };
      } catch (e) {
        console.log(`[cm-monitor] post failed msg=${msgId} detail=${e.message}`);
      }
      continue;
    }

    if (rec.stage === 'resolved') continue;

    // Unroutable items are already in Henry's own inbox — never nag on them when
    // the review fallback is off. Resolve so the escalation ladder stops (also
    // cleans up items posted before the review-fallback rule existed).
    if (!target && !cfg.reviewFallback) { rec.stage = 'resolved'; continue; }

    // (b) Answered on the thread after we posted → resolve, stop nagging.
    const postedMs = new Date(rec.postedAt).getTime();
    const repliedAfter = rec.conversationId && latestByConv[rec.conversationId] > postedMs;
    if (repliedAfter) { rec.stage = 'resolved'; continue; }

    // (c) Escalation ladder by elapsed business hours.
    const bh = businessHoursSince(rec.postedAt);
    if (rec.stage === 'posted' && bh != null && bh >= cfg.escalateHours) {
      const { html, mentions } = composePost(item, target, henry);
      try {
        await graph.postChatMessage(dest, `⏰ Still open — ${html}`, mentions);
        agentState.counters.postsSent += 1;
        rec.stage = 'reminded';
      } catch (e) { console.log(`[cm-monitor] reminder failed msg=${msgId} detail=${e.message}`); }
    } else if (rec.stage === 'reminded' && etParts().hour >= 16 && henry) {
      const mentions = [{ id: 0, mentionText: henry.displayName,
        mentioned: { user: { id: henry.id, displayName: henry.displayName, userIdentityType: 'aadUser' } } }];
      try {
        // Escalations are Henry-facing — his personal chat when configured.
        await graph.postChatMessage(cfg.henryChatId || cfg.teamsChatId,
          `🚨 <at id="0">${escHtml(henry.displayName)}</at> — unresolved CM request: <b>${escHtml(item.clientName || '')}</b>` +
          `${item.fileNumber ? ` (#${escHtml(item.fileNumber)})` : ''} ${item.action ? escHtml(item.action) : ''}`, mentions);
        agentState.counters.postsSent += 1;
        rec.stage = 'escalated';
      } catch (e) { console.log(`[cm-monitor] escalation failed msg=${msgId} detail=${e.message}`); }
    }
  }
}

// -- daily digest to Henry -----------------------------------------------------
async function maybeSendDailyDigest(token, cfg, state) {
  if (cfg.dryRun || !cfg.teamsChatId) return;
  const { date, hour } = etParts();
  if (hour !== cfg.digestHour || state.lastDigestDate === date) return;

  const open = Object.keys(agentState.items)
    .filter((id) => state.routed[id] && state.routed[id].stage !== 'resolved')
    .map((id) => agentState.items[id]);
  if (open.length) {
    const rows = open.map((it) =>
      `<li><b>${escHtml(it.clientName || '(unknown)')}</b>` +
      `${it.fileNumber ? ` (#${escHtml(it.fileNumber)})` : ''} — ${escHtml(it.action || 'needs response')}` +
      `${it.intake ? ` · ${escHtml(it.intake.name)}` : ' · <i>unrouted</i>'}</li>`).join('');
    try {
      // The digest is Henry's overview — his personal chat when configured.
      await graph.postChatMessage(cfg.henryChatId || cfg.teamsChatId,
        `<b>Open CM action items — ${open.length} — ${date}</b><ul>${rows}</ul>`);
      agentState.counters.postsSent += 1;
    } catch (e) { console.log(`[cm-monitor] digest failed detail=${e.message}`); }
  }
  state.lastDigestDate = date;
}

// -- orchestrator --------------------------------------------------------------
async function syncCmMonitor() {
  const cfg = config();
  if (!cfg.enabled) return; // hard guard — never runs while dormant
  if (syncing) { console.log('[cm-monitor] sync already in progress; skipping'); return; }
  if (!cfg.mailbox) { console.log('[cm-monitor] no CM_MONITOR_MAILBOX configured'); return; }
  syncing = true;
  const started = Date.now();
  agentState.status = 'syncing';
  agentState.lastError = null;

  const state = stateLib.load();
  try {
    const token = await graph.getGraphToken();
    const sinceISO = new Date(Date.now() - cfg.lookbackDays * 86400000).toISOString();
    const inbox = await graph.fetchMessages(token, cfg.mailbox, 'inbox', sinceISO);
    agentState.counters.graphCallsMade += 1;

    // Loud diagnostics for the two silent-zero failure modes we've actually hit.
    if (!inbox.length) {
      console.log(`[cm-monitor] WARNING fetched 0 messages — check Graph access to ${cfg.mailbox} (403/404 reads as empty)`);
    }
    if (cfg.dryRun || !cfg.baaSigned) {
      console.log(`[cm-monitor] WARNING classification GATED OFF (dryRun=${cfg.dryRun} baaSigned=${cfg.baaSigned}) — nothing can be flagged`);
    }

    await buildItems(inbox, cfg, state);
    stateLib.save(state);
    await routeAndPost(token, cfg, state, inbox);
    await maybeSendDailyDigest(token, cfg, state);
    stateLib.save(state);

    agentState.lastSyncAt = new Date().toISOString();
    agentState.status = 'ok';
    const actionable = Object.keys(agentState.items).length;
    console.log(
      `[cm-monitor] sync ok ${Math.round((Date.now() - started) / 1000)}s ` +
      `fetched=${inbox.length} actionable=${actionable} ` +
      `claudeCalls=${agentState.counters.claudeCallsMade} posts=${agentState.counters.postsSent}`
    );
  } catch (e) {
    agentState.status = 'error';
    agentState.lastError = { name: e.name, at: new Date().toISOString() };
    console.log(`[cm-monitor] sync error name=${e.name}`);
  } finally {
    syncing = false;
  }
}

// -- public API ----------------------------------------------------------------
function modeString() {
  const cfg = config();
  if (!cfg.enabled) return 'DISABLED (CM_MONITOR_ENABLED not set)';
  if (cfg.dryRun) return `DRY-RUN — no Claude on bodies, no Teams posts (mailbox=${cfg.mailbox || 'unset'})`;
  return `LIVE — mailbox=${cfg.mailbox} baaSigned=${cfg.baaSigned} chat=${cfg.teamsChatId ? 'set' : 'UNSET'}`;
}

function start() {
  const cfg = config();
  if (!cfg.enabled) return;
  setTimeout(() => {
    syncCmMonitor().catch((e) => console.log(`[cm-monitor] initial run error name=${e.name}`));
    setInterval(
      () => syncCmMonitor().catch((e) => console.log(`[cm-monitor] scheduled run error name=${e.name}`)),
      60 * 60 * 1000,
    );
  }, 210000); // stagger ~10s after the litigation monitor's 200s
}

function syncNow() {
  syncCmMonitor().catch((e) => console.log(`[cm-monitor] manual run error name=${e.name}`));
}

function getStatus() {
  const cfg = config();
  return {
    enabled: cfg.enabled, dryRun: cfg.dryRun, baaSigned: cfg.baaSigned,
    mailbox: cfg.mailbox, teamsChatConfigured: !!cfg.teamsChatId,
    status: agentState.status, lastSyncAt: agentState.lastSyncAt, lastError: agentState.lastError,
    ...agentState.counters,
    items: agentState.items, // PHI — endpoint must be behind requireAuth + no-store
  };
}

// Dry-run calibration: fetch the inbox and run the ROUTING chain (subject parse →
// projectId → POC → intake) on each message, WITHOUT Claude classification or any
// Teams post. Lets us calibrate parseSubject + verify the FV routing on real mail
// before going live. PHI (subjects/client names) — authed + no-store endpoint only.
async function debugRoute(limit = 25, classify = false) {
  const cfg = config();
  if (!cfg.mailbox) throw new Error('CM_MONITOR_MAILBOX not set');
  const token = await graph.getGraphToken();
  const sinceISO = new Date(Date.now() - cfg.lookbackDays * 86400000).toISOString();
  const inbox = await graph.fetchMessages(token, cfg.mailbox, 'inbox', sinceISO);
  const state = classify ? stateLib.load() : null;
  const out = [];
  for (const m of inbox.slice(0, limit)) {
    // Classification (optional; obeys the same gate — null when dry-run / BAA off).
    let classification = null;
    let action = null;
    if (classify) {
      try {
        const cls = await classifyMessage(m, cfg, state);
        classification = cls ? cls.type : 'gated-off';
        action = cls ? (cls.action || null) : null;
      } catch (e) {
        // Transient API error (e.g. 529 overloaded) — report it per-row, keep going.
        classification = `error(${e.status || e.name})`;
      }
    }

    const { fileNumber, clientName } = parseSubject(m.subject);
    let projectId = null;
    let poc = null;
    let intakeHit = null;
    try {
      projectId = await getProjectId(fileNumber, cfg);
      if (projectId) poc = await readPocName(projectId);
      if (poc) intakeHit = matchIntake(poc, cfg);
    } catch (_) { /* leave nulls — this is a diagnostic */ }
    const senderAddr = (m.from?.emailAddress?.address || '').toLowerCase();
    const senderIsPoc = !!(intakeHit && intakeHit.email && senderAddr === intakeHit.email.toLowerCase());
    out.push({
      row: out.length + 1, // matches the console numbering — makes the JSON reviewable
      subject: m.subject || null,
      from: m.from?.emailAddress?.address || null,
      classification, action,
      fileNumber, clientName, projectId, poc,
      intake: intakeHit ? intakeHit.name : null,
      note: senderIsPoc ? 'suppressed: sender is the POC'
        : (!intakeHit && !cfg.reviewFallback && classification === 'action_required'
          ? 'skipped: unroutable (already in Henry\'s inbox)' : null),
      // Would this post in production? action_required, not a POC self-reply, AND
      // either routable to an intake or the review fallback is enabled.
      wouldRoute: (classification === 'action_required') && !senderIsPoc
        && (!!intakeHit || cfg.reviewFallback),
      dest: (classification === 'action_required') && !senderIsPoc && (!!intakeHit || cfg.reviewFallback)
        ? (intakeHit ? 'intake' : 'henry-review')
        : null,
      routed: !!intakeHit, // routing-chain success regardless of classification
    });
  }
  if (classify && state) stateLib.save(state);
  return out;
}

module.exports = { start, syncNow, getStatus, debugRoute, modeString, config };
