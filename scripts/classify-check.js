// Diagnostic: runs the classifier loop exactly like cm-monitor does (Graph inbox
// fetch -> Claude classify per email, BAA-track key) but catches errors PER EMAIL
// and prints ONLY error details + counts — never subjects, bodies, or names.
// Run:  node scripts/classify-check.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const graph = require('../lib/graph');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLASSIFY_SYSTEM =
  'You are triaging the INCOMING email of an operations manager at a personal-injury law firm. ' +
  'The signal you want: a CASE MANAGER (or teammate) is asking the intake team to DO or PROVIDE ' +
  'something on an active case - most often as a reply on a "New Case" assignment thread. ' +
  'Respond with ONLY a JSON object - no markdown, no prose. ' +
  'Schema: {"type":"action_required"|"irrelevant","action":<short imperative string or null>,"dueDate":"YYYY-MM-DD" or null}. ' +
  'action_required = the sender explicitly asks someone to take a concrete action on the case. ' +
  'irrelevant = notifications, refer-outs, FYI, newsletters, automated alerts, no clear ask. ' +
  'action = a short imperative summary of the ask, else null.';

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

(async () => {
  const mailbox = process.env.CM_MONITOR_MAILBOX;
  if (!mailbox) { console.log('CM_MONITOR_MAILBOX not set'); process.exit(1); }
  const token = await graph.getGraphToken();
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const inbox = await graph.fetchMessages(token, mailbox, 'inbox', since);
  console.log(`fetched ${inbox.length} messages; classifying first 25 (errors only, no content shown)...`);

  let ok = 0; let fail = 0;
  for (let i = 0; i < Math.min(inbox.length, 25); i += 1) {
    const m = inbox[i];
    const bodyText = stripHtml(m.body?.content || m.bodyPreview || '').slice(0, 6000);
    const content = `Subject: ${m.subject || '(no subject)'}\n\n${bodyText}`;
    try {
      await client.messages.create({
        model: MODEL, max_tokens: 300, system: CLASSIFY_SYSTEM,
        messages: [{ role: 'user', content }],
      });
      ok += 1;
      console.log(`${String(i + 1).padStart(2)}: ok  (contentLen=${content.length})`);
    } catch (e) {
      fail += 1;
      console.log(`${String(i + 1).padStart(2)}: FAIL name=${e.name} status=${e.status} ` +
        `type=${e?.error?.error?.type || e?.error?.type || '(none)'} contentLen=${content.length}`);
      console.log(`    msg=${String(e.message).slice(0, 220)}`);
    }
  }
  console.log(`done. ok=${ok} fail=${fail}`);
})().catch((e) => { console.log(`setup error: ${e.name}: ${String(e.message).slice(0, 220)}`); });
