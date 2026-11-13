// Full-page reader. Tries the free Jina Reader first (returns clean text),
// then falls back to fetching raw HTML through a CORS proxy and extracting
// the main text locally.

import { getText, fetchTextViaProxy } from './net.js';
import { cleanWhitespace, parseHtml } from './text.js';
import { MAX_TEXT_PER_PAGE } from './config.js';

const SKIP_EXTENSIONS = /\.(zip|rar|7z|exe|dmg|apk|mp3|mp4|mov|avi|jpg|jpeg|png|gif|webp|svg)(\?|$)/i;

export function canRead(url) {
  return !!url && !SKIP_EXTENSIONS.test(url);
}

// Turns Jina's markdown output into plain prose paragraphs. Exported for testing.
export function markdownToText(md) {
  const body = md.includes('Markdown Content:') ? md.split('Markdown Content:').slice(1).join(' ') : md;
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                 // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                // links -> text
    .replace(/<[^>]+>/g, ' ')                               // stray html
    .split('\n')
    .map(line => line.replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s*/, '').replace(/[*_`|]+/g, ' ').trim())
    .filter(line => line.split(' ').length >= 6)            // drop menus, buttons, short fragments
    .map(line => (/[.!?:]$/.test(line) ? line : `${line}.`))
    .join('\n');
}

// Extracts readable text from raw HTML. Exported for testing.
export function htmlToText(html) {
  const doc = parseHtml(html);
  doc.querySelectorAll('script, style, noscript, nav, header, footer, aside, form, iframe, svg, button, [aria-hidden="true"]')
    .forEach(el => el.remove());
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  if (!root) return '';
  const blocks = [...root.querySelectorAll('p, li, h2, h3, blockquote, td')]
    .map(el => cleanWhitespace(el.textContent))
    .filter(t => t.split(' ').length >= 6);
  const text = blocks.length ? blocks.join('\n') : cleanWhitespace(root.textContent);
  return text;
}

export async function readPage(url, ctx) {
  // 1) Jina Reader: free, no key, handles JavaScript-heavy pages and PDFs.
  try {
    const md = await getText(`https://r.jina.ai/${url}`, { ...ctx, timeout: 20000 });
    const text = markdownToText(md);
    if (text.length > 300) return text.slice(0, MAX_TEXT_PER_PAGE);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
  }
  // 2) Raw HTML through a CORS proxy.
  const html = await fetchTextViaProxy(url, { ...ctx, timeout: 15000 });
  const text = htmlToText(html);
  if (text.length < 200) throw new Error('Not enough readable text');
  return text.slice(0, MAX_TEXT_PER_PAGE);
}
