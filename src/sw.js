// Service worker: makes the app installable and fast to reopen. It caches only the app shell and
// the CDN libraries. Live data (NWS, NOAA, Open-Meteo, satellite) is never cached here, so the app
// can never show a stale reading as if it were live: offline, those panels say "unavailable".
const VERSION = 'sdx-v1';
const SHELL = `${VERSION}-shell`;
const LIBS = `${VERSION}-libs`;
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Pages: network first (a deploy shows up immediately), cache when offline.
async function page(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true }) || await caches.match('./');
    if (hit) return hit;
    throw err;
  }
}

// Libraries: cached copy now, refreshed in the background.
async function lib(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) e.respondWith(page(req));
  else if (url.origin === self.location.origin && /\/(manifest\.webmanifest|icon-\d+\.png)$/.test(url.pathname)) e.respondWith(lib(req));
  else if (LIB_HOSTS.includes(url.hostname)) e.respondWith(lib(req));
});
