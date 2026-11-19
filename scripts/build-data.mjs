#!/usr/bin/env node
// Sestaví public/data/timetable.json (+ shapes.bin) pro prohlížeč a stáhne data pro server do data/.
//
// Výchozí cesta: hotová celostátní databáze timetable.sqlite z releasu spojeuk-data (stejná jako v Android appce).
// Prohlížeč dostane jen spoje oblasti (lib/build-from-db.mjs), server si DB nechá pro dohledání vozidel mimo oblast
// (lib/trip-lookup.mjs). Velké soubory se stahují a rozbalují proudově rovnou na disk: sestavení se vejde
// i na 1GB VPS (dřív se celostátní GTFS zip parsoval v paměti a spadlo na "JavaScript heap out of memory").
//
//   node scripts/build-data.mjs                            stáhne aktuální release z GitHubu
//   node scripts/build-data.mjs --jdf a.zip --rail b.zip   z lokálních GTFS zipů (starý způsob, náročný na paměť)
//   --shapes-bus a.sqlite --shapes-train b.sqlite          lokální trasy (jinak release "shapes")
//   --out <složka>     (výchozí public/data)
//   --lookup <složka>  (výchozí data/, nebo LOOKUP_DIR)
//   --base <url>       (výchozí release "gtfs" z Vasik96/spojeuk-data)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { buildTimetable } from '../lib/build-timetable.mjs';
import { buildTimetableFromDb } from '../lib/build-from-db.mjs';
import { buildShapePack, SHAPES_URL } from '../lib/shapes.mjs';
import { LOOKUP_FILES } from '../lib/trip-lookup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', process.env.GTFS_BASE_URL || 'https://github.com/Vasik96/spojeuk-data/releases/download/gtfs');
const SHAPES_BASE = process.env.SHAPES_BASE_URL || SHAPES_URL;
const outDir = path.resolve(arg('out', path.join(root, 'public', 'data')));
// soubory jen pro server (dohledání spoje vozidla mimo oblast): celostátní DB a tvary tras, NEservírují se ven
export const LOOKUP_DIR = path.resolve(process.env.LOOKUP_DIR || arg('lookup', path.join(root, 'data')));

async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'spojeuk-web/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}
async function download(url) { return Buffer.from(await (await fetchOk(url)).arrayBuffer()); }
const json = async (url) => JSON.parse((await download(url)).toString());

/**
 * Stáhne [url] proudově do [dest] (přes dočasný soubor). gunzip = rozbalit cestou; sha256 = kontrola staženého.
 */
