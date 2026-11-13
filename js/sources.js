// Source adapters. Each one takes (query, ctx) and returns an array of results:
//   { source, title, url, snippet, text, date?, weight, noRead? }
// ctx = { signal, limit, lang?, fullText? }
// All sources are free and need no API key.

import { getJSON, jsonp, fetchTextViaProxy } from './net.js';
import { enc, stripHtml, cleanWhitespace, parseXml, isHttpUrl } from './text.js';
import { MAX_TEXT_PER_PAGE } from './config.js';

const clip = s => (s || '').slice(0, MAX_TEXT_PER_PAGE);

// ---------- Wikipedia (any language) ----------
export async function wikipedia(query, ctx) {
  const lang = ctx.lang || 'en';
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const search = await getJSON(
    `${base}?action=query&list=search&srsearch=${enc(query)}&srlimit=${ctx.limit}&format=json&origin=*`, ctx);
  const hits = search?.query?.search || [];
  if (!hits.length) return [];

  // Intro text for every hit in one request.
  const titles = hits.map(h => h.title);
  const intro = await getJSON(
    `${base}?action=query&prop=extracts&exintro=1&explaintext=1&exlimit=max&titles=${enc(titles.join('|'))}&format=json&origin=*`, ctx);
  const extracts = new Map(Object.values(intro?.query?.pages || {}).map(p => [p.title, p.extract || '']));

  const results = hits.map((h, i) => ({
    source: `Wikipedia (${lang})`,
    title: h.title,
    url: `https://${lang}.wikipedia.org/wiki/${enc(h.title.replace(/ /g, '_'))}`,
    snippet: stripHtml(h.snippet),
    text: extracts.get(h.title) || '',
    weight: i === 0 ? 1.35 : 1.15,
    noRead: true,
  }));

  // Full article text for the top hits on higher effort levels.
  const fullCount = Math.min(ctx.fullText || 0, results.length);
  await Promise.all(results.slice(0, fullCount).map(async r => {
    try {
      const full = await getJSON(
        `${base}?action=query&prop=extracts&explaintext=1&titles=${enc(r.title)}&format=json&origin=*`, ctx);
      const page = Object.values(full?.query?.pages || {})[0];
      if (page?.extract) r.text = clip(page.extract.replace(/^=+.*=+$/gm, ''));
    } catch { /* keep the intro */ }
  }));
  return results;
}

// ---------- DuckDuckGo Instant Answers (JSONP) ----------
export async function ddg(query, ctx) {
  const d = await jsonp(
    `https://api.duckduckgo.com/?q=${enc(query)}&format=json&no_html=1&skip_disambig=1&t=onlineinfodevice`, ctx);
  const out = [];
  if (d.AbstractText) {
    out.push({
      source: `DuckDuckGo${d.AbstractSource ? ` / ${d.AbstractSource}` : ''}`,
      title: d.Heading || query, url: d.AbstractURL, snippet: d.AbstractText, text: d.AbstractText, weight: 1.35,
      noRead: true,
    });
  }
  if (d.Answer && typeof d.Answer === 'string') {
    out.push({ source: 'DuckDuckGo answer', title: d.Heading || query, url: d.AbstractURL || '',
      snippet: d.Answer, text: d.Answer, weight: 1.3, noRead: true });
  }
  if (d.Definition) {
    out.push({ source: `DuckDuckGo / ${d.DefinitionSource || 'definition'}`, title: `Definition: ${query}`,
      url: d.DefinitionURL, snippet: d.Definition, text: d.Definition, weight: 1.3, noRead: true });
  }
  const topics = (d.RelatedTopics || []).flatMap(t => (t.Topics ? t.Topics : [t]));
  for (const t of topics.slice(0, ctx.limit)) {
    if (!t.Text || !t.FirstURL) continue;
    out.push({ source: 'DuckDuckGo related', title: t.Text.split(' - ')[0], url: t.FirstURL,
      snippet: t.Text, text: t.Text, weight: 0.8, noRead: true });
  }
  return out;
}

// ---------- Wikidata ----------
export async function wikidata(query, ctx) {
  const d = await getJSON(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${enc(query)}&language=en&uselang=en&limit=${Math.min(ctx.limit, 20)}&format=json&origin=*`, ctx);
  return (d.search || []).map(e => ({
    source: 'Wikidata',
    title: e.label || e.id,
    url: e.concepturi || `https://www.wikidata.org/wiki/${e.id}`,
    snippet: e.description || '',
    text: e.description ? `${(e.label || '').replace(/^./, c => c.toUpperCase())} is ${e.description}.` : '',
    weight: 0.7,
    noRead: true,
  }));
}

// ---------- Hacker News (Algolia) ----------
export async function hackernews(query, ctx) {
  const d = await getJSON(
    `https://hn.algolia.com/api/v1/search?query=${enc(query)}&tags=story&hitsPerPage=${ctx.limit}`, ctx);
  return (d.hits || []).map(h => ({
    source: 'Hacker News',
    title: h.title || '(untitled)',
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments`,
    text: stripHtml(h.story_text || ''),
    date: h.created_at,
    weight: 0.8,
  }));
}

// ---------- Stack Exchange (Stack Overflow) ----------
export async function stackexchange(query, ctx) {
  const d = await getJSON(
    `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${enc(query)}&site=stackoverflow&pagesize=${ctx.limit}`, ctx);
  return (d.items || []).map(it => ({
    source: 'Stack Overflow',
    title: stripHtml(it.title),
    url: `https://stackoverflow.com/q/${it.question_id}`,
    snippet: stripHtml(it.excerpt),
    text: stripHtml(it.body || it.excerpt),
    date: it.creation_date ? new Date(it.creation_date * 1000).toISOString() : undefined,
    weight: 0.75,
  }));
}

