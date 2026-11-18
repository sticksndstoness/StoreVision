// Offline app shell. Everything is same-origin now (no CDNs). API calls (Gemini / Apps Script) are never cached.
// Same-origin files are network-first, so a new deployment is picked up on the next load; the cache is the offline fallback.
const CACHE = 'storevision-v8';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icons/icon.svg',
  './css/tailwind.css', './css/style.css', './vendor/fontawesome/css/all.min.css',
  './vendor/fontawesome/webfonts/fa-solid-900.woff2', './vendor/fontawesome/webfonts/fa-brands-400.woff2',
  './js/config.js', './vendor/supabase/supabase.js', './vendor/readxlsx/read-excel-file.min.js', './js/sap.js', './vendor/zxing/zxing.min.js', './js/scan.js', './js/parts.js', './js/core.js', './js/db.js', './js/cloud.js', './js/app.js', './js/team.js', './js/stock.js'
];

self.addEventListener('install', (e) => {
  // add files one by one: a single missing file must not make the whole install fail
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;   // never touch API traffic
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
