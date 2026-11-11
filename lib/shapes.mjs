// Trasy spojů (GTFS shapes) z releasu "shapes" repozitáře spojeuk-data → jeden kompaktní soubor shapes.bin.
// Zdroj (shapes.sqlite, train_shapes.sqlite) generuje stejný workflow jako pro Android appku.
//
// Formát shapes.bin: u32 LE počet N, N× u32 LE konec bloku (kumulativně), pak bloky.
// Blok = zlib( varint(počet bodů) + zigzag-varint delty lat/lng v 1e-6 ° ), tj. beze změny z .sqlite.
import fs from 'node:fs';
import { inflateSync } from 'node:zlib';

export const SHAPES_URL = 'https://github.com/Vasik96/spojeuk-data/releases/download/shapes';

async function openDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function decodeShape(blob) {
  const raw = inflateSync(blob);
  let p = 0;
  const varint = () => {
    let value = 0, multiplier = 1;
    for (;;) {
      const byte = raw[p++];
      if (byte === undefined) throw new Error('Neplatný varint v shapes.sqlite');
      value += (byte & 0x7f) * multiplier;
      if (!(byte & 0x80)) return value;
      multiplier *= 128;
    }
  };
  const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const n = varint();
  const points = new Array(n);
  let lat = 0, lng = 0;
  for (let i = 0; i < n; i++) {
    lat += zigzag(varint());
    lng += zigzag(varint());
    points[i] = [lat / 1e6, lng / 1e6];
  }
  return points;
}

function shapeMatchScore(points, stops) {
  if (points.length < 2 || stops.length < 2) return null;
  const lat0 = points[0][0], lng0 = points[0][1];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map(([lat, lng]) => [(lng - lng0) * 111320 * cosLat, (lat - lat0) * 110540]);
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);

  let previous = null;
  for (const [lat, lng] of stops) {
    const x = (lng - lng0) * 111320 * cosLat, y = (lat - lat0) * 110540;
    const candidates = [];
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const dx = bx - ax, dy = by - ay, lengthSq = dx * dx + dy * dy;
      const t = lengthSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
      const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (distance <= 500) candidates.push({ s: cum[i] + t * (cum[i + 1] - cum[i]), distance });
    }
    if (!candidates.length) return null;

    if (previous) {
      let prevIndex = 0, bestPrev = null;
      for (const candidate of candidates) {
        while (prevIndex < previous.length && previous[prevIndex].s <= candidate.s + 30) {
          const item = previous[prevIndex++];
          if (!bestPrev || item.cost < bestPrev.cost || (item.cost === bestPrev.cost && item.max < bestPrev.max)) bestPrev = item;
        }
        candidate.cost = bestPrev ? bestPrev.cost + candidate.distance : Infinity;
        candidate.max = bestPrev ? Math.max(bestPrev.max, candidate.distance) : Infinity;
      }
      previous = candidates.filter((candidate) => Number.isFinite(candidate.cost));
      if (!previous.length) return null;
    } else {
      previous = candidates.map(({ s, distance }) => ({ s, cost: distance, max: distance }));
    }
  }

  let best = previous[0];
  for (const item of previous) if (item.cost < best.cost || (item.cost === best.cost && item.max < best.max)) best = item;
  return { mean: best.cost / stops.length, max: best.max };
}

function routePrefix(gid) {
  const match = /^jdf:trip:([^:]+):/.exec(gid);
  return match ? `jdf:trip:${match[1]}` : null;
}

/**
 * @param {string[]} gids GTFS trip_id spojů v pořadí v timetable.json
 * @param {Array<Array<[number,number]>>} stopCoords souřadnice zastávek spojů, pro zastaralé JDF trip_id
 * @param {{bus?: string, train?: string}} files cesty k .sqlite
 * @returns {{bin: Buffer, index: number[], used: number, unmatched: string[], sample: Record<string,string[]>}} index[i] = 0 (bez trasy) nebo číslo tvaru + 1
 */
export async function buildShapePack(gids, files, stopCoords = []) {
  const sources = [];
  for (const [key, file] of Object.entries(files)) {
    if (!file || !fs.existsSync(file)) continue;
    const db = await openDb(file);
    sources.push({
      key, db,
      byGid: db.prepare('SELECT shape FROM trip_shape WHERE gid = ?'),
      byRoute: db.prepare('SELECT shape FROM trip_shape WHERE gid >= ? AND gid < ?'),
      blob: db.prepare('SELECT pts FROM shape WHERE id = ?'),
      decoded: new Map(),
      routeShapes: new Map(),
    });
  }
  const blobs = [];
  const seen = new Map(); // "zdroj:id" → číslo tvaru
  const unmatched = []; // gid spojů, které nedostaly tvar (pro diagnostiku v build-data)
  const index = gids.map((gid, i) => {
    if (!gid) return 0;
    for (const s of sources) {
      // stejně jako Android (Model.isTrain): vlak = trip_id "czptt:…" → train_shapes, VŠE ostatní → shapes (autobusy).
      if ((s.key === 'train') !== gid.startsWith('czptt:')) continue;
      let row = s.byGid.get(gid);
      if (!row && s.key === 'bus' && stopCoords[i]?.length >= 2) {
        const prefix = routePrefix(gid);
        if (prefix) {
          let shapeIds = s.routeShapes.get(prefix);
          if (!shapeIds) {
            const lower = `${prefix}:`;
            shapeIds = [...new Set(s.byRoute.all(lower, `${prefix};`).map((candidate) => candidate.shape))];
            s.routeShapes.set(prefix, shapeIds);
          }
          let best = null;
          for (const shapeId of shapeIds) {
            let points = s.decoded.get(shapeId);
            if (!points) {
              const blob = s.blob.get(shapeId)?.pts;
              if (!blob) continue;
              points = decodeShape(blob);
              s.decoded.set(shapeId, points);
            }
            const score = shapeMatchScore(points, stopCoords[i]);
            if (score && score.mean <= 100 && score.max <= 350 &&
                (!best || score.mean < best.score.mean || (score.mean === best.score.mean && score.max < best.score.max))) {
              best = { shape: shapeId, score };
            }
          }
          if (best) row = { shape: best.shape };
        }
      }
      if (!row) continue;
      const k = `${s.key}:${row.shape}`;
      let n = seen.get(k);
      if (n === undefined) {
        const b = s.blob.get(row.shape);
        if (!b?.pts) continue;
        n = blobs.push(Buffer.from(b.pts)) ; // číslo = pořadí od 1
        seen.set(k, n);
      }
      return n;
    }
    if (gid) unmatched.push(gid);
    return 0;
  });
  const sample = {};
  for (const s of sources) {
    try { sample[s.key] = s.db.prepare('SELECT gid FROM trip_shape LIMIT 5').all().map((r) => r.gid); } catch { sample[s.key] = []; }
    s.db.close();
  }
  const head = Buffer.alloc(4 + blobs.length * 4);
  head.writeUInt32LE(blobs.length, 0);
  let end = 0;
  blobs.forEach((b, i) => { end += b.length; head.writeUInt32LE(end, 4 + i * 4); });
  return { bin: Buffer.concat([head, ...blobs]), index, used: blobs.length, unmatched, sample };
}
