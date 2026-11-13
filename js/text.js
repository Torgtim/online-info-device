// Small text and URL utilities shared by the source adapters.

export const enc = encodeURIComponent;

export function cleanWhitespace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Strips HTML tags and decodes entities, without running any of the markup.
export function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return cleanWhitespace(doc.body.textContent);
}

export function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function parseXml(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isHttpUrl(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

// Normalized key for de-duplicating the same page found by several sources.
export function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid']
      .forEach(p => u.searchParams.delete(p));
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`.toLowerCase();
  } catch {
    return '';
  }
}

// Decodes base64url (used by Bing's redirect links).
export function decodeBase64Url(s) {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return '';
  }
}

export function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
