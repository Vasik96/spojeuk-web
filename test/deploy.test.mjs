import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.MOCK = '1'; process.env.SZ = '0'; process.env.DATA_REFRESH_H = '0'; process.env.POLL_MODE = 'loop';
process.env.ALLOWED_ORIGINS = 'https://frontend.example';
const { server, feed } = await import('../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { feed.stop(); server.close(); });

test('CORS: jen nakonfigurovaný externí origin dostane hlavičku pro /api a /data', async () => {
  const ok = await fetch(`${base}/api/map-config`, { headers: { origin: 'https://frontend.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://frontend.example');
  assert.match(ok.headers.get('vary') || '', /Origin/);
  const bad = await fetch(`${base}/api/vehicles`, { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const none = await fetch(`${base}/api/vehicles`);
  assert.equal(none.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/api/vehicles`, { method: 'OPTIONS', headers: { origin: 'https://frontend.example' } });
  assert.equal(pre.status, 204);
  if (fs.existsSync(new URL('../public/data/timetable.json', import.meta.url))) {
    const d = await fetch(`${base}/data/timetable.json`, { headers: { origin: 'https://frontend.example', 'accept-encoding': 'br' } });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('access-control-allow-origin'), 'https://frontend.example');
    assert.match(d.headers.get('vary') || '', /accept-encoding/i, 'vary se sloučilo s kompresí');
  }
  const page = await fetch(`${base}/`, { headers: { origin: 'https://evil.example' } });
  assert.equal(page.status, 200);
});
