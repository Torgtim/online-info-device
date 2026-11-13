// General web search: fetches the HTML result pages of free search engines
// through CORS proxies and parses the result links out of them.

import { fetchTextViaProxy } from './net.js';
import { enc, cleanWhitespace, parseHtml, isHttpUrl, hostOf, decodeBase64Url } from './text.js';

// Domains we never want as "results" (the search engines themselves, ad redirects).
const BLOCKED_HOSTS = /(^|\.)(duckduckgo\.com|bing\.com|mojeek\.com|google\.com)$/;

function decodeDdgLink(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    return u.searchParams.get('uddg') || u.href;
  } catch {
    return '';
  }
}

function decodeBingLink(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const raw = u.searchParams.get('u') || '';
      return raw.startsWith('a1') ? decodeBase64Url(raw.slice(2)) : '';
    }
    return u.href;
  } catch {
    return '';
  }
}

export const ENGINES = {
  ddg: {
    label: 'DuckDuckGo Web',
    url: q => `https://html.duckduckgo.com/html/?q=${enc(q)}`,
    parse(doc) {
      return [...doc.querySelectorAll('.result')]
        .filter(r => !r.classList.contains('result--ad'))
        .map(r => {
          const a = r.querySelector('a.result__a');
          if (!a) return null;
          return {
            title: cleanWhitespace(a.textContent),
            url: decodeDdgLink(a.getAttribute('href')),
            snippet: cleanWhitespace(r.querySelector('.result__snippet')?.textContent),
          };
        });
    },
  },
  bing: {
    label: 'Bing Web',
    url: q => `https://www.bing.com/search?q=${enc(q)}&count=30&setlang=en`,
    parse(doc) {
      return [...doc.querySelectorAll('li.b_algo')].map(li => {
        const a = li.querySelector('h2 a');
        if (!a) return null;
        const snip = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p');
        return {
          title: cleanWhitespace(a.textContent),
          url: decodeBingLink(a.getAttribute('href')),
          snippet: cleanWhitespace(snip?.textContent),
        };
      });
    },
  },
  mojeek: {
    label: 'Mojeek Web',
    url: q => `https://www.mojeek.com/search?q=${enc(q)}`,
    parse(doc) {
      return [...doc.querySelectorAll('ul.results-standard > li')].map(li => {
        const a = li.querySelector('h2 a, a.title, a.ob');
        if (!a) return null;
        return {
          title: cleanWhitespace(a.textContent),
          url: a.getAttribute('href'),
          snippet: cleanWhitespace(li.querySelector('p.s')?.textContent),
        };
      });
    },
  },
};

// Parses an engine's result page HTML into clean results. Exported for testing.
export function parseEngineHtml(engineId, html) {
  const engine = ENGINES[engineId];
  return engine.parse(parseHtml(html))
    .filter(r => r && r.title && isHttpUrl(r.url) && !BLOCKED_HOSTS.test(hostOf(r.url)));
}

export async function searchEngine(engineId, query, ctx) {
  const engine = ENGINES[engineId];
  const html = await fetchTextViaProxy(engine.url(query), ctx);
  const results = parseEngineHtml(engineId, html);
  if (!results.length) throw new Error('No results (engine may be blocking the proxy)');
  return results.slice(0, ctx.limit).map((r, i) => ({
    source: engine.label,
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    text: r.snippet,
    weight: 1.0 - Math.min(i, 10) * 0.03,   // engines' own ranking matters a bit
  }));
}
