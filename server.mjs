#!/usr/bin/env node
// Spoje UK web: statické soubory + API živých poloh. Žádné závislosti, stačí Node 20+.
//
//   PORT=8080 node server.mjs
//   MOCK=1 node server.mjs                    polohy z jízdního řádu (vývoj, když není dostupný zdroj)
//   SERVER_BASE=http://37.46.211.70:8787      vlastní server: /duk/traffic a /dpmul/traffic (Portabo se přímo nevolá)
//   DUK_URL / DPMUL_URL                       přepíšou adresu jednoho feedu
//   DPMUL_API_KEY=…                           záloha: přímé API DPMÚL, když vlastní server nemá čerstvá data
//   SZ=0                                      nevolat Správu železnic
//   ALLOWED_ORIGINS=…                         volitelné povolené originy pro externí frontend
//   CARTO_API_KEY=…                           klíč pro podkladovou mapu (stejný jako CARTO_API_KEY v Androidu)
//   DATA_REFRESH_H=12                         jak často kontrolovat nové jízdní řády (0 = nikdy)
//   TRUST_PROXY=1                             kolik proxy (Caddy, Cloud Run…) stojí před serverem; bez toho se limity počítají podle IP přímého spojení
//   RATE_LIMIT=0                              vypne omezení počtu požadavků; RATE_API / RATE_DATA / RATE_STATIC nastaví limity za minutu na IP (viz lib/ratelimit.mjs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Hub } from './lib/hub.mjs';
import { createSources } from './lib/sources.mjs';
import { mockFetcher } from './lib/mock.mjs';
import { createLimits, routeClass, clientIp, ipKey } from './lib/ratelimit.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(root, 'public');
const DATA_FILE = path.join(PUBLIC, 'data', 'timetable.json');
const env = process.env;
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const TRUST_PROXY = Math.max(0, parseInt(env.TRUST_PROXY, 10) || 0);

// ───────────── omezení počtu požadavků (DoS) ─────────────
const limits = createLimits(env);
let limitedCount = 0;
// Jednou za minutu souhrn místo řádku na každý odmítnutý požadavek (log by se při útoku sám stal zátěží)
setInterval(() => {
  if (limitedCount) console.warn(`[rate-limit] za poslední minutu odmítnuto požadavků: ${limitedCount}`);
  limitedCount = 0;
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt', '.xml']);

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
  // MapLibre: styl a dlaždice z CARTO (a záložně OpenFreeMap), worker je vlastní soubor
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.cartocdn.com https://tiles.openfreemap.org https://router.project-osrm.org; manifest-src 'self'; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

// ───────────── živé polohy ─────────────
const useMock = env.MOCK === '1';
const feed = new Hub(createSources(env, { mockFetcher: useMock ? mockFetcher(DATA_FILE) : null }));
// POLL_MODE=loop: dotazy na zdroje běží ve smyčce na pozadí; výchozí (lazy): jen když přijde požadavek na polohy
if (env.POLL_MODE === 'loop') feed.start(); else feed.refresh().catch(() => {});

// Odpověď /api/vehicles se sestavuje (fúze zdrojů + deduplikace) a data se stejně mění jen po 8-10 s,
// proto se hotový JSON krátce drží v paměti: zátěž nezávisí na počtu požadavků.
let vehiclesCache = { at: 0, body: '' };
function vehiclesJson() {
  const t = Date.now();
  if (t - vehiclesCache.at > 1000) vehiclesCache = { at: t, body: JSON.stringify(feed.snapshot()) };
  return vehiclesCache.body;
}

// ───────────── podkladová mapa ─────────────
// Stejné styly jako Android appka: CARTO Voyager / Dark Matter. Klíč (CARTO_API_KEY) zůstává na serveru.
// Bez klíče se použije OpenFreeMap (Positron, v tmavém režimu přebarvený); stejně se přepne, když CARTO styl selže.
function mapConfig() {
  const key = env.CARTO_API_KEY;
  const free = 'https://tiles.openfreemap.org/styles/positron';
  const carto = (name) => `https://basemaps.cartocdn.com/gl/${name}/style.json?key=${encodeURIComponent(key)}`;
  return key
    ? { provider: 'carto', light: carto('voyager-gl-style'), dark: carto('dark-matter-gl-style'), fallback: { light: free, dark: free } }
    : { provider: 'openfreemap', light: free, dark: free, fallback: null };
}

// ───────────── statické soubory ─────────────
const cache = new Map(); // cesta → { mtime, raw, br, gz, etag }

function load(file) {
  const st = fs.statSync(file);
  let c = cache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const raw = fs.readFileSync(file);
  const ext = path.extname(file);
  c = { mtime: st.mtimeMs, raw, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, br: null, gz: null };
  if (COMPRESSIBLE.has(ext) && raw.length > 512) {
    c.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > 1e6 ? 9 : 11 } });
    c.gz = zlib.gzipSync(raw, { level: 9 });
  }
  cache.set(file, c);
  return c;
}

