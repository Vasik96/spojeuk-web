// Zastávky na mapě a odjezdy z nich. Port StopMap.kt z Android appky (stejná pravidla, stejné výsledky):
//  - zastávka = záznamy jízdního řádu se stejným názvem do 300 m; uvnitř místa (stanoviště) do 10 m
//  - víc míst: každé místo je jedno nástupiště; rozdělí se jen, když ho obsluhují různé proudy spojů
//    (jiná předchozí zastávka a protisměr na jiném místě, např. Stříbrníky); slabý proud (< 25 %) ne
//  - jedno místo: nástupiště podle směru jízdy (úhel předchozí → další zastávka), posunutá vpravo od silnice
//  - místo s nepatrným provozem (< 5 % odjezdů zastávky) patří k nejbližšímu většímu, vlaky mají ikonu zvlášť
//  - jeden bod jízdního řádu má nejvýš 2 nástupiště (strany silnice); víc jen zastávky s víc body
//  - počítá se ze spojů všech dnů; zastávka / nástupiště, odkud nikdy nic neodjíždí, se nezobrazí
import { addDays, distanceM, prettyName } from './util.js';

const MERGE_M = 300;
const PLACE_M = 10;
const SIDE_M = 9;
const ALONG_M = 10;
const SAME_DIR_DEG = 35;
const MINOR_SHARE = 0.25;
const OPPOSITE_DEG = 150;
const TINY_PLACE_SHARE = 0.05;
const BINS = 36;
const MAX_DIRS_PER_POINT = 2;

/**
 * Poloha vlakové ikony tam, kde vlakové záznamy jízdního řádu leží přímo v kolejišti a ikonu by zakrývaly vlaky
 * (ťuknutí by trefilo vlak): před výpravní budovou. Stejné jako RAIL_POS v StopMap.kt v appce.
 */
const RAIL_POS = {
  'Ústí nad Labem,Hlavní nádraží': [50.65951, 14.04404],
};

export const STOP_DEPARTURE_HOURS = 3;

const rad = (d) => d * Math.PI / 180;
const bin = (a) => Math.min(BINS - 1, Math.max(0, Math.floor((a + Math.PI) / (2 * Math.PI) * BINS)));
const binCenter = (b) => -Math.PI + (b + 0.5) * 2 * Math.PI / BINS;
const callKey = (prev, next) => `${prev}>${next}`;
function angleDiff(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Směr jízdy v zastávce s (jednotkový, x = východ, y = sever): předchozí → další zastávka. */
function travelDir(tt, s, prev, next) {
  const here = tt.stops[s];
  if (!here?.hasCoords) return null;
  const a = tt.stops[prev]?.hasCoords ? tt.stops[prev] : here;
  const b = tt.stops[next]?.hasCoords ? tt.stops[next] : here;
  const k = Math.cos(rad(here.lat));
  const dx = (b.lng - a.lng) * k, dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy);
  return len < 1e-7 ? null : [dx / len, dy / len];
}

/** Skupiny směrů na místě: výseč → skupina, pevné přiřazení podle (předchozí, další) má přednost. */
class DirGroups {
  constructor(binTo, means, keyTo = null) { this.binTo = binTo; this.means = means; this.keyTo = keyTo; }
  get size() { return this.means.length; }
  groupOf(prev, next, d) {
    const k = this.keyTo?.get(callKey(prev, next));
    if (k != null) return k;
    if (!d) return 0;
    const a = Math.atan2(d[1], d[0]);
    const g = this.binTo[bin(a)];
    if (g >= 0) return g;
    let best = 0, bestD = Infinity;
    this.means.forEach((m, i) => { const x = angleDiff(a, m); if (x < bestD) { bestD = x; best = i; } });
    return best;
  }
}

/** Shluky podle vzdálenosti (jednoduché spojení). */
function groupNear(items, maxM) {
  const out = [], left = items.slice();
  while (left.length) {
    const group = [left.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = left.length - 1; i >= 0; i--) {
        const c = left[i];
        if (group.some((g) => distanceM(g.lat, g.lng, c.lat, c.lng) <= maxM)) { group.push(c); left.splice(i, 1); grew = true; }
      }
    }
    out.push(group);
  }
  return out;
}

class Place {
  constructor(stops) {
    this.stops = stops.slice();
    this.lat = stops.reduce((s, x) => s + x.lat, 0) / stops.length;
    this.lng = stops.reduce((s, x) => s + x.lng, 0) / stops.length;
    this.binW = new Float64Array(BINS);
    this.calls = new Map();
    this.w = 0;
  }
  get ids() { return this.stops.map((s) => s.id).sort((a, b) => a - b); }
  absorb(o) {
    this.stops.push(...o.stops);
    for (let i = 0; i < BINS; i++) this.binW[i] += o.binW[i];
    for (const [k, c] of o.calls) {
      const t = this.calls.get(k) || this.calls.set(k, { ...c, w: 0, x: 0, y: 0 }).get(k);
      t.w += c.w; t.x += c.x; t.y += c.y;
    }
    this.w += o.w;
  }
}