async function downloadTo(url, dest, { gunzip = false, sha256 = null } = {}) {
  const res = await fetchOk(url);
  const tmp = `${dest}.tmp`;
  const hash = crypto.createHash('sha256');
  const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body), tap, ...(gunzip ? [zlib.createGunzip()] : []), fs.createWriteStream(tmp));
    if (sha256 && hash.digest('hex') !== sha256) throw new Error(`kontrolní součet ${path.basename(url)} nesedí`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Celostátní jízdní řád (timetable.sqlite) a tvary tras do [LOOKUP_DIR]. DB se stahuje jen při změně.
 * @returns {Promise<{tag: string, db: string}>}
 */
export async function fetchLookup(info) {
  fs.mkdirSync(LOOKUP_DIR, { recursive: true });
  info ||= await json(`${BASE}/gtfs.json`);
  const db = info.db;
  if (!db?.name) throw new Error('gtfs.json nemá db');
  const stamp = path.join(LOOKUP_DIR, 'timetable.tag');
  const dest = path.join(LOOKUP_DIR, LOOKUP_FILES.db);
  const want = `${info.tag}|${db.sha256}`;
  if (!(fs.existsSync(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want)) {
    console.log(`Stahuji celostátní jízdní řád (${(db.size / 1e6).toFixed(0)} MB)…`);
    await downloadTo(`${BASE}/${db.name}`, dest, { gunzip: true, sha256: db.sha256 || null });
    fs.writeFileSync(stamp, want);
    console.log(`Celostátní jízdní řád: ${db.trips} spojů`);
  }
  for (const k of ['bus', 'train', 'pid']) await downloadTo(`${SHAPES_BASE}/${LOOKUP_FILES[k]}`, path.join(LOOKUP_DIR, LOOKUP_FILES[k]));
  return { tag: info.tag ?? '', db: dest };
}

export async function build({ jdf, rail, tag, shapesBus, shapesTrain } = {}) {
  const log = (s) => console.log(s);
  let data;
  let shapeFiles;
  if (jdf || rail) {
    // starý způsob z lokálních GTFS zipů (testy, ladění)
    const [jdfZip, railZip] = [fs.readFileSync(jdf), fs.readFileSync(rail)];
    data = buildTimetable([{ zip: jdfZip, rail: false }, { zip: railZip, rail: true }], { tag: tag ?? '', log });
  } else {
    const info = await json(`${BASE}/gtfs.json`);
    const l = await fetchLookup(info);
    data = await buildTimetableFromDb(l.db, { tag: tag ?? l.tag, log });
  }
  shapeFiles = {
    bus: shapesBus || path.join(LOOKUP_DIR, LOOKUP_FILES.bus),
    train: shapesTrain || path.join(LOOKUP_DIR, LOOKUP_FILES.train),
  };
  fs.mkdirSync(outDir, { recursive: true });

  // přesné trasy spojů (shapes); bez nich appka kreslí rovné čáry mezi zastávkami
  try {
    if (!fs.existsSync(shapeFiles.bus)) await fetchLookup();
    const gidList = data.trips.map((t) => t[13]);
    const stopCoords = data.trips.map((t) => t[9].map((id) => {
      const stop = data.stops[id - 1];
      return stop && (stop[2] !== 0 || stop[3] !== 0) ? [stop[2], stop[3]] : null;
    }).filter(Boolean));
    const pack = await buildShapePack(gidList, shapeFiles, stopCoords);
    data.trips.forEach((t, i) => { t[13] = pack.index[i]; });
    fs.writeFileSync(path.join(outDir, 'shapes.bin'), pack.bin);
    console.log(`Trasy: ${pack.index.filter(Boolean).length}/${data.trips.length} spojů, ${pack.used} tvarů, ${(pack.bin.length / 1e6).toFixed(2)} MB`);
    if (pack.unmatched.length) {
      // které linky zůstaly bez tvaru + ukázka trip_id (porovnej s gid v shapes.sqlite)
      const byLine = new Map();
      data.trips.forEach((t, i) => { if (!pack.index[i]) { const e = byLine.get(t[0]) || { n: 0, gid: gidList[i] }; e.n++; byLine.set(t[0], e); } });
      console.warn(`POZOR: ${pack.unmatched.length} spojů bez tvaru (použije se OSRM). Linky: ` + [...byLine].sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([ln, e]) => `${ln}×${e.n} (např. ${e.gid})`).join(', '));
    }
    try { const j = async (n) => (await json(`${SHAPES_BASE}/${n}`)).built ?? ''; data.meta.shapes = `${await j('shapes.json')}|${await j('train_shapes.json')}`; } catch { data.meta.shapes = ''; }
  } catch (e) {
    console.warn(`Trasy spojů se nepodařilo sestavit (${e.message}); appka použije rovné čáry mezi zastávkami.`);
    data.trips.forEach((t) => { t[13] = 0; });
    fs.rmSync(path.join(outDir, 'shapes.bin'), { force: true });
  }

  const out = JSON.stringify(data);
  const tmp = path.join(outDir, 'timetable.json.tmp');
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, path.join(outDir, 'timetable.json'));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ ...data.meta, bytes: out.length }));
  console.log(`Hotovo: ${data.meta.trips} spojů, ${data.meta.stops} zastávek, ${(out.length / 1e6).toFixed(2)} MB → ${outDir}`);
  return data.meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ jdf: arg('jdf'), rail: arg('rail'), tag: arg('tag'), shapesBus: arg('shapes-bus'), shapesTrain: arg('shapes-train') }).catch((e) => { console.error('Chyba:', e.message); process.exit(1); });
}
