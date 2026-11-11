#!/usr/bin/env node
// Sestaví public/data/timetable.json z regionálního GTFS (stejný zdroj jako Android appka).
//
//   node scripts/build-data.mjs                       stáhne aktuální release z GitHubu
//   node scripts/build-data.mjs --jdf a.zip --rail b.zip   použije lokální soubory
//   --shapes-bus a.sqlite --shapes-train b.sqlite   lokální trasy (jinak release "shapes")
//   --out <složka>   (výchozí public/data)
//   --base <url>     (výchozí release "gtfs" z Vasik96/spojeuk-data)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimetable } from '../lib/build-timetable.mjs';
import { buildShapePack, SHAPES_URL } from '../lib/shapes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', process.env.GTFS_BASE_URL || 'https://github.com/Vasik96/spojeuk-data/releases/download/gtfs');
const outDir = path.resolve(arg('out', path.join(root, 'public', 'data')));

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'spojeuk-web/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function build({ jdf, rail, tag, shapesBus, shapesTrain } = {}) {
  const read = async (local, name) => (local ? fs.readFileSync(local) : download(`${BASE}/${name}`));
  const [jdfZip, railZip] = await Promise.all([read(jdf, 'jdf-region.zip'), read(rail, 'czptt-region.zip')]);
  if (tag === undefined) {
    try { tag = JSON.parse((await download(`${BASE}/gtfs.json`)).toString()).tag ?? ''; } catch { tag = ''; }
  }
  const data = buildTimetable([{ zip: jdfZip, rail: false }, { zip: railZip, rail: true }], { tag, log: (s) => console.log(s) });
  fs.mkdirSync(outDir, { recursive: true });

  // přesné trasy spojů (shapes); bez nich appka kreslí rovné čáry mezi zastávkami
  try {
    const shapesBase = process.env.SHAPES_BASE_URL || SHAPES_URL;
    const tmpDir = fs.mkdtempSync(path.join(outDir, '.shapes-'));
    const get = async (local, name) => { if (local) return local; const f = path.join(tmpDir, name); fs.writeFileSync(f, await download(`${shapesBase}/${name}`)); return f; };
    const files = { bus: await get(shapesBus, 'shapes.sqlite'), train: await get(shapesTrain, 'train_shapes.sqlite') };
    const gidList = data.trips.map((t) => t[13]);
    const stopCoords = data.trips.map((t) => t[9].map((id) => {
      const stop = data.stops[id - 1];
      return stop && (stop[2] !== 0 || stop[3] !== 0) ? [stop[2], stop[3]] : null;
    }).filter(Boolean));
    const pack = await buildShapePack(gidList, files, stopCoords);
    data.trips.forEach((t, i) => { t[13] = pack.index[i]; });
    fs.writeFileSync(path.join(outDir, 'shapes.bin'), pack.bin);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Trasy: ${pack.index.filter(Boolean).length}/${data.trips.length} spojů, ${pack.used} tvarů, ${(pack.bin.length / 1e6).toFixed(2)} MB`);
    if (pack.unmatched.length) {
      // které linky zůstaly bez tvaru + ukázka trip_id (porovnej s gid v shapes.sqlite)
      const byLine = new Map();
      data.trips.forEach((t, i) => { if (!pack.index[i]) { const e = byLine.get(t[0]) || { n: 0, gid: gidList[i] }; e.n++; byLine.set(t[0], e); } });
      console.warn(`POZOR: ${pack.unmatched.length} spojů bez tvaru (použije se OSRM). Linky: ` + [...byLine].sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([l, e]) => `${l}×${e.n} (např. ${e.gid})`).join(', '));
      console.warn('Ukázka gid v shapes.sqlite:', JSON.stringify(pack.sample));
    }
    try { const j = async (n) => JSON.parse((await download(`${shapesBase}/${n}`)).toString()).built ?? ''; data.meta.shapes = `${await j('shapes.json')}|${await j('train_shapes.json')}`; } catch { data.meta.shapes = ''; }
  } catch (e) {
    console.warn(`Trasy spojů se nepodařilo sestavit (${e.message}); appka použije rovné čáry mezi zastávkami.`);
    data.trips.forEach((t) => { t[13] = 0; });
    fs.rmSync(path.join(outDir, 'shapes.bin'), { force: true });
    for (const d of fs.readdirSync(outDir)) if (d.startsWith('.shapes-')) fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
  }
  const json = JSON.stringify(data);
  const tmp = path.join(outDir, 'timetable.json.tmp');
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, path.join(outDir, 'timetable.json'));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ ...data.meta, bytes: json.length }));
  console.log(`Hotovo: ${data.meta.trips} spojů, ${data.meta.stops} zastávek, ${(json.length / 1e6).toFixed(2)} MB → ${outDir}`);
  return data.meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ jdf: arg('jdf'), rail: arg('rail'), tag: arg('tag'), shapesBus: arg('shapes-bus'), shapesTrain: arg('shapes-train') }).catch((e) => { console.error('Chyba:', e.message); process.exit(1); });
}
