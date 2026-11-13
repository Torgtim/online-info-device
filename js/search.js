// The search pipeline: query every source, merge duplicates, rank,
// read full pages, then analyze and summarize.

import { EFFORT, buildQueries, VARIANT_SOURCES } from './config.js';
import { runPool } from './net.js';
import { urlKey, hostOf } from './text.js';
import * as S from './sources.js';
import { ENGINES, searchEngine } from './webSearch.js';
import { readPage, canRead } from './reader.js';
import { analyze, buildSummary, buildLongReport, tokenize } from './summarize.js';

// Maps the source ids used in config.js to one or more concrete tasks.
function expandSource(id, query, profile) {
  switch (id) {
    case 'wikipedia':
      return wikiLanguages(profile).map(lang => ({
        label: `Wikipedia (${lang})`,
        run: ctx => S.wikipedia(query, { ...ctx, lang, fullText: profile.wikiFullText }),
      }));
    case 'web':
      return profile.engines.map(engine => ({
        label: ENGINES[engine].label,
        run: ctx => searchEngine(engine, query, ctx),
      }));
    case 'news':
      return [
        { label: 'Google News', run: ctx => S.googleNews(query, ctx) },
        { label: 'Bing News', run: ctx => S.bingNews(query, ctx) },
      ];
    default: {
      const labels = { ddg: 'DuckDuckGo Instant', wikidata: 'Wikidata', hackernews: 'Hacker News',
        stackexchange: 'Stack Overflow', reddit: 'Reddit', crossref: 'Crossref', openlibrary: 'Open Library',
        github: 'GitHub', arxiv: 'arXiv' };
      return [{ label: labels[id] || id, run: ctx => S[id](query, ctx) }];
    }
  }
}

// Profile languages plus the phone's own language (e.g. Norwegian), no duplicates.
function wikiLanguages(profile) {
  const langs = new Set(profile.wikiLangs);
  const browser = (globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
  const mapped = { nb: 'no', nn: 'nn' }[browser] || browser;
  if (profile.queryVariants > 1 && /^[a-z]{2}$/.test(mapped)) langs.add(mapped);
  return [...langs];
}

function buildTasks(query, profile) {
  const variants = buildQueries(query, profile.queryVariants);
  const tasks = [];
  for (const id of profile.sources) {
    const queries = VARIANT_SOURCES.has(id) ? variants : [query];
    for (const q of queries) {
      for (const t of expandSource(id, q, profile)) {
        tasks.push({ ...t, label: q === query ? t.label : `${t.label}: “${q}”` });
      }
    }
  }
  return tasks;
}

// Merges results that point at the same page, keeping the richest text.
function mergeResults(all) {
  const byKey = new Map();
  const loose = [];
  for (const r of all) {
    const key = r.url ? urlKey(r.url) : '';
    if (!key) { loose.push(r); continue; }
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...r, sources: [r.source] }); continue; }
    if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
    if ((r.text || '').length > (prev.text || '').length) prev.text = r.text;
    if ((r.snippet || '').length > (prev.snippet || '').length) prev.snippet = r.snippet;
    prev.weight = Math.max(prev.weight, r.weight) + 0.1;   // found by several sources = more relevant
    prev.date = prev.date || r.date;
    prev.noRead = prev.noRead && r.noRead;
  }
  return [...byKey.values(), ...loose.map(r => ({ ...r, sources: [r.source] }))];
}

function relevance(r, queryTokens) {
  const titleToks = new Set(tokenize(r.title));
  const snipToks = new Set(tokenize(`${r.snippet} ${(r.text || '').slice(0, 500)}`));
  let hits = 0;
  for (const t of queryTokens) {
    if (titleToks.has(t)) hits += 2;
    else if (snipToks.has(t)) hits += 1;
  }
  const coverage = queryTokens.size ? hits / (2 * queryTokens.size) : 0.5;
  return (0.4 + coverage) * (r.weight ?? 1);
}

/**
 * Runs a full search.
 * hooks: { signal, onLog(text, ok), onProgress(fraction, status) }
 */
export async function runSearch(query, effortKey, hooks = {}) {
  const { signal, onLog = () => {}, onProgress = () => {} } = hooks;
  const profile = EFFORT[effortKey] || EFFORT.medium;
  const started = performance.now();
  const queryTokens = new Set(tokenize(query));

  // ---- Phase 1: ask every source ----
  const tasks = buildTasks(query, profile);
  let finished = 0;
  const stats = { sourcesOk: 0, sourcesFailed: 0, pagesRead: 0, pagesFailed: 0 };
  onProgress(0.02, `Searching ${tasks.length} sources…`);

  const taskResults = await runPool(tasks, profile.concurrency, async task => {
    try {
      const items = await task.run({ signal, limit: profile.perSource, timeout: 12000 });
      stats.sourcesOk++;
      onLog(`${task.label}: ${items.length} result${items.length === 1 ? '' : 's'}`, true);
      return items;
    } catch (err) {
      stats.sourcesFailed++;
      onLog(`${task.label}: skipped (${err.message})`, false);
      throw err;
    } finally {
      finished++;
      onProgress(0.02 + 0.48 * (finished / tasks.length), `Searched ${finished} of ${tasks.length} sources…`);
    }
  }, signal);
  if (signal?.aborted) throw new Error('Cancelled');

  const merged = mergeResults(taskResults.filter(r => r?.ok).flatMap(r => r.value))
    .filter(r => r.title || r.text);
  merged.forEach(r => { r.score = relevance(r, queryTokens); });
  merged.sort((a, b) => b.score - a.score);

  // ---- Phase 2: read full pages ----
  const toRead = merged
    .filter(r => !r.noRead && canRead(r.url) && (r.text || '').length < 1500)
    .slice(0, profile.readPages);

  if (toRead.length) {
    let read = 0;
    onProgress(0.5, `Reading ${toRead.length} pages…`);
    await runPool(toRead, 4, async r => {
      try {
        r.text = await readPage(r.url, { signal });
        r.fullyRead = true;
        stats.pagesRead++;
        onLog(`Read ${hostOf(r.url)} (${Math.round(r.text.length / 1000)}k chars)`, true);
      } catch (err) {
        stats.pagesFailed++;
        onLog(`Could not read ${hostOf(r.url)} (${err.message})`, false);
      } finally {
        read++;
        onProgress(0.5 + 0.4 * (read / toRead.length), `Read ${read} of ${toRead.length} pages…`);
      }
    }, signal);
    if (signal?.aborted) throw new Error('Cancelled');
    // Re-rank now that we have full text.
    merged.forEach(r => { r.score = relevance(r, queryTokens) * (r.fullyRead ? 1.1 : 1); });
    merged.sort((a, b) => b.score - a.score);
  }

  // ---- Phase 3: analyze ----
  onProgress(0.93, 'Analyzing and summarizing…');
  await new Promise(r => setTimeout(r, 0));   // let the UI paint before heavy work
  const analysis = analyze(merged, query);
  const summary = buildSummary(analysis, profile.summarySentences);
  const report = profile.longReport ? buildLongReport(analysis, merged) : null;

  onProgress(1, 'Done');
  return {
    query,
    effort: effortKey,
    results: merged,
    summary,
    report,
    keywords: profile.longReport || effortKey === 'medium' ? analysis.keywords : [],
    stats: {
      ...stats,
      tasks: tasks.length,
      results: merged.length,
      sentences: analysis.sentences.length,
      seconds: (performance.now() - started) / 1000,
    },
  };
}
