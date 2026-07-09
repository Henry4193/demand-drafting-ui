'use strict';

// ---- helpers -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error('auth'); }
  return r;
}

// ---- auth ----------------------------------------------------------------
function showLogin() { $('login-view').classList.remove('hidden'); $('app-view').classList.add('hidden'); }
function showApp() { $('login-view').classList.add('hidden'); $('app-view').classList.remove('hidden'); }

async function checkSession() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    if (d.authed) showApp(); else showLogin();
  } catch { showLogin(); }
}

$('lg-btn').addEventListener('click', doLogin);
$('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  $('lg-err').textContent = '';
  const username = $('lg-user').value;
  const password = $('lg-pass').value;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (r.ok) { $('lg-pass').value = ''; showApp(); }
    else { const d = await r.json().catch(() => ({})); $('lg-err').textContent = d.error || 'Sign in failed.'; }
  } catch { $('lg-err').textContent = 'Network error.'; }
}

// ---- case picker ---------------------------------------------------------
let selectedProjectId = null;
let searchTimer = null;

$('case-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { closeResults(); return; }
  searchTimer = setTimeout(() => runSearch(q), 400);
});

async function runSearch(q) {
  try {
    const r = await api('/api/cases/search?q=' + encodeURIComponent(q));
    const items = await r.json();
    renderResults(items);
  } catch { /* auth handled in api() */ }
}

function renderResults(items) {
  const box = $('case-results');
  if (!items.length) { box.innerHTML = '<div class="result-item rp">No matches</div>'; box.classList.add('open'); return; }
  box.innerHTML = items.map((it) =>
    `<div class="result-item" data-id="${it.projectId}" data-name="${escapeHtml(it.name)}">` +
    `${escapeHtml(it.name)}<div class="rp">#${it.projectId}${it.phaseName ? ' · ' + escapeHtml(it.phaseName) : ''}</div></div>`
  ).join('');
  box.classList.add('open');
  box.querySelectorAll('.result-item[data-id]').forEach((el) => {
    el.addEventListener('click', () => selectCase(el.dataset.id, el.dataset.name));
  });
}

function selectCase(id, name) {
  selectedProjectId = id;
  $('case-chip-text').textContent = `${name} (#${id})`;
  $('case-chip').style.display = 'flex';
  $('case-search').value = '';
  closeResults();
}

$('case-clear').addEventListener('click', () => {
  selectedProjectId = null;
  $('case-chip').style.display = 'none';
});

function closeResults() { $('case-results').classList.remove('open'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('.case-search-wrap')) closeResults();
});

// ---- file staging --------------------------------------------------------
const docsFiles = [];
const priorFiles = [];

function wireDropzone(dzId, inputId, store, listId, max) {
  const dz = $(dzId), input = $(inputId);
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    addFiles(store, [...e.dataTransfer.files], max, listId);
  });
  input.addEventListener('change', () => { addFiles(store, [...input.files], max, listId); input.value = ''; });
}

function addFiles(store, files, max, listId) {
  for (const f of files) {
    if (store.length >= max) break;
    if (!/\.(pdf|docx|txt)$/i.test(f.name)) continue;
    store.push(f);
  }
  renderFileList(store, listId);
  refreshGenerateEnabled();
}

function renderFileList(store, listId) {
  const ul = $(listId);
  ul.innerHTML = store.map((f, i) =>
    `<li><span>${escapeHtml(f.name)}</span><span class="fsize">${fmtSize(f.size)}</span>` +
    `<button data-i="${i}">✕</button></li>`
  ).join('');
  ul.querySelectorAll('button[data-i]').forEach((b) => {
    b.addEventListener('click', () => { store.splice(+b.dataset.i, 1); renderFileList(store, listId); refreshGenerateEnabled(); });
  });
}

wireDropzone('dz-docs', 'in-docs', docsFiles, 'list-docs', 10);
wireDropzone('dz-priors', 'in-priors', priorFiles, 'list-priors', 3);

// ---- generate ------------------------------------------------------------
$('prompt').addEventListener('input', refreshGenerateEnabled);

function refreshGenerateEnabled() {
  const ok = docsFiles.length >= 1 && $('prompt').value.trim().length > 0;
  $('gen-btn').disabled = !ok;
}

$('gen-btn').addEventListener('click', doGenerate);

async function doGenerate() {
  $('gen-btn').disabled = true;
  $('warnings').innerHTML = '';
  $('gen-status').textContent = 'Extracting documents…';

  const fd = new FormData();
  if (selectedProjectId) fd.append('projectId', selectedProjectId);
  fd.append('customPrompt', $('prompt').value.trim());
  docsFiles.forEach((f) => fd.append('caseDocs', f));
  priorFiles.forEach((f) => fd.append('priorDemands', f));

  // fake staged status; real streaming is a v2 concern
  const stage = setTimeout(() => { $('gen-status').textContent = 'Drafting with Claude…'; }, 1200);

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
    const r = await api('/api/generate', { method: 'POST', body: fd, signal: ctrl.signal });
    clearTimeout(timeout); clearTimeout(stage);

    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showError(d.error || 'Generation failed.'); return; }

    $('output').value = d.demand || '';
    updateWordCount();

    const warns = [];
    if (d.scannedWarnings && d.scannedWarnings.length) {
      warns.push(`⚠ These files appear to be scanned images with no readable text — the demand may be missing their content: ${d.scannedWarnings.join(', ')}`);
    }
    if (d.truncated) warns.push(`⚠ Inputs exceeded the context window and were trimmed: ${d.truncationNote}`);
    if (warns.length) $('warnings').innerHTML = warns.map((w) => `<div class="warn">${escapeHtml(w)}</div>`).join('');

    $('gen-status').textContent = 'Done.';
  } catch (e) {
    clearTimeout(stage);
    if (e.message !== 'auth') showError(e.name === 'AbortError' ? 'Timed out after 5 minutes.' : 'Network error.');
  } finally {
    refreshGenerateEnabled();
  }
}

function showError(msg) {
  $('gen-status').textContent = '';
  $('warnings').innerHTML = `<div class="err">${escapeHtml(msg)}</div>`;
}

// ---- output tools --------------------------------------------------------
$('output').addEventListener('input', updateWordCount);
function updateWordCount() {
  const t = $('output').value.trim();
  const n = t ? t.split(/\s+/).length : 0;
  $('wordcount').textContent = n + (n === 1 ? ' word' : ' words');
}

$('copy-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('output').value); $('copy-btn').textContent = 'Copied'; setTimeout(() => ($('copy-btn').textContent = 'Copy'), 1500); }
  catch { $('copy-btn').textContent = 'Copy failed'; setTimeout(() => ($('copy-btn').textContent = 'Copy'), 1500); }
});

// warn before losing unsaved output
window.addEventListener('beforeunload', (e) => {
  if ($('output').value.trim()) { e.preventDefault(); e.returnValue = ''; }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- init ----------------------------------------------------------------
checkSession();
