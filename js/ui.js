// Rendering helpers. Everything goes through textContent, so nothing from
// the web is ever injected as HTML.

import { hostOf, truncate } from './text.js';

export const $ = id => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function citation(ref) {
  const n = ref + 1;
  return el('sup', {}, el('a', { href: `#src-${n}`, textContent: `[${n}]`, onclick: () => flashSource(n) }));
}

function flashSource(n) {
  const li = document.getElementById(`src-${n}`);
  if (!li) return;
  li.classList.remove('flash');
  void li.offsetWidth;   // restart the animation
  li.classList.add('flash');
}

function sentencesParagraph(items) {
  const p = el('p');
  items.forEach((item, i) => {
    if (i) p.append(' ');
    p.append(item.text, citation(item.ref));
  });
  return p;
}

export function renderSummary(container, summary) {
  container.replaceChildren();
  if (!summary.length) {
    container.append(el('p', { className: 'muted', textContent:
      'Not enough readable text was found to write a summary. Try another wording or a higher effort level, or look through the sources below.' }));
    return;
  }
  container.append(sentencesParagraph(summary));
}

export function renderReport(container, sections) {
  container.replaceChildren();
  for (const section of sections) {
    container.append(el('h3', { textContent: section.heading }));
    (section.paragraphs || []).forEach(p => container.append(sentencesParagraph(p)));
    if (section.list) {
      container.append(el('ul', {}, section.list.map(item => el('li', {}, [item.text, citation(item.ref)]))));
    }
    for (const sub of section.subsections || []) {
      container.append(el('p', {}, [el('strong', { textContent: truncate(sub.heading || '', 90) }), citation(sub.ref)]));
      sub.paragraphs.forEach(p => container.append(sentencesParagraph(p)));
    }
  }
}

export function renderTerms(container, terms, onPick) {
  container.replaceChildren(...terms.map(term =>
    el('button', { type: 'button', textContent: term, onclick: () => onPick(term) })));
}

export function renderSources(container, results) {
  container.replaceChildren(...results.map((r, i) => {
    const title = r.url
      ? el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', textContent: r.title || r.url })
      : el('span', { textContent: r.title });
    const meta = el('div', { className: 'meta' }, [
      [...new Set(r.sources || [r.source])].join(', '),
      r.url ? ` · ${hostOf(r.url)}` : '',
      r.fullyRead ? el('span', { className: 'badge', textContent: 'read in full' }) : null,
    ]);
    const snippet = r.snippet ? el('div', { className: 'snip', textContent: truncate(r.snippet, 240) }) : null;
    return el('li', { id: `src-${i + 1}` }, [title, meta, snippet]);
  }));
}

export function renderStats(container, stats, effortLabel) {
  const parts = [
    `${effortLabel} effort`,
    `${stats.seconds.toFixed(1)} s`,
    `${stats.sourcesOk}/${stats.tasks} sources answered`,
    `${stats.results} results`,
  ];
  if (stats.pagesRead || stats.pagesFailed) parts.push(`${stats.pagesRead} pages read in full`);
  parts.push(`${stats.sentences} sentences analyzed`);
  container.textContent = parts.join(' · ');
}

export function logLine(list, text, ok) {
  list.append(el('li', { className: ok ? 'ok' : 'fail', textContent: text }));
  list.scrollTop = list.scrollHeight;
}

// ---------- Plain-text versions for the Copy buttons ----------

export function summaryToText(summary, results) {
  const body = summary.map(s => `${s.text} [${s.ref + 1}]`).join(' ');
  return `${body}\n\n${sourcesToText(results, summary.map(s => s.ref))}`;
}

export function reportToText(sections, results) {
  const out = [];
  const refs = [];
  for (const s of sections) {
    out.push(`\n## ${s.heading}\n`);
    for (const p of s.paragraphs || []) {
      out.push(p.map(i => `${i.text} [${i.ref + 1}]`).join(' '));
      refs.push(...p.map(i => i.ref));
    }
    for (const item of s.list || []) { out.push(`- ${item.text} [${item.ref + 1}]`); refs.push(item.ref); }
    for (const sub of s.subsections || []) {
      out.push(`\n${sub.heading} [${sub.ref + 1}]`);
      refs.push(sub.ref);
      for (const p of sub.paragraphs) out.push(p.map(i => i.text).join(' '));
    }
  }
  return `${out.join('\n').trim()}\n\n${sourcesToText(results, refs)}`;
}

function sourcesToText(results, refs) {
  const used = [...new Set(refs)].sort((a, b) => a - b);
  return `Sources:\n${used.map(i => `[${i + 1}] ${results[i]?.title || ''} ${results[i]?.url || ''}`.trim()).join('\n')}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
