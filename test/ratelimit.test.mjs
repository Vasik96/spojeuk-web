import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, clientIp, ipKey, routeClass, createLimits } from '../lib/ratelimit.mjs';

const fakeReq = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('RateLimiter: dávka projde, další požadavek dostane 429 a žetony se doplňují', () => {
  let t = 0;
  const rl = new RateLimiter({ perMin: 60, burst: 3, now: () => t }); // 1 žeton za sekundu
  assert.ok(rl.take('a').ok && rl.take('a').ok && rl.take('a').ok);
  const denied = rl.take('a');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSec, 1);
  assert.ok(rl.take('b').ok, 'jiný klient má vlastní limit');
  t += 1000;
  assert.ok(rl.take('a').ok, 'po sekundě je zase jeden žeton');
  assert.equal(rl.take('a').ok, false);
  t += 60_000;
  assert.equal([1, 2, 3, 4].filter(() => rl.take('a').ok).length, 3, 'kyblík se nikdy nenaplní nad burst');
});

test('RateLimiter: počet sledovaných klientů je omezený', () => {
  const rl = new RateLimiter({ perMin: 60, burst: 1, maxKeys: 100 });
  for (let i = 0; i < 1000; i++) rl.take(`ip${i}`);
  assert.equal(rl.buckets.size, 100);
  assert.throws(() => new RateLimiter({ perMin: 0 }));
});

test('clientIp: bez důvěryhodné proxy se X-Forwarded-For ignoruje', () => {
  assert.equal(clientIp(fakeReq('203.0.113.5', '1.2.3.4'), 0), '203.0.113.5');
  assert.equal(clientIp(fakeReq('::ffff:203.0.113.5'), 0), '203.0.113.5');
});

test('clientIp: za jednou proxy se bere poslední položka, kterou připsala proxy, ne podvržená zleva', () => {
  assert.equal(clientIp(fakeReq('172.18.0.3', '198.51.100.7'), 1), '198.51.100.7');
  assert.equal(clientIp(fakeReq('172.18.0.3', '6.6.6.6, 198.51.100.7'), 1), '198.51.100.7');
  assert.equal(clientIp(fakeReq('172.18.0.3', '6.6.6.6, 198.51.100.7'), 2), '6.6.6.6');
  assert.equal(clientIp(fakeReq('172.18.0.3', 'nesmysl'), 1), '172.18.0.3', 'neplatná hodnota → IP spojení');
  assert.equal(clientIp(fakeReq('172.18.0.3'), 1), '172.18.0.3', 'bez hlavičky → IP spojení');
});

test('ipKey: IPv6 se sdružuje po /64, IPv4 zůstává', () => {
  assert.equal(ipKey('198.51.100.7'), '198.51.100.7');
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:0db8:0001:0002::1'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
});

test('routeClass a createLimits', () => {
  assert.equal(routeClass('/api/vehicles'), 'api');
  assert.equal(routeClass('/data/timetable.json'), 'data');
  assert.equal(routeClass('/js/app.js'), 'static');
  assert.equal(createLimits({ RATE_LIMIT: '0' }), null);
  assert.equal(createLimits({ RATE_API: '10' }).api.rate, 10 / 60_000);
  assert.equal(createLimits({ RATE_API: 'x' }).api.rate, 120 / 60_000, 'neplatná hodnota → výchozí');
});

// ───── server: 429 s hlavičkou Retry-After, limity jsou na třídu cesty a na klienta ─────
process.env.MOCK = '1'; process.env.SZ = '0'; process.env.DATA_REFRESH_H = '0'; process.env.POLL_MODE = 'loop';
process.env.RATE_API = '6'; // burst 5
process.env.TRUST_PROXY = '1';
process.env.ALLOWED_ORIGINS = 'https://frontend.example';
const { server, feed } = await import('../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { feed.stop(); server.close(); });

test('server: nad limit vrací 429 + Retry-After, jiný klient (X-Forwarded-For) a jiná třída cesty nejsou dotčeny', async () => {
  const get = (path, ip, headers = {}) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip, ...headers } });
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await get('/api/map-config', '198.51.100.1')).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);

  const denied = await get('/api/map-config', '198.51.100.1', { origin: 'https://frontend.example' });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('retry-after')) >= 1);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(denied.headers.get('access-control-allow-origin'), 'https://frontend.example', '429 je čitelná i z externího frontendu');

  assert.equal((await get('/api/map-config', '198.51.100.2')).status, 200, 'jiný klient');
  assert.equal((await get('/', '198.51.100.1')).status, 200, 'statické soubory mají vlastní limit');
  assert.equal((await get('/api/map-config', '6.6.6.6, 198.51.100.1')).status, 429, 'podvržená levá část hlavičky nepomůže');
});

test('server: /api/vehicles vrací stejný snímek v rámci sekundy (cache)', async () => {
  const a = await (await fetch(`${base}/api/vehicles`, { headers: { 'x-forwarded-for': '198.51.100.9' } })).text();
  const b = await (await fetch(`${base}/api/vehicles`, { headers: { 'x-forwarded-for': '198.51.100.9' } })).text();
  assert.equal(a, b);
  assert.ok(JSON.parse(a).vehicles);
});