function groupDirs(binW) {
  const groups = [];
  const mean = (g) => Math.atan2(g.y, g.x);
  const order = [...binW.keys()].filter((b) => binW[b] > 0).sort((a, b) => binW[b] - binW[a]);
  for (const b of order) {
    const c = binCenter(b);
    let g = null, gd = Infinity;
    for (const x of groups) { const d = angleDiff(mean(x), c); if (d <= rad(SAME_DIR_DEG) && d < gd) { gd = d; g = x; } }
    if (!g) groups.push(g = { bins: [], w: 0, x: 0, y: 0 });
    g.bins.push(b); g.w += binW[b]; g.x += Math.cos(c) * binW[b]; g.y += Math.sin(c) * binW[b];
  }
  const total = groups.reduce((s, g) => s + g.w, 0);
  for (;;) {
    const minor = groups.filter((g) => g.w / total < MINOR_SHARE).sort((a, b) => a.w - b.w)
      .find((m) => groups.some((o) => o !== m && o.w >= m.w && angleDiff(mean(o), mean(m)) < rad(OPPOSITE_DEG)));
    if (!minor) break;
    const into = groups.filter((o) => o !== minor && o.w >= minor.w)
      .reduce((a, b) => (angleDiff(mean(a), mean(minor)) <= angleDiff(mean(b), mean(minor)) ? a : b));
    into.bins.push(...minor.bins); into.w += minor.w; into.x += minor.x; into.y += minor.y;
    groups.splice(groups.indexOf(minor), 1);
  }
  // jeden bod jízdního řádu = nejvýš dvě strany silnice: další směr (boční ulice) k úhlově nejbližšímu
  groups.sort((a, b) => b.w - a.w);
  while (groups.length > MAX_DIRS_PER_POINT) {
    const minor = groups.pop();
    const into = groups.reduce((a, b) => (angleDiff(mean(a), mean(minor)) <= angleDiff(mean(b), mean(minor)) ? a : b));
    into.bins.push(...minor.bins); into.w += minor.w; into.x += minor.x; into.y += minor.y;
  }
  return groups.sort((a, b) => b.w - a.w).map((g) => ({ ...g, mean: mean(g) }));
}

/** Rozdělení místa podle proudů spojů (viz hlavička); null = nedělit. */
function splitByPartner(pl, places) {
  const partnerOf = (c) => {
    let best = null, bestW = 0;
    for (const q of places) {
      if (q === pl) continue;
      let w = 0;
      for (const o of q.calls.values()) {
        if ((o.prevName === c.nextName && c.nextName) || (o.nextName === c.prevName && c.prevName)) w += o.w;
      }
      if (w > bestW) { bestW = w; best = q; }
    }
    return best;
  };
  const byPartner = new Map();
  for (const c of [...pl.calls.values()].sort((a, b) => b.w - a.w)) {
    const p = partnerOf(c);
    (byPartner.get(p) || byPartner.set(p, []).get(p)).push(c);
  }
  const orphans = byPartner.get(null) || [];
  byPartner.delete(null);
  const sumW = (g) => g.reduce((s, c) => s + c.w, 0);
  const groups = [...byPartner.values()].sort((a, b) => sumW(b) - sumW(a));
  if (!groups.length) return null;
  groups[0].push(...orphans);
  const mainPrev = (g) => {
    const m = new Map();
    for (const c of g) m.set(c.prevName, (m.get(c.prevName) || 0) + c.w);
    return [...m].sort((a, b) => b[1] - a[1])[0][0];
  };
  for (let i = 1; i < groups.length;) {
    const into = groups.slice(0, i).find((g) => mainPrev(g) === mainPrev(groups[i]));
    if (into) { into.push(...groups[i]); groups.splice(i, 1); } else i++;
  }
  const total = groups.reduce((s, g) => s + sumW(g), 0);
  for (let i = 1; i < groups.length;) {
    if (sumW(groups[i]) / total < MINOR_SHARE) { groups[0].push(...groups[i]); groups.splice(i, 1); } else i++;
  }
  return groups.length < 2 ? null : groups;
}