// ---------- Reddit ----------
export async function reddit(query, ctx) {
  const d = await getJSON(
    `https://www.reddit.com/search.json?q=${enc(query)}&limit=${ctx.limit}&sort=relevance&raw_json=1`, ctx);
  return (d?.data?.children || []).map(c => c.data).filter(p => !p.over_18).map(p => ({
    source: `Reddit r/${p.subreddit}`,
    title: p.title,
    url: `https://www.reddit.com${p.permalink}`,
    snippet: cleanWhitespace(p.selftext).slice(0, 300),
    text: clip(cleanWhitespace(p.selftext)),
    date: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : undefined,
    weight: 0.6,
    noRead: true,
  }));
}

// ---------- Crossref (research papers) ----------
export async function crossref(query, ctx) {
  const d = await getJSON(
    `https://api.crossref.org/works?query=${enc(query)}&rows=${ctx.limit}&select=title,abstract,URL,published,container-title`, ctx);
  return (d?.message?.items || []).map(w => {
    const abstract = stripHtml(w.abstract || '');
    const year = w.published?.['date-parts']?.[0]?.[0];
    return {
      source: 'Crossref',
      title: (w.title || ['(untitled)'])[0],
      url: w.URL,
      snippet: [w['container-title']?.[0], year].filter(Boolean).join(', '),
      text: abstract,
      date: year ? `${year}` : undefined,
      weight: 0.8,
      noRead: !abstract,
    };
  });
}

// ---------- Open Library (books) ----------
export async function openlibrary(query, ctx) {
  const d = await getJSON(
    `https://openlibrary.org/search.json?q=${enc(query)}&limit=${ctx.limit}&fields=title,author_name,first_publish_year,key,first_sentence`, ctx);
  return (d.docs || []).map(b => {
    const firstSentence = Array.isArray(b.first_sentence) ? b.first_sentence[0] : '';
    return {
      source: 'Open Library',
      title: b.title,
      url: `https://openlibrary.org${b.key}`,
      snippet: [b.author_name?.slice(0, 3).join(', '), b.first_publish_year].filter(Boolean).join(', '),
      text: firstSentence || '',
      weight: 0.5,
      noRead: true,
    };
  });
}

// ---------- GitHub repositories ----------
export async function github(query, ctx) {
  const d = await getJSON(
    `https://api.github.com/search/repositories?q=${enc(query)}&per_page=${Math.min(ctx.limit, 30)}`, ctx);
  return (d.items || []).map(r => ({
    source: 'GitHub',
    title: `${r.full_name} (★ ${r.stargazers_count})`,
    url: r.html_url,
    snippet: r.description || '',
    text: r.description || '',
    date: r.pushed_at,
    weight: 0.5,
    noRead: true,
  }));
}

// ---------- arXiv (via CORS proxy) ----------
export async function arxiv(query, ctx) {
  const xml = await fetchTextViaProxy(
    `https://export.arxiv.org/api/query?search_query=all:${enc(query)}&start=0&max_results=${ctx.limit}`, ctx);
  const doc = parseXml(xml);
  return [...doc.getElementsByTagName('entry')].map(e => {
    const get = tag => cleanWhitespace(e.getElementsByTagName(tag)[0]?.textContent);
    return {
      source: 'arXiv',
      title: get('title'),
      url: get('id'),
      snippet: get('published').slice(0, 10),
      text: get('summary'),
      date: get('published'),
      weight: 0.8,
      noRead: true,
    };
  });
}

// ---------- News: Google News RSS + Bing News RSS (via CORS proxy) ----------
function parseRssItems(xml) {
  const doc = parseXml(xml);
  return [...doc.getElementsByTagName('item')].map(item => {
    const get = tag => cleanWhitespace(item.getElementsByTagName(tag)[0]?.textContent);
    return { title: get('title'), link: get('link'), date: get('pubDate'), description: stripHtml(get('description')),
      source: get('source') };
  });
}

export async function googleNews(query, ctx) {
  const xml = await fetchTextViaProxy(
    `https://news.google.com/rss/search?q=${enc(query)}&hl=en-US&gl=US&ceid=US:en`, ctx);
  return parseRssItems(xml).slice(0, ctx.limit).map(it => ({
    source: `Google News${it.source ? ` / ${it.source}` : ''}`,
    title: it.title,
    url: it.link,
    snippet: it.date ? new Date(it.date).toDateString() : '',
    text: '',
    date: it.date ? new Date(it.date).toISOString() : undefined,
    weight: 0.7,
    noRead: true,  // Google News links redirect through JavaScript and can't be read
  }));
}

function unwrapBingNewsLink(link) {
  try {
    const u = new URL(link);
    const direct = u.searchParams.get('url');
    return direct && isHttpUrl(direct) ? direct : link;
  } catch {
    return link;
  }
}

export async function bingNews(query, ctx) {
  const xml = await fetchTextViaProxy(
    `https://www.bing.com/news/search?q=${enc(query)}&format=rss&setlang=en`, ctx);
  return parseRssItems(xml).slice(0, ctx.limit).map(it => ({
    source: 'Bing News',
    title: it.title,
    url: unwrapBingNewsLink(it.link),
    snippet: it.description,
    text: it.description,
    date: it.date ? new Date(it.date).toISOString() : undefined,
    weight: 0.85,
  }));
}
