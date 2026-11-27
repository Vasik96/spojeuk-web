// Druh dopravy linek, který jízdní řád nemá (trolejbus, tramvaj mimo Prahu jsou v GTFS „autobus“). Server u živých
// vozů posílá `mode`; jakmile se vůz spáruje se spojem, zapamatuje se druh pro dvojici dopravce + linka a odjezdy,
// výsledky i trasy z jízdního řádu pak mají správnou barvu (jako LineKinds v appce). Učí se jen jiné druhy než
// autobus, takže výluka (autobusy na trolejbusové lince) nic nepřepíše.
import { store } from './store.js';

const LEARNABLE = new Set(['trolleybus', 'tram', 'metro', 'ferry', 'funicular']);
let kinds = null;

const key = (agency, line) => `${String(agency ?? '').trim()}|${String(line ?? '').trim().toUpperCase()}`;

function load() {
  if (!kinds) {
    const o = store.get('lineKinds', {});
    kinds = new Map(Object.entries(o && typeof o === 'object' ? o : {}));
  }
  return kinds;
}

/** Druh linky ze živých dat, null = nezjištěno. */
export function lineKind(agency, line) {
  const k = load();
  return k.size ? k.get(key(agency, line)) ?? null : null;
}

export function learnLineKind(agency, line, mode) {
  if (!LEARNABLE.has(mode) || !agency || !line || line === '?') return;
  const k = load(), kk = key(agency, line);
  if (k.get(kk) === mode) return;
  k.set(kk, mode);
  store.set('lineKinds', Object.fromEntries(k));
}

/** Jen pro testy. */
export function resetLineKinds() { kinds = new Map(); }
