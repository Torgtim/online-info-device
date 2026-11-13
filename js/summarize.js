// Extractive summarizer. No AI service needed: it splits every page into
// sentences, scores them by how central their words are across all sources
// (and how well they match the query), then picks the best non-repeating ones.
// Pure functions, no DOM, so it also runs in Node for testing.

const STOPWORDS = new Set((
  // English
  'a about above after again against all also am an and any are aren as at be because been before being below ' +
  'between both but by can cannot could did do does doing down during each few for from further get gets got had ' +
  'has have having he her here hers herself him himself his how however i if in into is it its itself just like ' +
  'may me might more most much must my myself new no nor not now of off on once one only or other our ours ' +
  'ourselves out over own per same she should so some such than that the their theirs them themselves then there ' +
  'these they this those through to too under until up upon us use used using very via was we well were what when ' +
  'where which while who whom why will with within without would yet you your yours yourself yourselves ' +
  'said says also include including includes many first two three year years since made make makes known ' +
  'www http https com html page pages click read more cookie cookies privacy policy terms ' +
  // Norwegian
  'og i jeg det at en et den til er som på de med han av ikke der så var meg seg men ett har om vi min mitt ha ' +
  'hadde hun nå over da ved fra du ut sin dem oss opp man kan hans hvor eller hva skal selv sjøl her alle vil bli ' +
  'ble blitt kunne inn når være kom noen noe ville dere deg mot også bare være vært mange nei ja enn eller hvis ' +
  'etter før under mellom denne dette disse sine sitt sin hennes deres våre vår vårt blir får fikk'
).split(/\s+/));

const JUNK = /(cookie|javascript|sign in|log in|logg inn|subscribe|newsletter|all rights reserved|privacy policy|click here|accept all|terms of (use|service)|captcha|enable js|your browser)/i;

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  let parts;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    parts = [...seg.segment(clean)].map(s => s.segment.trim());
  } else {
    parts = clean.split(/(?<=[.!?])\s+(?=[A-ZÆØÅ0-9"“(])/);
  }
  return parts.filter(s => {
    const words = s.split(' ').length;
    if (words < 6 || words > 70) return false;
    if (JUNK.test(s)) return false;
    const letters = (s.match(/\p{L}/gu) || []).length;
    return letters / s.length > 0.6;
  });
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/**
 * Builds the sentence index and term weights for a set of documents.
 * docs: [{ text, snippet, weight }] (index = source number - 1)
 */
export function analyze(docs, query) {
  const queryTokens = new Set(tokenize(query));
  const sentences = [];
  const docFreq = new Map();   // in how many documents a term appears
  const termFreq = new Map();  // how often a term appears overall

  docs.forEach((doc, docIndex) => {
    const snip = doc.snippet || '';
    const txt = doc.text || '';
    // Use the full text; only add the snippet when it says something the text doesn't.
    const body = !snip || txt.includes(snip) || txt.length > 3 * snip.length
      ? txt
      : `${snip.replace(/[.!?…]*$/, '.')} ${txt}`;
    const seen = new Set();
    splitSentences(body).slice(0, 250).forEach((text, pos) => {
      const toks = tokenize(text);
      if (toks.length < 3) return;
      toks.forEach(t => { termFreq.set(t, (termFreq.get(t) || 0) + 1); seen.add(t); });
      sentences.push({ text, doc: docIndex, pos, toks, set: new Set(toks), used: false });
    });
    seen.forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1));
  });

  // Terms used often AND by many different sources score highest:
  // that's what the sources agree the topic is about.
  const termWeight = t => Math.log(1 + (termFreq.get(t) || 0)) * (1 + Math.log(docFreq.get(t) || 1));

  for (const s of sentences) {
    let sum = 0;
    for (const t of s.set) sum += termWeight(t);
    const central = sum / Math.sqrt(s.set.size);
    let qHits = 0;
    for (const t of queryTokens) if (s.set.has(t)) qHits++;
    const qCoverage = queryTokens.size ? qHits / queryTokens.size : 0;
    const docWeight = docs[s.doc].weight ?? 1;
    const positionBonus = 1 + 0.3 / (1 + s.pos);
    const endsWell = /[.!?]["”')]?$/.test(s.text) ? 1 : 0.8;
    s.score = central * (1 + qCoverage) * docWeight * positionBonus * endsWell;
  }

  const keywords = [...termFreq.keys()]
    .filter(t => !queryTokens.has(t) && (docFreq.get(t) || 0) >= 2 && t.length > 3)
    .sort((a, b) => termWeight(b) - termWeight(a))
    .slice(0, 18);

  return { sentences, keywords, queryTokens, docCount: docs.length };
}

/**
 * Picks up to `count` high-scoring sentences that don't repeat each other.
 * Marks picked sentences as used so later sections don't repeat them.
 */
export function pickSentences(candidates, count, { maxPerDoc = 2, maxSimilarity = 0.45 } = {}) {
  const chosen = [];
  const perDoc = new Map();
  for (const s of [...candidates].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= count) break;
    if (s.used) continue;
    if ((perDoc.get(s.doc) || 0) >= maxPerDoc) continue;
    if (chosen.some(c => jaccard(c.set, s.set) > maxSimilarity)) continue;
    chosen.push(s);
    perDoc.set(s.doc, (perDoc.get(s.doc) || 0) + 1);
  }
  chosen.forEach(s => { s.used = true; });
  return chosen;
}

const asItem = s => ({ text: s.text, ref: s.doc });

export function buildSummary(analysis, count) {
  return pickSentences(analysis.sentences, count, { maxPerDoc: 2 }).map(asItem);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Long report for High effort. Returns sections:
 *   [{ heading, paragraphs: [[{ text, ref }]], list?: [{ text, ref }] }]
 */
export function buildLongReport(analysis, docs) {
  const sections = [];

  const overview = pickSentences(analysis.sentences, 12, { maxPerDoc: 3 }).map(asItem);
  if (overview.length) sections.push({ heading: 'Overview', paragraphs: chunk(overview, 3) });

  // One section per main theme (top keywords the sources share).
  for (const kw of analysis.keywords.slice(0, 7)) {
    const pool = analysis.sentences.filter(s => s.set.has(kw));
    const picked = pickSentences(pool, 4, { maxPerDoc: 2 }).map(asItem);
    if (picked.length >= 2) {
      sections.push({ heading: `About “${kw}”`, paragraphs: chunk(picked, 2) });
    }
  }

  // What the most relevant individual sources say.
  const bySource = [];
  const docsWithText = docs
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => analysis.sentences.some(s => s.doc === i && !s.used))
    .slice(0, 15);
  for (const { d, i } of docsWithText) {
    const pool = analysis.sentences.filter(s => s.doc === i);
    const picked = pickSentences(pool, 3, { maxPerDoc: 3 }).map(asItem);
    if (picked.length) bySource.push({ heading: d.title, ref: i, paragraphs: [picked] });
  }
  if (bySource.length) {
    sections.push({ heading: 'What the sources say', subsections: bySource });
  }

  // Latest dated items (news, discussions, papers).
  const dated = docs
    .map((d, i) => ({ d, i, t: Date.parse(d.date || '') }))
    .filter(x => !Number.isNaN(x.t))
    .sort((a, b) => b.t - a.t)
    .slice(0, 10);
  if (dated.length) {
    sections.push({
      heading: 'Latest',
      list: dated.map(({ d, i, t }) => ({ text: `${new Date(t).toISOString().slice(0, 10)}: ${d.title}`, ref: i })),
    });
  }

  return sections;
}
