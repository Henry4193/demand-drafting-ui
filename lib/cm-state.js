// PHI-free durable state for the CM Action Router (cm-monitor.js).
//
// HARD RULE (same as lib/state.js): the ONLY thing this monitor writes to disk, and
// it must NEVER contain PHI. The Anthropic BAA covers PHI sent to Claude; it does NOT
// cover PHI at rest on Railway. So we persist only opaque, non-identifying keys:
//   - classifiedIds:  Graph message id -> { type, dueDate }        (dedupe classify)
//   - routed:         Graph message id -> { postedAt, intakeKey, fileNumber,
//                                           stage, conversationId } (route + escalation)
//   - lastDigestDate: 'YYYY-MM-DD'                                  (once-per-day digest)
//
// intakeKey is a staff-registry key ('yassira'), fileNumber is a case number, stage is
// an enum, conversationId/message ids and dates are opaque — none are PHI. Subjects,
// client names, the requested action, factsOfLoss text and POC display names are PHI:
// they live in memory only (cm-monitor.js agentState) and are re-derived at post time.

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.CM_MONITOR_STATE_FILE
  ? path.resolve(process.env.CM_MONITOR_STATE_FILE)
  : path.join(__dirname, '..', 'cm-agent-state.json');

const STAGES = new Set(['posted', 'reminded', 'escalated', 'resolved']);

function emptyState() {
  return {
    classifiedIds: {},
    routed: {},
    lastDigestDate: null,
  };
}

function load() {
  // First-boot seed (Railway): if no state file exists yet but a seed is provided
  // (base64 of the local cm-agent-state.json), write it once so already-posted
  // items carry over and are never re-posted. State is PHI-free by construction.
  if (!fs.existsSync(STATE_FILE) && process.env.CM_STATE_SEED) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE,
        Buffer.from(process.env.CM_STATE_SEED, 'base64').toString('utf8'));
      console.log('[cm-state] state file seeded from CM_STATE_SEED');
    } catch (e) {
      console.log(`[cm-state] state seed write failed name=${e.name}`);
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...emptyState(), ...sanitize(raw) };
  } catch (_) {
    return emptyState();
  }
}

// Whitelist serializer — the single choke point guaranteeing no PHI is written.
function sanitize(state) {
  const s = state || {};
  return {
    classifiedIds: pickMap(s.classifiedIds, (v) => ({
      type: v && typeof v.type === 'string' ? v.type : null,
      dueDate: v && typeof v.dueDate === 'string' ? v.dueDate : null,
    })),
    routed: pickMap(s.routed, (v) => ({
      postedAt: v && typeof v.postedAt === 'string' ? v.postedAt : null,
      intakeKey: v && typeof v.intakeKey === 'string' ? v.intakeKey : null,
      fileNumber: v && typeof v.fileNumber === 'string' ? v.fileNumber : null,
      stage: v && STAGES.has(v.stage) ? v.stage : 'posted',
      conversationId: v && typeof v.conversationId === 'string' ? v.conversationId : null,
    })),
    lastDigestDate: typeof s.lastDigestDate === 'string' ? s.lastDigestDate : null,
  };
}

function pickMap(obj, shape) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) out[k] = shape(obj[k]);
  }
  return out;
}

function save(state) {
  const clean = sanitize(state);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return clean;
}

module.exports = { load, save, emptyState, sanitize, STATE_FILE };
