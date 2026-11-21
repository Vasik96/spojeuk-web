// Čistá logika nad spojením (bez DOM a jízdního řádu), stejná pravidla jako JourneyLogic.kt v Android appce.
// Úseky spojení: { kind: 'ride' | 'walk', dep, arr, tid?, from?, to?, stops? }, časy v s od půlnoci dne spojení.

/** Indexy jízd (ne chůze) v poli úseků. */
export const rideIndices = (legs) => legs.map((l, i) => (l.kind === 'walk' ? -1 : i)).filter((i) => i >= 0);

/** Po kolika sekundách od odjezdu jízdy (vč. zpoždění) ukazuje mapa už další jízdu spojení. */
export const LEG_SWITCH_AFTER_SEC = 180;

/**
 * Která jízda je pro tlačítko Mapa "aktuální": první, dokud z nástupní zastávky neodjela před víc než
 * 3 minutami (odjezd podle JŘ + živé zpoždění v min z delayMin(index)), pak další atd.
 */
export function activeLegIndex(legs, nowSec, delayMin = () => 0) {
  const rides = rideIndices(legs);
  if (rides.length <= 1) return rides[0] ?? 0;
  for (const i of rides.slice(0, -1)) {
    if (nowSec <= legs[i].dep + delayMin(i) * 60 + LEG_SWITCH_AFTER_SEC) return i;
  }
  return rides[rides.length - 1];
}

/**
 * Přestup k (mezi k-tou a (k+1)-tou jízdou) po započtení živých zpoždění (delays: index jízdy → min).
 * Vyhodnocuje se jen se zpožděním přijíždějící jízdy a jen dokud se nepřestoupilo. Zpoždění navazující jízdy
 * rezervu prodlouží (na předčasný odjezd se nespoléhá), chůze mezi zastávkami ji zkrátí.
 * @returns {{ risk: 'none'|'tight'|'risk', marginMin: number, delayMin: number } | null}
 */
export function transferStatus(legs, k, delays, nowSec) {
  const rides = rideIndices(legs);
  const a = rides[k], b = rides[k + 1];
  if (a == null || b == null) return null;
  const d1 = delays.get?.(a) ?? delays[a];
  if (d1 == null) return null;
  const d2 = Math.max(0, delays.get?.(b) ?? delays[b] ?? 0);
  if (nowSec > legs[b].dep + d2 * 60) return null;           // navazující už odjel, přestup je minulost
  let walkSec = 0;
  for (let i = a + 1; i < b; i++) if (legs[i].kind === 'walk') walkSec += legs[i].arr - legs[i].dep;
  const marginSec = legs[b].dep - legs[a].arr - walkSec - d1 * 60 + d2 * 60;
  const risk = d1 <= 0 ? 'none' : marginSec < 0 ? 'risk' : marginSec < 120 ? 'tight' : 'none';
  return { risk, marginMin: Math.floor(marginSec / 60), delayMin: d1 };
}

/** Spojení s příjezdem nejpozději v deadlineSec (stejný den): vyhovující, seřazená podle odjezdu. */
export function arrivingBy(journeys, day, deadlineSec, dayDiff) {
  return journeys
    .filter((j) => j.arr + dayDiff(day, j.day) * 86400 <= deadlineSec)
    .sort((x, y) => (x.dep + dayDiff(day, x.day) * 86400) - (y.dep + dayDiff(day, y.day) * 86400));
}

/** Nejmenší vzdálenost bodu od lomené čáry v metrech (rovinná aproximace). points = [[lat, lng], …] */
export function distanceToRouteM(lat, lng, points) {
  if (!points?.length) return Infinity;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  const X = (p) => (p[1] - lng) * kx, Y = (p) => (p[0] - lat) * ky;
  if (points.length === 1) return Math.hypot(X(points[0]), Y(points[0]));
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = X(points[i]), ay = Y(points[i]), dx = X(points[i + 1]) - ax, dy = Y(points[i + 1]) - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, (-ax * dx - ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
