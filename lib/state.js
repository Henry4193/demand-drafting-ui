// PHI-free durable state for the inbox monitor.
//
// HARD RULE: this file is the ONLY thing the monitor writes to disk, and it must
// NEVER contain PHI. The Anthropic BAA authorizes PHI sent to Claude; it does NOT
// authorize PHI at rest on Railway (that would need a Railway BAA). So we persist
// only opaque, non-identifying keys needed to survive a restart:
//   - classifiedIds:  Graph message id -> { type, dueDate }   (dedupe classification)
//   - trackedDemands: Graph conversation id -> { sentDate, expectedReplyDays }
//   - alertedIds:     synthetic item id -> ISO timestamp        (dedupe Teams alerts)
//   - lastDigestDate: 'YYYY-MM-DD'                              (once-per-day digest guard)
//
// Message ids, conversation ids, dates, enums and counts are not PHI. Subjects,
// client/counterparty names, matters and bodies are — they live in memory only
// (see lib/monitor.js agentState) and are re-fetched from Graph at send time.

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.MONITOR_STATE_FILE
  ? path.resolve(process.env.MONITOR_STATE_FILE)
  : path.join(__dirname, '..', 'agent-state.json');

function emptyState() {
  return {
    classifiedIds: {},
    trackedDemands: {},
    alertedIds: {},
    lastDigestDate: null,
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Merge onto the empty shape so missing keys are always present.
    return { ...emptyState(), ...sanitize(raw) };
  } catch (_) {
    return emptyState();
  }
}

// Whitelist serializer — the single choke point that guarantees no PHI is ever
// written. Only the four known keys survive; anything else a caller mistakenly
// attaches is dropped here rather than persisted.
function sanitize(state) {
  const s = state || {};
  return {
    classifiedIds: pickMap(s.classifiedIds, (v) => ({
      type: v && typeof v.type === 'string' ? v.type : null,
      dueDate: v && typeof v.dueDate === 'string' ? v.dueDate : null,
    })),
    trackedDemands: pickMap(s.trackedDemands, (v) => ({
      sentDate: v && typeof v.sentDate === 'string' ? v.sentDate : null,
      expectedReplyDays: v && Number.isFinite(v.expectedReplyDays) ? v.expectedReplyDays : null,
    })),
    alertedIds: pickMap(s.alertedIds, (v) => (typeof v === 'string' ? v : null)),
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
