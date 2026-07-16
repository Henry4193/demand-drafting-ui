// PHI-safe diagnostic: for a given file number, find ALL matching Filevine
// projects (incl. passenger sub-projects) and test the POC extraction on each.
// Prints only project ids, booleans, and the extracted staff first name — never
// client names or narrative. Run:  node scripts/fv-file-check.js 6366
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fvFetch } = require('../lib/filevine');

const fileNum = String(process.argv[2] || '').trim();
if (!fileNum) { console.log('usage: node scripts/fv-file-check.js <fileNumber>'); process.exit(1); }

function findKey(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const extractPoc = (t) => {
  const m = String(t || '').match(/POC\b[\s:=–-]*(?:is\s+)?([A-Za-z][A-Za-z'’.-]+)/i);
  return m ? m[1].replace(/[.'’-]+$/, '') : null;
};

(async () => {
  const ptid = process.env.FV_PROJ_TYPE_ID;
  const matches = [];
  let offset = 0;
  let scanned = 0;
  for (let page = 0; page < 200; page += 1) {
    const r = await fvFetch(`/fv-app/v2/projects?projectTypeId=${ptid}&limit=200&offset=${offset}`);
    if (!r.ok) { console.log(`project list failed: ${r.status}`); process.exit(2); }
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    for (const p of items) {
      scanned += 1;
      const name = String(p.projectOrClientName || p.projectName || p.clientName || '');
      const m = /^\s*(\d+)/.exec(name);
      if (m && m[1] === fileNum) {
        matches.push({
          pid: p.projectId?.native ?? p.projectId ?? p.id,
          archived: !!p.isArchived,
          listPosition: scanned, // earlier position = what the monitor's index picks
        });
      }
    }
    if (!data.hasMore || items.length === 0) break;
    offset += 200;
  }
  console.log(`scanned ${scanned} projects; matches for file # ${fileNum}: ${matches.length}`);
  for (const m of matches) {
    let poc = null;
    let present = false;
    try {
      const r = await fvFetch(`/fv-app/v2/projects/${m.pid}/forms/casesummary20164`);
      if (r.ok) {
        const facts = stripHtml(findKey(await r.json(), 'factsOfLoss'));
        present = facts.length > 0;
        poc = extractPoc(facts);
      } else { poc = `read-failed-${r.status}`; }
    } catch (_) { poc = 'read-error'; }
    console.log(`  projectId=${m.pid} listPos=${m.listPosition} archived=${m.archived} factsPresent=${present} poc=${poc || '(none)'}`);
  }
})();
