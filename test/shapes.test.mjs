import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib, { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { decodeShape, Path, locateStops, sliceBetween } from '../public/js/shapes.js';
import { buildShapePack } from '../lib/shapes.mjs';

const enc = (pts) => {
  const out = [];
  const v = (n) => { while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); };
  const z = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
  v(pts.length);
  let la = 0, lo = 0;
  for (const [a, b] of pts) { const A = Math.round(a * 1e6), B = Math.round(b * 1e6); v(z(A - la)); v(z(B - lo)); la = A; lo = B; }
  return Uint8Array.from(out);
};

test('dekódování tvaru (varint + zigzag delty)', () => {
  const pts = [[50.66, 14.04], [50.661, 14.039], [50.6605, 14.0425]];
  const back = decodeShape(enc(pts));
  assert.equal(back.length, 3);
  back.forEach((p, i) => { assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-6 && Math.abs(p[1] - pts[i][1]) < 1e-6); });
});

test('úsek trasy mezi zastávkami sleduje tvar, ne přímku', () => {
  // „L“: sever, pak východ. Zastávky na koncích, přímka by zkracovala přes roh.
  const pts = [[50.0, 14.0], [50.01, 14.0], [50.01, 14.015]];
  const stops = [[50.0, 14.0], [50.01, 14.0], [50.01, 14.015]];
  const seg = sliceBetween(pts, stops, 0, 2);
  assert.ok(seg.some((p) => Math.abs(p[0] - 50.01) < 1e-6 && Math.abs(p[1] - 14.0) < 1e-6), 'prochází rohem');
  const path = new Path(pts);
  const pos = locateStops(path, stops);
  assert.ok(pos[0] < pos[1] && pos[1] < pos[2]);
});

test('smyčka tam a zpět po téže silnici: zastávky na správné straně', () => {
  // tam po jedné straně, zpět o ~210 m vedle (jako smyčka v terénu)
  const pts = [[50.0, 14.0], [50.01, 14.0], [50.01, 14.003], [50.0, 14.003]];
  const stops = [[50.0, 14.0], [50.005, 14.0], [50.01, 14.0], [50.005, 14.003], [50.0, 14.003]];
  const pos = locateStops(new Path(pts), stops);
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i] >= pos[i - 1] - 30, `pozice ${i} klesá`);
});

test('JDF trip_id s novou revizí najde odpovídající starší tvar podle zastávek', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spojeuk-shapes-'));
  const file = path.join(dir, 'shapes.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE shape (id INTEGER PRIMARY KEY, pts BLOB NOT NULL); CREATE TABLE trip_shape (gid TEXT PRIMARY KEY, shape INTEGER NOT NULL)');
  const insertShape = db.prepare('INSERT INTO shape (id, pts) VALUES (?, ?)');
  const insertTrip = db.prepare('INSERT INTO trip_shape (gid, shape) VALUES (?, ?)');
  insertShape.run(1, deflateSync(enc([[50, 14], [50, 14.01], [50.01, 14.01]])));
  insertShape.run(2, deflateSync(enc([[51, 15], [51, 15.01], [51.01, 15.01]])));
  insertTrip.run('jdf:trip:595080:260928:det:2001', 1);
  insertTrip.run('jdf:trip:595080:260928:det:2002', 2);
  db.close();

  try {
    const pack = await buildShapePack(
      ['jdf:trip:595080:261105:det:5001'],
      { bus: file },
      [[[50, 14.0001], [50.0001, 14.01], [50.01, 14.01]]],
    );
    assert.ok(pack.index[0] > 0);
    assert.deepEqual(pack.unmatched, []);
    const n = pack.bin.readUInt32LE(0);
    const base = 4 + n * 4;
    const end = pack.bin.readUInt32LE(4 + (pack.index[0] - 1) * 4);
    const start = pack.index[0] === 1 ? 0 : pack.bin.readUInt32LE(4 + (pack.index[0] - 2) * 4);
    assert.deepEqual(decodeShape(zlib.inflateSync(pack.bin.subarray(base + start, base + end))), [[50, 14], [50, 14.01], [50.01, 14.01]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skutečná data: shapes.bin odpovídá timetable', { skip: !fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data/shapes.bin')) }, () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
  const bin = fs.readFileSync(path.join(dir, 'shapes.bin'));
  const n = bin.readUInt32LE(0);
  const base = 4 + n * 4;
  const tt = JSON.parse(fs.readFileSync(path.join(dir, 'timetable.json'), 'utf8'));
  const withShape = tt.trips.filter((t) => t[13] > 0);
  assert.ok(withShape.length / tt.trips.length > 0.9, 'většina spojů má trasu');
  assert.ok(withShape.every((t) => t[13] <= n));
  for (const k of [1, Math.floor(n / 2), n]) {
    const a = k === 1 ? 0 : bin.readUInt32LE(4 + (k - 2) * 4), b = bin.readUInt32LE(4 + (k - 1) * 4);
    const pts = decodeShape(zlib.inflateSync(bin.subarray(base + a, base + b)));
    assert.ok(pts.length >= 2);
    assert.ok(pts.every(([la, lo]) => la > 48 && la < 52 && lo > 11 && lo < 19), 'souřadnice v ČR');
  }
});