/** Spoje jedoucí v den day (YYYYMMDD) i s přesahem: [trip, posun v s] (včerejší po půlnoci se posunou o -1 den). */
function tripsAround(tt, day) {
  const out = [];
  const today = tt.activeSvcs(day), yest = tt.activeSvcs(addDays(day, -1)), tom = tt.activeSvcs(addDays(day, 1));
  for (let tid = 1; tid < tt.trips.length; tid++) {
    const t = tt.trips[tid];
    if (!t) continue;
    if (today.has(t.svc)) out.push([t, 0]);
    if (yest.has(t.svc) && t.dep[t.dep.length - 1] >= 86400) out.push([t, -86400]);
    if (tom.has(t.svc)) out.push([t, 86400]);
  }
  return out;
}

export class StopIndex {
  /** @param {import('./timetable.js').Timetable} tt (směry a nástupiště ze spojů všech dnů) */
  constructor(tt) {
    this.tt = tt;
    this.dirStopsOf = new Map();
    const stops = [];

    // 1. zastávky a místa
    const byName = new Map();
    for (let id = 1; id < tt.stops.length; id++) {
      const s = tt.stops[id];
      if (!s?.hasCoords) continue;
      (byName.get(s.name) || byName.set(s.name, []).get(s.name)).push(s);
    }
    const clusters = [], placeOf = new Map(), clusterOf = new Map();
    for (const [name, list] of byName) {
      for (const group of groupNear(list, MERGE_M)) {
        const cl = { name, stops: group, ids: group.map((s) => s.id).sort((a, b) => a - b), railIds: new Set(), places: groupNear(group, PLACE_M).map((g) => new Place(g)) };
        clusters.push(cl);
        for (const id of cl.ids) clusterOf.set(id, cl);
        for (const pl of cl.places) for (const s of pl.stops) placeOf.set(s.id, pl);
      }
    }

    // 2. průjezdy autobusů (spoje všech dnů, kromě konečné), vlakové záznamy
    const nameOf = (id) => tt.stops[id]?.name || '';
    for (let tid = 1; tid < tt.trips.length; tid++) {
      const t = tt.trips[tid];
      if (!t) continue;   // (celostátní data na serveru: id spojů nejsou souvislá)
      const st = t.stops;
      for (let pos = 0; pos < st.length - 1; pos++) {
        const s = st[pos];
        if (t.isTrain) { clusterOf.get(s)?.railIds.add(s); continue; }
        const pl = placeOf.get(s);
        if (!pl) continue;
        const prev = pos > 0 ? st[pos - 1] : s, next = st[pos + 1];
        const d = travelDir(tt, s, prev, next);
        if (!d) continue;
        pl.binW[bin(Math.atan2(d[1], d[0]))] += 1;
        const k = callKey(prev, next);
        const c = pl.calls.get(k) || pl.calls.set(k, { prev, next, prevName: nameOf(prev), nextName: nameOf(next), w: 0, x: 0, y: 0 }).get(k);
        c.w += 1; c.x += d[0]; c.y += d[1];
        pl.w += 1;
      }
    }

    // 3. ikony
    for (const cl of clusters) {
      const name = prettyName(cl.name);
      const busPlaces = cl.places.filter((p) => p.w > 0).sort((a, b) => b.w - a.w);
      const totalW = busPlaces.reduce((s, p) => s + p.w, 0);
      for (const pl of busPlaces.slice().reverse()) {
        if (busPlaces.length < 2 || pl.w / totalW >= TINY_PLACE_SHARE) continue;
        const into = busPlaces.filter((q) => q !== pl && q.w >= pl.w)
          .sort((a, b) => distanceM(a.lat, a.lng, pl.lat, pl.lng) - distanceM(b.lat, b.lng, pl.lat, pl.lng))[0];
        if (!into) continue;
        into.absorb(pl);
        busPlaces.splice(busPlaces.indexOf(pl), 1);
      }
      for (const pl of busPlaces) {
        let dirs, means;
        if (busPlaces.length >= 2) {
          // víc míst: místo = jedno nástupiště, jen výjimečně rozdělené podle proudů spojů
          const split = splitByPartner(pl, busPlaces) || [[...pl.calls.values()]];
          means = split.map((g) => Math.atan2(g.reduce((s, c) => s + c.y, 0), g.reduce((s, c) => s + c.x, 0)));
          const keyTo = new Map(), binTo = new Int16Array(BINS).fill(-1);
          split.forEach((g, gi) => { for (const c of g) { keyTo.set(callKey(c.prev, c.next), gi); binTo[bin(Math.atan2(c.y, c.x))] = gi; } });
          dirs = new DirGroups(binTo, means, keyTo);
        } else {
          const groups = groupDirs(pl.binW);
          if (!groups.length) continue;
          const binTo = new Int16Array(BINS).fill(-1);
          groups.forEach((g, gi) => { for (const b of g.bins) binTo[b] = gi; });
          means = groups.map((g) => g.mean);
          dirs = new DirGroups(binTo, means);
        }
        const ids = pl.ids;
        const k = Math.cos(rad(pl.lat)) * 111_320;
        const list = means.map((mean, g) => {
          const ux = Math.cos(mean), uy = Math.sin(mean);
          let lat = pl.lat, lng = pl.lng;
          if (means.length > 1) {
            // víc nástupišť na jednom místě: vpravo od směru jízdy, podobný směr ještě rozestup podél silnice
            const along = means.length === 2 && angleDiff(means[0], means[1]) < Math.PI / 2 ? (g === 0 ? ALONG_M : -ALONG_M) : 0;
            lat += (-ux * SIDE_M + uy * along) / 110_540;
            lng += (uy * SIDE_M + ux * along) / k;
          }
          return { key: `d${ids[0]}_${g}`, lat, lng, name, ttStops: ids, kind: 'dir', dir: g, dirs };
        });
        stops.push(...list);
        for (const id of ids) this.dirStopsOf.set(id, list);
      }
      if (cl.railIds.size) {
        const src = cl.stops.filter((s) => cl.railIds.has(s.id));
        const [lat, lng] = RAIL_POS[cl.name] ||
          [src.reduce((s, x) => s + x.lat, 0) / src.length, src.reduce((s, x) => s + x.lng, 0) / src.length];
        stops.push({ key: `r${cl.ids[0]}`, name, ttStops: cl.ids, kind: 'rail', lat, lng });
      }
      // zastávka, odkud nic neodjíždí (jen výstup, zrušený záznam), se nezobrazuje
    }
    stops.sort((a, b) => a.lat - b.lat);
    this.stops = stops;
    this.byKey = new Map(stops.map((s) => [s.key, s]));
  }

