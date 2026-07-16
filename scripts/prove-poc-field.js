// One-off proof: can we reliably extract "POC is {name}" from the Facts of Loss
// field (casesummary20164 / factsofloss243755) and map it to an Intake Specialist?
//
// PHI-SAFE: this script NEVER prints the Facts of Loss narrative. It prints only
// structural proof — field present?, length, the extracted POC first name (a staff
// member, not PHI), and the registry match. Run:
//
//   node scripts/prove-poc-field.js <projectId>
//
// Uses the app's own .env (BAA-track Filevine creds) and lib/filevine.js.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fvFetch } = require('../lib/filevine');

const projectId = String(process.argv[2] || '').replace(/[^0-9]/g, '');
if (!projectId) {
  console.error('Usage: node scripts/prove-poc-field.js <projectId>');
  process.exit(1);
}

// Read the custom section. Primary = chase-ui's PROVEN read prefix
// (me.filevineapp.com/api/v2/org/{orgId}/project/{id}/custom/...) combined with the
// webhook's section selector. The /custom (no selector) variant lists all sections,
// which self-discovers the numeric id + field keys if the selector path misses.
const orgId = process.env.FV_ORG_ID || '6907';
const READ_ENDPOINTS = [
  { url: `https://me.filevineapp.com/api/v2/org/${orgId}/project/${projectId}/custom/casesummary20164`, method: 'GET' },
  { url: `https://me.filevineapp.com/api/v2/org/${orgId}/project/${projectId}/custom`, method: 'GET' },
  { url: `https://api.filevineapp.com/fv-app/v2/core/projects/${projectId}/forms/casesummary20164`, method: 'GET' },
  { url: `https://api.filevineapp.com/fv-app/v2/projects/${projectId}/forms/casesummary20164`, method: 'GET' },
];

// Recursively locate a field value by key anywhere in the response shape.
function findKey(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  // Rich-text/PersonLink fields sometimes wrap the string.
  return String(findKey(v, 'value') ?? findKey(v, 'text') ?? '');
}

// Resolve a field value whether the response is keyed directly
// ({ factsofloss243755: val }) OR an array/tree of field objects
// ({ selector|fieldSelector|id: 'factsofloss243755', value|text: val }).
function findFieldValue(obj, selector) {
  const direct = findKey(obj, selector);
  if (direct !== undefined) return direct;
  let hit;
  (function walk(node) {
    if (hit !== undefined || node == null || typeof node !== 'object') return;
    const idish = node.selector || node.fieldSelector || node.id || node.key;
    if (idish === selector) {
      hit = node.value ?? node.text ?? node.fieldValue ?? node.stringValue;
      return;
    }
    for (const v of Object.values(node)) walk(v);
  })(obj);
  return hit;
}

// PHI-safe: gather field-selector NAMES only (e.g. "factsofloss243755"),
// from both object keys and selector-valued strings. No values collected.
function collectSelectors(obj, acc = new Set()) {
  const isSel = (s) => typeof s === 'string' && /^[a-z][a-z0-9]*\d{5,6}$/.test(s);
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (isSel(k)) acc.add(k);
      if (isSel(v)) acc.add(v);
      walk(v);
    }
  })(obj);
  return [...acc].sort();
}

const stripHtml = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');

