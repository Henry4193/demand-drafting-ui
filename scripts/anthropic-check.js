// Diagnostic: reproduces the EXACT classifier call (system prompt, temperature 0,
// max_tokens 300) with a synthetic non-PHI email, to surface the real error the
// classifier hits. Never prints the key. Run:  node scripts/anthropic-check.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');

const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const keyPrefix = (process.env.ANTHROPIC_API_KEY || '').slice(0, 7);

const CLASSIFY_SYSTEM =
  'You are triaging the INCOMING email of an operations manager at a personal-injury law firm. ' +
  'The signal you want: a CASE MANAGER (or teammate) is asking the intake team to DO or PROVIDE ' +
  'something on an active case. Respond with ONLY a JSON object. ' +
  'Schema: {"type":"action_required"|"irrelevant","action":string|null,"dueDate":"YYYY-MM-DD"|null}.';

(async () => {
  console.log(`prefix: ${keyPrefix}... | model: ${model}`);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Test 1: plain (known-good shape)
  try {
    await client.messages.create({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Say OK.' }] });
    console.log('test1 plain            : OK');
  } catch (e) { console.log('test1 plain            : FAIL', e.name, '|', e.status, '|', e.message); }

  // Test 2: exact classifier params (system + temperature 0 + max_tokens 300)
  try {
    await client.messages.create({
      model, max_tokens: 300, system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: 'Subject: RE: New Case- Test Person 6388\n\nCan you please get the signed retainer for this client? Thanks.' }],
    });
    console.log('test2 classifier-shape : OK');
  } catch (e) {
    console.log('test2 classifier-shape : FAIL');
    console.log('   name   :', e.name, '| status:', e.status);
    console.log('   message:', e.message);
    console.log('   type   :', e?.error?.error?.type || e?.error?.type || '(none)');
    if (e.cause) console.log('   cause  :', e.cause.code || e.cause.message || String(e.cause));
  }
})();