function send(req, res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveFile(req, res, file) {
  const ext = path.extname(file);
  const c = load(file);
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = c.br && /\bbr\b/.test(accept) ? 'br' : c.gz && /\bgzip\b/.test(accept) ? 'gzip' : null;
  const body = enc === 'br' ? c.br : enc === 'gzip' ? c.gz : c.raw;
  // data a service worker se kontrolují vždy, ostatní se krátce cachují
  const cc = file === DATA_FILE || ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300';
  const headers = { ...SECURITY, 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cc, etag: c.etag, vary: 'accept-encoding' };
  if (enc) headers['content-encoding'] = enc;
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function resolvePath(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return null; // ochrana proti ../
  return file;
}

// ───────────── CORS: volitelné, pokud se frontend servíruje z jiného originu ─────────────
// ALLOWED_ORIGINS=https://frontend.example   (čárkou oddělený seznam, '*' = kdokoli)
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function corsHeaders(req, pathname) {
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/data/')) return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes('*')) return { 'access-control-allow-origin': '*' };
  return ALLOWED_ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const cors = corsHeaders(req, (req.url || '').split('?')[0]);
    if (cors) {
      const writeHead = res.writeHead.bind(res);
      // CORS hlavičky se přidají ke každé odpovědi na /api/ a /data/ (vary se sloučí s tím, co už je nastavené)
      res.writeHead = (status, headers = {}) => {
        const h = { ...headers, ...cors };
        if (cors.vary) h.vary = [headers.vary, cors.vary].filter(Boolean).join(', ');
        return writeHead(status, h);
      };
    }
    if (limits) {
      const r = limits[routeClass((req.url || '').split('?')[0])].take(ipKey(clientIp(req, TRUST_PROXY)));
      if (!r.ok) {
        limitedCount++;
        return send(req, res, 429, 'Too Many Requests', { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(r.retryAfterSec), 'cache-control': 'no-store' });
      }
    }
    if (req.method === 'OPTIONS' && cors) { res.writeHead(204, { 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/vehicles') {
      maybeRefreshData(); // frontend může být jinde (Hosting), takže stránku tenhle server nevidí
      if (env.POLL_MODE !== 'loop') await feed.refresh();
      return send(req, res, 200, vehiclesJson(), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3' });
    }
    if (url.pathname === '/api/map-config') {
      return send(req, res, 200, JSON.stringify(mapConfig()), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
    }
    if (url.pathname === '/api/health') {
      if (env.POLL_MODE !== 'loop') await feed.refresh();
      const s = feed.snapshot();
      return send(req, res, 200, JSON.stringify({ ok: !s.outage, mock: useMock, vehicles: s.vehicles.length, held: s.held, upstreamAgeSec: s.upstreamAgeSec, sources: s.sources, timetable: fs.existsSync(DATA_FILE) }), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    }

    let file = resolvePath(url.pathname);
    if (!file) return send(req, res, 400, 'Bad Request', { 'content-type': 'text/plain' });
    // dřívější adresa aplikace (před odstraněním úvodní stránky)
    if (url.pathname === '/app' || url.pathname === '/app/') { res.writeHead(301, { location: '/' }); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const nf = path.join(PUBLIC, '404.html');
      if (fs.existsSync(nf)) { const c = load(nf); return send(req, res, 404, c.raw, { 'content-type': MIME['.html'] }); }
      return send(req, res, 404, 'Not Found', { 'content-type': 'text/plain' });
    }
    if (file.endsWith('index.html')) maybeRefreshData();
    serveFile(req, res, file);
  } catch (e) {
    console.error(e);
    send(req, res, 500, 'Internal Server Error', { 'content-type': 'text/plain' });
  }
});

// Pomalí klienti (slowloris): hlavičky i celý požadavek musí dorazit rychle a nelze držet nekonečně spojení.
// Odpovědi jsou jen GET/HEAD bez těla, takže tyhle limity nemají vliv na běžné klienty.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;

// ───────────── jízdní řády: první sestavení a pravidelná obnova ─────────────
async function refreshData() {
  const { build } = await import('./scripts/build-data.mjs');
  const oldMeta = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'meta.json'), 'utf8')) : null;
  const base = env.GTFS_BASE_URL || 'https://github.com/Vasik96/spojeuk-data/releases/download/gtfs';
  const sbase = env.SHAPES_BASE_URL || 'https://github.com/Vasik96/spojeuk-data/releases/download/shapes';
  let remote = null, remoteShapes = null;
  try { remote = (await (await fetch(`${base}/gtfs.json`)).json()).tag; } catch { /* offline */ }
  try {
    const j = async (n) => (await (await fetch(`${sbase}/${n}`)).json()).built ?? '';
    remoteShapes = `${await j('shapes.json')}|${await j('train_shapes.json')}`;
  } catch { /* offline */ }
  // obnovit, když se změnil jízdní řád NEBO trasy (tvary vznikají odděleně), nebo když data nemají žádné tvary
  const same = oldMeta && remote && oldMeta.tag === remote && (!remoteShapes || oldMeta.shapes === remoteShapes);
  if (same) return console.log('[data] jízdní řády i trasy jsou aktuální');
  console.log('[data] stahuji jízdní řády a trasy…');
  await build({ tag: remote ?? '' });
}

if (!fs.existsSync(DATA_FILE)) {
  console.log('[data] chybí public/data/timetable.json, sestavuji…');
  refreshData().catch((e) => console.error('[data] sestavení selhalo:', e.message, '\n       spusť ručně: npm run data'));
}
// Kontrola nových jízdních řádů se spouští z požadavku na stránku (ne časovačem), aby fungovala i tam,
// kde se mezi požadavky CPU omezuje (Cloud Run). DATA_REFRESH_H=0 ji vypne.
const hours = Number(env.DATA_REFRESH_H ?? 12);
let lastDataCheck = Date.now(), dataBusy = false;
function maybeRefreshData() {
  if (hours <= 0 || dataBusy || Date.now() - lastDataCheck < hours * 3600e3) return;
  lastDataCheck = Date.now(); dataBusy = true;
  refreshData().catch((e) => console.error('[data]', e.message)).finally(() => { dataBusy = false; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`Spoje UK web: http://localhost:${PORT}  (${useMock ? 'MOCK polohy' : 'živé polohy'})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { feed.stop(); server.close(() => process.exit(0)); });
}
export { server, feed };