// "POC is Gerald", "POC: Gerald", "MAIN POC - Gerald", "poc gerald m."
function extractPoc(text) {
  const m = text.match(/POC\b[\s:=–-]*(?:is\s+)?([A-Za-z][A-Za-z'’.-]+)/i);
  return m ? m[1].replace(/[.'’-]+$/, '') : null;
}

function loadRegistry() {
  // staff-registry.js has no module.exports (it's pasted into chase-ui inline),
  // so require() yields {}. Evaluate the file and capture STAFF_REGISTRY instead.
  try {
    const fs = require('fs');
    const src = fs.readFileSync(
      'C:\\Users\\Henry Knotts\\Desktop\\Client Relations\\Admin\\staff-registry.js', 'utf8');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${src}\n;return typeof STAFF_REGISTRY !== 'undefined' ? STAFF_REGISTRY : [];`);
    return fn();
  } catch (e) {
    console.error(`[registry] could not load staff-registry.js: ${e.code || e.name}`);
    return null;
  }
}

(async () => {
  let raw, usedEndpoint;
  for (const ep of READ_ENDPOINTS) {
    const label = `${ep.method} ${ep.url.replace(/\d{5,}/, '{id}')}`;
    try {
      const opts = { method: ep.method };
      if (ep.body) opts.body = ep.body;
      const r = await fvFetch(ep.url, opts);
      if (r.ok) { raw = await r.json(); usedEndpoint = label; break; }
      console.error(`[read] ${label} -> ${r.status}`);
    } catch (e) {
      console.error(`[read] ${label} -> error ${e.name}`);
    }
  }
  if (!raw) { console.error('Could not read casesummary section from any endpoint.'); process.exit(2); }

  // v2 forms API keys fields in camelCase (factsOfLoss), not the write-selector
  // (factsofloss243755). Try both so the script works against either shape.
  const fieldVal = findFieldValue(raw, 'factsOfLoss') ?? findFieldValue(raw, 'factsofloss243755');
  const text = stripHtml(toText(fieldVal)).replace(/\s+/g, ' ').trim();

  // Diagnostic: which field-selector names did the section return? (names only)
  const selectors = collectSelectors(raw);
  console.error(`[diag] selectors returned (${selectors.length}): ${selectors.join(', ') || '(none)'}`);

  // Diagnostic: key-path skeleton of the response — KEY NAMES ONLY, no values,
  // not even lengths. Purely structural, so no PHI can surface.
  (function dumpKeys(node, prefix = '', depth = 0, budget = { n: 80 }) {
    if (depth > 4 || budget.n <= 0 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      console.error(`[skel] ${prefix} : array`);
      budget.n -= 1;
      if (node.length) dumpKeys(node[0], `${prefix}[0]`, depth + 1, budget);
      return;
    }
    for (const k of Object.keys(node)) {
      if (budget.n <= 0) return;
      const t = Array.isArray(node[k]) ? 'array' : typeof node[k];
      console.error(`[skel] ${prefix}.${k} : ${t}`);
      budget.n -= 1;
      dumpKeys(node[k], `${prefix}.${k}`, depth + 1, budget);
    }
  })(raw);
  const poc = extractPoc(text);

  // Registry match (staff names only — not PHI).
  let matches = null;
  if (poc) {
    const reg = loadRegistry();
    if (reg) {
      const first = poc.toLowerCase();
      matches = reg
        .filter((s) => {
          const name = String(s.displayName || s.masterName || s.name || '');
          const role = String(s.masterRole || s.role || '');
          return name.toLowerCase().split(/\s+/)[0] === first && /intake/i.test(role);
        })
        .map((s) => ({
          name: s.displayName || s.masterName || s.name,
          role: s.masterRole || s.role,
          email: s.email || s.upn || '(no email in registry)',
          office: s.inOffice ?? s.isInOffice ?? null,
        }));
    }
  }

  // ---- REDACTED PROOF ONLY (no narrative) ----
  console.log('\n===== POC field proof (PHI-safe) =====');
  console.log(`projectId          : ${projectId}`);
  console.log(`read endpoint       : ${usedEndpoint}`);
  console.log(`factsofloss present : ${fieldVal != null && text.length > 0 ? 'YES' : 'NO'}`);
  console.log(`field length (chars): ${text.length}`);
  console.log(`POC pattern matched : ${poc ? 'YES' : 'NO'}`);
  console.log(`extracted POC name  : ${poc || '(none)'}`);
  if (matches == null) {
    console.log(`registry match      : (skipped — no POC or registry unavailable)`);
  } else if (matches.length === 0) {
    console.log(`registry match      : 0 Intake Specialists named "${poc}"  -> would fall back to Henry`);
  } else {
    console.log(`registry match      : ${matches.length} found`);
    matches.forEach((m) => console.log(`   - ${m.name} | ${m.role} | ${m.email} | inOffice=${m.office}`));
  }
  console.log('======================================\n');
})();
