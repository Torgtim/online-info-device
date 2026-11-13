// Effort profiles. Each level decides how many sources, search engines,
// query variations and full-page reads the device uses.

export const EFFORT = {
  low: {
    label: 'Low',
    description: 'Quick search of a few reliable sources, then a short summary. About 5 seconds.',
    sources: ['wikipedia', 'ddg'],
    wikiLangs: ['en'],
    perSource: 3,
    engines: [],            // no general web search
    queryVariants: 1,
    readPages: 0,           // no full-page reading
    wikiFullText: 0,
    summarySentences: 4,
    longReport: false,
    concurrency: 4,
  },
  medium: {
    label: 'Medium',
    description: 'Searches the web like a normal search engine and reads the top pages it finds. About 20–40 seconds.',
    sources: ['wikipedia', 'ddg', 'web', 'news', 'wikidata', 'hackernews', 'stackexchange', 'reddit'],
    wikiLangs: ['en', 'no'],
    perSource: 8,
    engines: ['ddg', 'bing'],
    queryVariants: 1,
    readPages: 8,
    wikiFullText: 1,
    summarySentences: 7,
    longReport: false,
    concurrency: 6,
  },
  high: {
    label: 'High',
    description: 'Searches everywhere it can, as hard as it can: every source, three search engines, several query variations, and reads as many pages as possible. Long report plus summary. About 1–3 minutes.',
    sources: ['wikipedia', 'ddg', 'web', 'news', 'wikidata', 'hackernews', 'stackexchange',
      'reddit', 'crossref', 'openlibrary', 'github', 'arxiv'],
    wikiLangs: ['en', 'no'],
    perSource: 15,
    engines: ['ddg', 'bing', 'mojeek'],
    queryVariants: 4,
    readPages: 30,
    wikiFullText: 3,
    summarySentences: 10,
    longReport: true,
    concurrency: 8,
  },
};

// Extra phrasings used for web and news searches on higher effort levels.
const VARIANT_SUFFIXES = ['', 'explained', 'latest news', 'facts', 'history', 'review'];

export function buildQueries(query, count) {
  return VARIANT_SUFFIXES.slice(0, Math.max(1, count))
    .map(suffix => (suffix ? `${query} ${suffix}` : query));
}

// Sources that get the extra query variations (the rest only get the main query).
export const VARIANT_SOURCES = new Set(['web', 'news']);

// Max characters kept from any single page, to keep analysis fast on phones.
export const MAX_TEXT_PER_PAGE = 30000;
