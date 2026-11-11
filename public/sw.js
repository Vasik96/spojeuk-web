// Service worker: aplikace a jízdní řády fungují offline (živé polohy a dlaždice mapy vždy ze sítě).
const VERSION = 'v17';
const CACHE = `spojeuk-${VERSION}`;
const SHELL = [
  '/', '/css/base.css', '/css/app.css', '/assets/icons.svg', '/assets/logo.svg', '/assets/favicon.svg', '/manifest.webmanifest',
  '/js/app.js', '/js/config.js', '/js/util.js', '/js/timetable.js', '/js/planner.js', '/js/suggest.js', '/js/live.js', '/js/gl-map.js', '/js/map-style.js', '/js/shapes.js', '/vendor/maplibre-gl-csp.js', '/vendor/maplibre-gl-csp-worker.js', '/vendor/maplibre-gl.css', '/js/store.js', '/js/theme-init.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // živé polohy a konfigurace mapy se nikdy neukládají; jízdní řády (/data/) se ukládají i z vlastního serveru na jiné adrese
  const isData = url.pathname.startsWith('/data/');
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || (url.origin !== location.origin && !isData)) return;
  // timetable.json a shapes.bin k sobě patří (čísla tvarů): vždy ze sítě, z cache jen offline,
  // jinak by se mohla načíst nová verze jednoho souboru se starou verzí druhého a trasy by seděly špatně
  if (isData) {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; }
      catch (err) { const hit = await cache.match(req, { ignoreSearch: true }); if (hit) return hit; throw err; }
    }));
    return;
  }
  // stale-while-revalidate: rychle z cache, na pozadí aktualizace
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
