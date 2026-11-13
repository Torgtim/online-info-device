// Network helpers: timeouts, cancellation, JSONP, CORS-proxy fallbacks
// and a small concurrency pool.

export async function fetchWithTimeout(url, { timeout = 12000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const relay = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (ctrl.signal.aborted) throw new Error('Timed out');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

export async function getJSON(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  return res.json();
}

export async function getText(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  return res.text();
}

// JSONP for APIs that don't send CORS headers but support a callback parameter.
let jsonpCounter = 0;
export function jsonp(url, { timeout = 10000, signal, param = 'callback' } = {}) {
  return new Promise((resolve, reject) => {
    const name = `__oidJsonp${Date.now()}_${jsonpCounter++}`;
    const script = document.createElement('script');
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      window[name] = () => {};          // late responses become harmless no-ops
      script.remove();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error('Cancelled'));
    const timer = setTimeout(() => finish(reject, new Error('Timed out')), timeout);
    window[name] = data => finish(resolve, data);
    script.onerror = () => finish(reject, new Error('Script load failed'));
    signal?.addEventListener('abort', onAbort, { once: true });
    script.src = `${url}${url.includes('?') ? '&' : '?'}${param}=${name}`;
    document.head.appendChild(script);
  });
}

// Free public CORS proxies, tried in order. The last one that worked is tried first next time.
const PROXIES = [
  { name: 'allorigins', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', build: u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { name: 'corsproxy', build: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];
let preferredProxy = 0;

export async function fetchTextViaProxy(url, opts = {}) {
  let lastErr;
  for (let i = 0; i < PROXIES.length; i++) {
    const idx = (preferredProxy + i) % PROXIES.length;
    try {
      const text = await getText(PROXIES[idx].build(url), opts);
      if (!text || text.length < 50) throw new Error('Empty response');
      preferredProxy = idx;
      return text;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('All proxies failed');
}

// Runs `worker` over `items` with at most `limit` running at once.
// Returns [{ ok, value } | { ok: false, error }] in input order.
export async function runPool(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, lane);
  await Promise.all(lanes);
  return results;
}
