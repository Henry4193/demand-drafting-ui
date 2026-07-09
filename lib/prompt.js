// Prompt assembly + token budgeting for the demand generation call.

const MAX_INPUT_TOKENS = 160_000; // safe under a 200k window, leaves room for output
const PRIOR_DEMAND_CAP_TOKENS = 15_000; // style needs structure, not every page
const CHARS_PER_TOKEN = 4; // rough heuristic; adequate for budgeting

const estTokens = (s) => Math.ceil((s || '').length / CHARS_PER_TOKEN);
const truncateToTokens = (s, maxTokens) => s.slice(0, maxTokens * CHARS_PER_TOKEN);

const SYSTEM_PROMPT = [
  'You are drafting a formal demand letter for ME Lawyers, a personal-injury law firm.',
  'Rules:',
  '- Use ONLY facts present in the provided case documents and case metadata.',
  '- Never invent medical findings, dates, diagnoses, providers, or dollar amounts.',
  '- Where a needed fact is missing, insert a clearly-marked bracketed placeholder,',
  '  e.g. [INSERT: treatment end date] or [INSERT: total medical specials].',
  '- Match the tone, structure, section ordering, and formatting conventions of the',
  '  prior demand letters provided as examples. If none are provided, use a standard',
  '  demand-letter structure (intro, liability, injuries & treatment, damages, demand).',
  '- Do not include commentary about your process; output only the letter text.',
].join('\n');

// docs / priors are arrays of { name, text }.
// Returns { system, messages, truncated, truncationNote }.
function buildMessages({ caseMeta, caseDocs = [], priorDemands = [], customPrompt = '' }) {
  let priors = priorDemands.map((d) => ({ ...d }));
  let docs = caseDocs.map((d) => ({ ...d }));

  const metaBlock = caseMeta
    ? `<case_metadata>\n${JSON.stringify(caseMeta, null, 2)}\n</case_metadata>`
    : '<case_metadata>Not provided — rely solely on the case documents below.</case_metadata>';

  const instructionsBlock = `<instructions>\n${customPrompt}\n</instructions>`;

  // Fixed cost that must never be truncated.
  const fixedTokens =
    estTokens(SYSTEM_PROMPT) + estTokens(metaBlock) + estTokens(instructionsBlock) + 500;

  const notes = [];

  // Ladder step 1: cap each prior demand.
  priors = priors.map((p) => {
    if (estTokens(p.text) > PRIOR_DEMAND_CAP_TOKENS) {
      notes.push(`prior demand "${p.name}" trimmed to ~${PRIOR_DEMAND_CAP_TOKENS} tokens`);
      return { ...p, text: truncateToTokens(p.text, PRIOR_DEMAND_CAP_TOKENS) };
    }
    return p;
  });

  const budgetForDocs = () =>
    MAX_INPUT_TOKENS -
    fixedTokens -
    priors.reduce((sum, p) => sum + estTokens(p.text), 0);

  // Ladder step 2: if case docs still overflow, trim the LARGEST doc from its end,
  // repeatedly, until they fit. Never drop the smallest docs entirely.
  let guard = 0;
  while (docs.reduce((s, d) => s + estTokens(d.text), 0) > budgetForDocs() && guard < 1000) {
    guard += 1;
    const overBy =
      docs.reduce((s, d) => s + estTokens(d.text), 0) - budgetForDocs();
    // find largest
    let li = 0;
    for (let i = 1; i < docs.length; i += 1) {
      if (estTokens(docs[i].text) > estTokens(docs[li].text)) li = i;
    }
    const cur = estTokens(docs[li].text);
    const target = Math.max(1000, cur - overBy);
    if (target >= cur) break;
    docs[li] = { ...docs[li], text: truncateToTokens(docs[li].text, target) };
    if (!notes.some((n) => n.includes(docs[li].name))) {
      notes.push(`case document "${docs[li].name}" truncated to fit the context window`);
    }
  }

  const docsBlock =
    '<case_documents>\n' +
    docs
      .map((d) => `<document name="${escapeAttr(d.name)}">\n${d.text}\n</document>`)
      .join('\n') +
    '\n</case_documents>';

  const priorsBlock =
    '<prior_demand_examples>\n' +
    (priors.length
      ? priors
          .map((p) => `<document name="${escapeAttr(p.name)}">\n${p.text}\n</document>`)
          .join('\n')
      : 'None provided.') +
    '\n</prior_demand_examples>';

  const userContent = [metaBlock, docsBlock, priorsBlock, instructionsBlock].join('\n\n');

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    truncated: notes.length > 0,
    truncationNote: notes.length ? notes.join('; ') : null,
  };
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
}

module.exports = { buildMessages, MAX_INPUT_TOKENS };