  /** Zastávky v obdélníku {south, west, north, east}. */
  inView(b, limit = 1500) {
    const out = [], st = this.stops;
    let lo = 0, hi = st.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (st[mid].lat < b.south) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < st.length && st[i].lat <= b.north; i++) {
      if (st[i].lng >= b.west && st[i].lng <= b.east) { out.push(st[i]); if (out.length >= limit) break; }
    }
    return out;
  }

  /** Nástupiště, u kterého staví spoj v zastávce s (předchozí prev, další next); null = není rozdělená. */
  platformFor(s, prev, next) {
    const list = this.dirStopsOf.get(s);
    if (!list) return null;
    if (list.length === 1) return list[0];
    const g = list[0].dirs.groupOf(prev, next, travelDir(this.tt, s, prev, next));
    return list.find((x) => x.dir === g) || null;
  }

  /**
   * Polohy zastávek jízdy (pole id v pořadí jízdy) na nástupištích, jinak z jízdního řádu; pole zarovnané s ids
   * ({id, lat, lng} nebo null pro zastávku bez souřadnic).
   */
  platformPoints(ids) {
    return Array.from(ids, (id, i) => {
      const p = this.platformFor(id, ids[i - 1] ?? id, ids[i + 1] ?? id);
      if (p) return { id, lat: p.lat, lng: p.lng };
      const s = this.tt.stops[id];
      return s?.hasCoords ? { id, lat: s.lat, lng: s.lng } : null;
    });
  }

  /**
   * Odjezdy ze zastávky na mapě: { tid, day, dep (s od půlnoci dne day, může přesáhnout 24 h), line, head, isTrain }.
   * @param {{day:string, sec:number}} now
   */
  departures(stop, now, hours = STOP_DEPARTURE_HOURS, candidates = null) {
    const tt = this.tt, t0 = now.sec, t1 = t0 + hours * 3600;
    const ids = new Set(stop.ttStops);
    const out = [];
    // candidates: [spoj (s časy dep), posun v s] jen spojů přes zastávku (server s celostátními daty), jinak všechny
    for (const [t, shift] of candidates || tripsAround(tt, now.day)) {
      const st = t.stops;
      for (let pos = 0; pos < st.length - 1; pos++) {
        if (!ids.has(st[pos])) continue;
        const dep = t.dep[pos] + shift;
        if (dep < t0 || dep > t1) continue;
        if (stop.kind === 'rail' && !t.isTrain) continue;
        if (stop.kind === 'dir') {
          if (t.isTrain) continue;
          if (stop.dirs.size > 1) {
            const s = st[pos], prev = pos > 0 ? st[pos - 1] : s, next = st[pos + 1];
            if (stop.dirs.groupOf(prev, next, travelDir(tt, s, prev, next)) !== stop.dir) continue;
          }
        }
        const head = t.head || tt.stops[st[st.length - 1]]?.name || '';
        out.push({ tid: t.id, day: now.day, dep, line: t.line, head: prettyName(head), isTrain: t.isTrain, from: st[pos] });
      }
    }
    out.sort((a, b) => a.dep - b.dep);
    return out;
  }
}
