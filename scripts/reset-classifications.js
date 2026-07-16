// Selective cache reset for classifier tuning: clears cached classifications so
// emails re-classify under the CURRENT prompt/rules, but KEEPS the routed/posted
// records so nothing that already posted to Teams ever re-posts.
// Run:  node scripts/reset-classifications.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const stateLib = require('../lib/cm-state');

const s = stateLib.load();
const cleared = Object.keys(s.classifiedIds).length;
const kept = Object.keys(s.routed).length;
s.classifiedIds = {};
stateLib.save(s);
console.log(`cleared ${cleared} cached classifications (will re-classify under current rules)`);
console.log(`kept ${kept} routed/posted records (already-posted items will NOT re-post)`);
