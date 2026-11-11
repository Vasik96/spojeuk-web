// Slučování vozidel z více zdrojů (DPMÚL, DÚK, SŽ). Port VehicleFusion.kt.
//  1. stejný vůz = stejné ID (autobus) / číslo vlaku, jinak stejná linka do SAME_SPOT_M metrů; z jednoho zdroje max. jeden;
//  2. ze skupiny vyhrává čerstvější poloha (rozdíl > FRESH_SLACK_S), při shodě zdroj s vyšší prioritou;
//  3. vůz, který zná jen jeden zdroj, se zahodí, když je zastaralý a jiný zdroj s vyšší prioritou ten segment čerstvě pokrývá (duch).
import { distanceM, normLine } from '../public/js/util.js';

const SAME_SPOT_M = 150, FRESH_SLACK_S = 5;

/** Základní číslo ústeckého vozu bez předpony 30 a nul (300451 → 451, 301212 → 1212, 451 → 451). */
export function baseVehicleId(id) {
  if (!(id > 0)) return 0;
  const s = String(id);
  if (s.length >= 4 && s[0] === '3' && s[1] === '0') {
    const rest = s.slice(2).replace(/^0+/, '');
    const base = parseInt(rest, 10);
    if (rest && base > 0) return base;
  }
  return id;
}

export function sameVehicleId(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  return a === b || baseVehicleId(a) === baseVehicleId(b);
}

const trainNo = (v) => (v.train ? String(v.cis || '').trim().replace(/^0+/, '') : '');

function sameVehicle(a, b) {
  if (a.train || b.train) {
    const na = trainNo(a), nb = trainNo(b);
    if (na && na === nb) return true;
    if (na && nb) return false; // jiné číslo vlaku = jiný vlak
  } else if (a.id && b.id) {
    return sameVehicleId(a.id, b.id);
  }
  if (normLine(a.line) !== normLine(b.line)) return false;
  const ageDiff = Math.min(120, Math.abs(a.ageSec - b.ageSec));
  return distanceM(a.lat, a.lng, b.lat, b.lng) <= SAME_SPOT_M + ageDiff * 15; // autobus ujede až ~15 m/s
}

/** Vítěz skupiny: čerstvější poloha, při shodě vyšší priorita (skupina je řazená podle priority). */
function resolve(group) {
  const winner = group.reduce((a, b) => {
    if (a.ageSec + FRESH_SLACK_S < b.ageSec) return a;
    if (b.ageSec + FRESH_SLACK_S < a.ageSec) return b;
    return a;
  });
  const others = group.filter((v) => v !== winner);
  const pick = (k, empty) => (winner[k] !== empty ? winner[k] : others.map((o) => o[k]).find((x) => x !== empty) ?? empty);
  return {
    ...winner,
    train: group.some((v) => v.train),
    // číslo spoje zná jen DÚK/SŽ; patří stejnému vozu, takže se doplní i když vyhrála poloha z DPMÚL
    cis: pick('cis', ''), trip: pick('trip', ''),
    dest: pick('dest', ''),
    low: pick('low', null), ac: pick('ac', null),
    heading: pick('heading', null),
    sources: group.map((v) => v.source),
    ids: group.filter((v) => v.id).map((v) => `${v.source}:${v.id}`), // jako Vehicle.uid v Androidu: dpmul:603, duk:300603, train:1153
  };
}

/**
 * @param {{id:string, priority:number, segments:Set<string>, health:'live'|'stale'|'down', staleVehicleSec:number, vehicles:object[]}[]} inputs
 * @returns {object[]} sloučená vozidla
 */
export function fuse(inputs) {
  const ordered = [...inputs].sort((a, b) => a.priority - b.priority);
  const byId = new Map(ordered.map((i) => [i.id, i]));
  const out = [];
  for (const segment of ['city', 'regional']) {
    const groups = [];
    for (const input of ordered) {
      for (const v of input.vehicles) {
        if (v.segment !== segment) continue;
        let target = null, best = Infinity;
        for (const g of groups) {
          if (g.some((x) => x.source === v.source) || !sameVehicle(g[0], v)) continue;
          const d = distanceM(g[0].lat, g[0].lng, v.lat, v.lng);
          if (d < best) { best = d; target = g; }
        }
        if (target) target.push(v); else groups.push([v]);
      }
    }
    for (const g of groups) {
      if (g.length > 1) { out.push(resolve(g)); continue; }
      const v = g[0], own = byId.get(v.source);
      const ghost = own && v.ageSec > own.staleVehicleSec &&
        ordered.some((o) => o.priority < own.priority && o.health === 'live' && o.segments.has(segment));
      if (!ghost) out.push({ ...v, sources: [v.source], ids: v.id ? [`${v.source}:${v.id}`] : [] });
    }
  }
  return out;
}
