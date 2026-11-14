# Online Info Device

A mobile-friendly web page that searches many free public sources at once and summarizes what it finds.
It runs entirely in the browser on GitHub Pages: no server, no accounts, no API keys, no cost.

**Live:** https://torgtim.github.io/online-info-device/

Tip: open it on your phone and use "Add to Home Screen" to get it as an app icon.

## Effort levels

| Level  | What it does | Output | Time |
|--------|--------------|--------|------|
| Low    | Wikipedia + DuckDuckGo instant answers | Short summary | ~5 s |
| Medium | Adds web search (DuckDuckGo + Bing), news, Wikidata, Hacker News, Stack Overflow, Reddit, and reads the top 8 pages in full | Summary + key terms | ~20–40 s |
| High   | Every source, 3 search engines (+ Mojeek), 4 query variations, Crossref, Open Library, GitHub, arXiv, reads up to 30 pages, full Wikipedia articles | Long report + summary | ~1–3 min |

## Summary length

Chosen separately from effort: **Short** (3 sentences), **Medium** (7), **Long** (12 plus a sectioned report).
Effort picks a sensible default, and you can override it.

## Names and questions

Question words ("how old is", "hvor gammel er") are stripped before sources are searched. For person names, only pages
containing the whole name are used, and the page warns when nothing matches or the name may be shared by several people.
"How old is ..." answers are read from a matching Wikipedia article's birth date, with that caveat.

## Reverse image search

Paste a picture link to get ready-made searches in Google Lens, Bing Visual Search, TinEye and Yandex, or open one of
their upload pages for a photo from your phone. (A static page cannot run an image index itself.)

## How it works

1. **Search**: asks every source for the effort level in parallel (`js/sources.js`, `js/webSearch.js`).
   Web search engines are read through free public CORS proxies and their result pages are parsed.
2. **Merge and rank**: the same page found by several sources is merged and ranked higher (`js/search.js`).
3. **Read**: the best pages are read in full with the free Jina Reader, falling back to a proxy plus local text extraction (`js/reader.js`).
4. **Summarize**: an extractive summarizer splits everything into sentences, scores them by how central their words are across
   all sources and how well they match the query, then picks the best non-repeating ones (`js/summarize.js`).
   Every sentence is cited back to its source.

Sources that are slow, rate-limited or blocked at the moment are skipped automatically (see "Show log").

You can link straight to a search: `?q=northern+lights&effort=high`.

## Files

```
index.html            page
css/style.css         plain, mobile-first styles (light + dark)
js/config.js          effort profiles and summary lengths
js/query.js           question parsing, name detection, birth dates
js/imageSearch.js     reverse image search links
js/net.js             fetch with timeout, JSONP, CORS proxies, concurrency pool
js/text.js            text/URL helpers
js/sources.js         one adapter per free API
js/webSearch.js       DuckDuckGo / Bing / Mojeek result-page parsers
js/reader.js          full-page reader
js/summarize.js       sentence scoring, summary and long report
js/search.js          the pipeline
js/ui.js              rendering
js/app.js             wiring, history, URL parameters
```
