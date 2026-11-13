// Wires the page together: form, effort picker, progress, results, history.

import { EFFORT } from './config.js';
import { runSearch } from './search.js';
import * as ui from './ui.js';

const { $ } = ui;
const HISTORY_KEY = 'oid-history';

let controller = null;     // AbortController for the running search
let lastResult = null;     // kept for the Copy buttons
let wakeLock = null;

// ---------- Effort picker ----------

function currentEffort() {
  return document.querySelector('input[name="effort"]:checked')?.value || 'medium';
}

function setEffort(value) {
  const input = document.querySelector(`input[name="effort"][value="${value}"]`);
  if (input) input.checked = true;
  $('effort-desc').textContent = EFFORT[currentEffort()].description;
}

document.querySelectorAll('input[name="effort"]').forEach(input =>
  input.addEventListener('change', () => setEffort(input.value)));

// ---------- History (stored on this phone only) ----------

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

function addToHistory(query, effort) {
  const list = loadHistory().filter(h => !(h.q === query && h.effort === effort));
  list.unshift({ q: query, effort, t: Date.now() });
  saveHistory(list.slice(0, 15));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  $('history-wrap').hidden = !list.length;
  $('history').replaceChildren(...list.map(h => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const q = document.createElement('span');
    q.textContent = h.q;
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = EFFORT[h.effort]?.label || h.effort;
    btn.append(q, meta);
    btn.addEventListener('click', () => startSearch(h.q, h.effort));
    li.append(btn);
    return li;
  }));
}

$('clear-history').addEventListener('click', () => { saveHistory([]); renderHistory(); });

// ---------- Keep the screen awake during long searches ----------

async function holdWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

// ---------- Search ----------

function setBusy(busy) {
  $('go').disabled = busy;
  $('go').textContent = busy ? 'Searching…' : 'Search';
  $('stop').hidden = !busy;
  document.querySelectorAll('input[name="effort"]').forEach(i => { i.disabled = busy; });
}

async function startSearch(query, effort) {
  query = query.trim();
  if (!query) return;
  if (controller) controller.abort();

  $('q').value = query;
  setEffort(effort);
  const url = new URL(location.href);
  url.searchParams.set('q', query);
  url.searchParams.set('effort', effort);
  history.replaceState(null, '', url);

  controller = new AbortController();
  const { signal } = controller;
  setBusy(true);
  holdWakeLock();
  $('results').hidden = true;
  $('progress').hidden = false;
  $('log').replaceChildren();
  $('bar-fill').style.width = '0%';

  try {
    const result = await runSearch(query, effort, {
      signal,
      onLog: (text, ok) => ui.logLine($('log'), text, ok),
      onProgress: (fraction, status) => {
        $('bar-fill').style.width = `${Math.round(fraction * 100)}%`;
        $('status').textContent = status;
      },
    });
    lastResult = result;
    showResults(result);
    addToHistory(query, effort);
    $('progress').hidden = true;
  } catch (err) {
    $('status').textContent = signal.aborted ? 'Stopped.' : `Something went wrong: ${err.message}`;
  } finally {
    if (controller?.signal === signal) controller = null;
    setBusy(false);
    releaseWakeLock();
  }
}

function showResults(result) {
  ui.renderStats($('stats'), result.stats, EFFORT[result.effort].label);
  ui.renderSummary($('summary'), result.summary);

  $('report-card').hidden = !result.report;
  if (result.report) ui.renderReport($('report'), result.report);

  $('terms-card').hidden = !result.keywords.length;
  ui.renderTerms($('terms'), result.keywords, term => startSearch(term, currentEffort()));

  $('source-count').textContent = `(${result.results.length})`;
  ui.renderSources($('sources'), result.results);

  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('search-form').addEventListener('submit', e => {
  e.preventDefault();
  $('q').blur();   // close the phone keyboard
  startSearch($('q').value, currentEffort());
});

$('stop').addEventListener('click', () => controller?.abort());

document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
  if (!lastResult) return;
  const text = btn.dataset.copy === 'report'
    ? ui.reportToText(lastResult.report || [], lastResult.results)
    : ui.summaryToText(lastResult.summary, lastResult.results);
  const ok = await ui.copyText(text);
  const label = btn.textContent;
  btn.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.textContent = label; }, 1500);
}));

// ---------- Start-up: support links like ?q=northern+lights&effort=high ----------

const params = new URLSearchParams(location.search);
setEffort(EFFORT[params.get('effort')] ? params.get('effort') : 'medium');
renderHistory();
if (params.get('q')) startSearch(params.get('q'), currentEffort());
