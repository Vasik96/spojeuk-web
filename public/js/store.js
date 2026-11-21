// Úložiště v zařízení (localStorage). Vše je v try/catch: v anonymním okně nebo se zakázanými daty appka dál funguje.
const NS = 'spojeuk:';

function read(key, fallback) {
  try { const v = localStorage.getItem(NS + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* ignore */ }
}

export const store = {
  get: read,
  set: write,

  /** Počty použití zastávek (kolikrát se podle nich hledalo). */
  usage() { return read('usage', {}); },
  recordUsage(place) {
    const u = read('usage', {});
    u[place] = (u[place] || 0) + 1;
    write('usage', u);
  },
  /** Odebere zastávku z často používaných. */
  forgetUsage(place) {
    const u = read('usage', {});
    delete u[place];
    write('usage', u);
  },

  lastTrip() { return read('last', null); },
  saveTrip(from, to) {
    write('last', { from, to, at: Date.now() });
    // historie hledaných spojení (hlavní obrazovka): poslední hledání nahoře, nejvýš 100, oblíbená se nezahazují
    const h = this.trips();
    const e = h.find((x) => x.from === from && x.to === to);
    if (e) e.at = Date.now(); else h.push({ from, to, at: Date.now(), pin: 0 });
    h.sort((a, b) => (b.pin > 0) - (a.pin > 0) || b.at - a.at);
    while (h.length > 100 && !h[h.length - 1].pin) h.pop();
    write('trips', h);
  },

  /** Historie hledaných spojení: [{ from, to, at, pin }], pin > 0 = oblíbené (čas připnutí). */
  trips() {
    const h = read('trips', null);
    if (Array.isArray(h)) return h.filter((x) => x && x.from && x.to);
    const last = read('last', null);   // starší verze si pamatovala jen poslední cestu
    return last?.from && last?.to ? [{ from: last.from, to: last.to, at: last.at || 0, pin: 0 }] : [];
  },
  recentTrips(limit = 15) { return this.trips().filter((x) => !x.pin).sort((a, b) => b.at - a.at).slice(0, limit); },
  pinnedTrips() { return this.trips().filter((x) => x.pin).sort((a, b) => a.pin - b.pin); },
  setPinned(from, to, on) {
    const h = this.trips();
    let e = h.find((x) => x.from === from && x.to === to);
    if (!e) { e = { from, to, at: Date.now(), pin: 0 }; h.push(e); }
    e.pin = on ? Date.now() : 0;
    write('trips', h);
  },
  /** Odebere spojení z historie; vrátí ho pro "Zpět". */
  removeTrip(from, to) {
    const h = this.trips();
    const i = h.findIndex((x) => x.from === from && x.to === to);
    if (i < 0) return null;
    const [e] = h.splice(i, 1);
    write('trips', h);
    return e;
  },
  restoreTrip(e) {
    const h = this.trips();
    if (!h.some((x) => x.from === e.from && x.to === e.to)) { h.push(e); write('trips', h); }
  },

  /** Uvítací dialog se ukazuje jen jednou. */
  welcomed() { return read('welcomed', false) === true; },
  setWelcomed() { write('welcomed', true); },

  theme() { const t = read('theme', 'auto'); return ['auto', 'light', 'dark'].includes(t) ? t : 'auto'; },
  setTheme(t) { write('theme', t); },
};
