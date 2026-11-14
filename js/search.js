// The search pipeline: query every source, merge duplicates, rank,
// read full pages, then analyze and summarize.

import { EFFORT, LENGTH, buildQueries, VARIANT_SOURCES } from './config.js';
import { analyzeQuery, findBirthDate } from './query.js';
import { runPool } from './net.js';
import { urlKey, hostOf } from './text.js';
import * as S from './sources.js';
import { ENGINES, searchEngine } from './webSearch.js';
import { readPage, canRead } from './reader.js';
import { analyze, buildSummary, buildLongReport, tokenize } from './summarize.js';

// Maps the source ids used in config.js to one or more concrete tasks.
function expandSource(id, query, profile, qi) {
  switch (id) {
    case 'wikipedia':
      return wikiLanguages(profile, qi).map(lang => ({
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
function wikiLanguages(profile, qi) {
  const langs = new Set(profile.wikiLangs);
  if (qi.norwegian) langs.add('no');              // the question is in Norwegian
  const browser = (globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
  const mapped = { nb: 'no', nn: 'nn' }[browser] || browser;
  if (profile.queryVariants > 1 && /^[a-z]{2}$/.test(mapped)) langs.add(mapped);
  return [...langs];
}

function buildTasks(qi, profile) {
  // Entity sources get the cleaned topic ("Ola Nordmann"); web engines also get
  // the sentence as typed, plus variations of the topic on higher effort.
  const variants = buildQueries(qi.core, profile.queryVariants);
  const webQueries = [qi.original, ...variants.slice(1)];
  const tasks = [];
  for (const id of profile.sources) {
    const queries = VARIANT_SOURCES.has(id) ? webQueries : [qi.core];
    for (const q of queries) {
      for (const t of expandSource(id, q, profile, qi)) {
        tasks.push({ ...t, label: q === queries[0] ? t.label : `${t.label}: “${q}”` });
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
export async function runSearch(query, effortKey, lengthKey, hooks = {}) {
  const { signal, onLog = () => {}, onProgress = () => {} } = hooks;
  const profile = EFFORT[effortKey] || EFFORT.medium;
  const length = LENGTH[lengthKey] || LENGTH[profile.defaultLength];
  const qi = analyzeQuery(query);
  const started = performance.now();
  const queryTokens = new Set(tokenize(qi.core));

  // ---- Phase 1: ask every source ----
  const tasks = buildTasks(qi, profile);
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

  // ---- Phase 3: check the results really are about the query ----
  const coreTokens = [...queryTokens];
  for (const r of merged) {
    const hay = new Set(tokenize(`${r.title} ${r.snippet} ${r.text}`));
    const hits = coreTokens.filter(t => hay.has(t)).length;
    r.coverage = coreTokens.length ? hits / coreTokens.length : 1;
  }
  const strong = merged.filter(r => r.coverage === 1);
  let notice = '';
  let analysisDocs = merged;
  if (qi.looksLikeName) {
    // Names: only trust pages that contain every part of the name.
    analysisDocs = merged.map(r => (r.coverage === 1 ? r : { ...r, text: '', snippet: '' }));
    notice = !strong.length
      ? (qi.norwegian
        ? `Fant ingenting pålitelig om «${qi.core}». Privatpersoner står sjelden i åpne kilder, og treffene under kan handle om noen andre med lignende navn.`
        : `Found nothing reliable about “${qi.core}”. Private people rarely appear in open sources, and the results below may be about someone else with a similar name.`)
      : (qi.norwegian
        ? `Navnet «${qi.core}» kan tilhøre flere personer. Sjekk kildene før du antar at det er den du mener.`
        : `The name “${qi.core}” may belong to several people. Check the sources before assuming it is the one you mean.`);
  } else {
    analysisDocs = merged.map(r => ({ ...r, weight: (r.weight ?? 1) * (0.4 + 0.6 * r.coverage) }));
  }

  // ---- Phase 4: analyze ----
  onProgress(0.93, 'Analyzing and summarizing…');
  await new Promise(r => setTimeout(r, 0));   // let the UI paint before heavy work
  const analysis = analyze(analysisDocs, qi.core);
  const summary = buildSummary(analysis, length.sentences);
  const report = length.report ? buildLongReport(analysis, analysisDocs) : null;

  // Age questions: read a birth date from a Wikipedia article that matches the name.
  let quickAnswer = null;
  if (qi.isAge) {
    for (const [i, r] of merged.entries()) {
      if (r.coverage !== 1 || !/wikipedia/i.test((r.sources || [r.source]).join(' '))) continue;
      const born = findBirthDate(r.text);
      if (!born) continue;
      const when = born.month && born.day ? `${born.day}/${born.month}/${born.year}` : `${born.year}`;
      const age = born.deceased ? null : born.age;
      quickAnswer = {
        ref: i,
        text: qi.norwegian
          ? `Artikkelen «${r.title}» oppgir født ${when}${age != null ? `, altså ${born.approximate ? 'rundt ' : ''}${age} år` : ' (personen er død)'}. Dette gjelder bare hvis det er denne personen du mener.`
          : `The article “${r.title}” gives birth ${when}${age != null ? `, so about ${age} years old` : ' (the person has died)'}. This only applies if this is the person you mean.`,
      };
      break;
    }
  }

  onProgress(1, 'Done');
  return {
    query,
    effort: effortKey,
    length: lengthKey || profile.defaultLength,
    results: merged,
    summary,
    report,
    notice,
    quickAnswer,
    keywords: length.report || lengthKey === 'medium' ? analysis.keywords : [],
    stats: {
      ...stats,
      tasks: tasks.length,
      results: merged.length,
      sentences: analysis.sentences.length,
      seconds: (performance.now() - started) / 1000,
    },
  };
}
