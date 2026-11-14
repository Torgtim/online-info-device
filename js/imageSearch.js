// Reverse image search. A static page can't run its own image index, so this
// builds the links that hand an image URL to the big free engines, and
// gives direct links to their upload pages for photos from your phone.

import { enc, isHttpUrl } from './text.js';

export const IMAGE_ENGINES = [
  { id: 'lens', label: 'Google Lens', byUrl: u => `https://lens.google.com/uploadbyurl?url=${enc(u)}`, upload: 'https://lens.google.com/' },
  { id: 'bing', label: 'Bing Visual Search', byUrl: u => `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${enc(u)}`, upload: 'https://www.bing.com/visualsearch' },
  { id: 'tineye', label: 'TinEye', byUrl: u => `https://tineye.com/search?url=${enc(u)}`, upload: 'https://tineye.com/' },
  { id: 'yandex', label: 'Yandex Images', byUrl: u => `https://yandex.com/images/search?rpt=imageview&url=${enc(u)}`, upload: 'https://yandex.com/images/' },
];

// Returns [{ label, href }] for a public image URL, or null if the URL isn't usable.
export function reverseImageLinks(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!isHttpUrl(url)) return null;
  return IMAGE_ENGINES.map(e => ({ label: e.label, href: e.byUrl(url) }));
}
