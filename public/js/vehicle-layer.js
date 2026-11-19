// Vozidla na mapě: vlastní canvas nad MapLibre (port GoogleDotOverlay / GoogleVehicleLayer z Android appky).
//
// Dřív bylo každé vozidlo DOM značka. S celostátním feedem je to ~3 000 elementů, které prohlížeč při každém
// pohybu mapy přepočítává, takže mapa výrazně zpomalila. Tady je celý snímek jeden canvas: tečky a štítky
// jsou předkreslené bitmapy (cache podle barvy / linky), pozice se počítají z kamery (Web Mercator), kreslí se jen
// to, co je v záběru, a mapové jádro o vozidlech neví.
//
// Oddáleno (pod DOT_ZOOM) malé barevné tečky, přiblíženo štítky s číslem linky. Přechod mezi nimi i objevení
// vozidel po otevření mapy se plynule prolíná ([Fade]). Vozidla stojí na poslední poloze ze serveru (web nic
// nepředpovídá) a k nové poloze se jen krátce přesunou ([MOVE_MS]).

export const DOT_ZOOM = 11;           // stejně jako DOT_ZOOM_ML v appce (MapLibre má stejné zoomy jako web)
const DOT_HYST = 0.15;                // hystereze proti blikání na hranici
const LABEL_MAX = 1500;               // víc štítků v záběru = nečitelné a drahé: zůstanou tečky
const TELEPORT_M = 3000;              // skok větší než tohle se neanimuje (jiný spoj, chyba polohy)
const STALE_S = 60;                   // starší poloha: poloprůhledně (jako v appce)
const MOVE_MS = 1000;                 // přesun na novou polohu ze serveru (bez předpovědi pohybu)

/** Barvy a druhy vozidel (VehicleStyle v appce). */
export const STYLES = {
  BUS: { color: '#2E7D32' },
  BUS_LATE: { color: '#C62828' },
  TRAIN: { color: '#0277BD' },
  TRAM: { color: '#7B1FA2' },
  METRO_A: { color: '#00A562' },
  METRO_B: { color: '#F8B322', darkText: true },
  METRO_C: { color: '#D6006F' },     // malinová: oficiální červená C splývala se zpožděnými autobusy
  METRO: { color: '#37474F' },
  FERRY: { color: '#1565C0' },
  FUNICULAR: { color: '#6D4C41' },
};
export const LATE_COLOR = '#D32F2F';
const HL_COLORS = ['#FFD54F', '#FF6D00'];   // krátké upozornění na vůz (po „Mapa“ u spojení na mobilu)
const SEL_RING = 'rgba(61, 157, 232, .55)';  // vybrané vozidlo: modrý kroužek jako dřívější .veh.sel

/** Druh dopravy: ze serveru (`mode`), u starších odpovědí odvozený z PID uid ("g0:…" tramvaj) a linek metra. */
export function vehicleMode(v) {
  if (v.mode) return v.mode === 'trolleybus' ? 'bus' : v.mode;
  if (v.train) return 'train';
  const m = /^g(\d+):/.exec(v.uid || '');
  if (m) return { 0: 'tram', 1: 'metro', 2: 'train', 4: 'ferry', 7: 'funicular' }[m[1]] || 'bus';
  if (v.source === 'pid' && /^[ABC]$/i.test(String(v.line).trim())) return 'metro';
  return 'bus';
}

export function vehicleStyle(v) {
  switch (vehicleMode(v)) {
    case 'train': return 'TRAIN';
    case 'tram': return 'TRAM';
    case 'ferry': return 'FERRY';
    case 'funicular': return 'FUNICULAR';
    case 'metro': return { A: 'METRO_A', B: 'METRO_B', C: 'METRO_C' }[String(v.line).trim().toUpperCase()] || 'METRO';
    default: return v.delay > 3 ? 'BUS_LATE' : 'BUS';
  }
}

/** Kategorie pro filtr na mapě (trolejbusy patří k autobusům). */
export function vehicleCategory(v) {
  const s = vehicleStyle(v);
  if (s === 'TRAIN') return 'train';
  if (s === 'TRAM') return 'tram';
  if (s.startsWith('METRO')) return 'metro';
  return 'bus';
}
export const CATEGORIES = [
  { id: 'bus', label: 'Autobusy', note: 'včetně trolejbusů' },
  { id: 'tram', label: 'Tramvaje' },
  { id: 'metro', label: 'Metro' },
  { id: 'train', label: 'Vlaky' },
];

/** Zpoždění tramvaje / metra (u nich barva zpoždění neukazuje): červený rámeček kolem štítku / tečky. */
export function lateMinutes(v) {
  const s = vehicleStyle(v);
  return (s === 'TRAM' || s.startsWith('METRO')) && v.delay > 3 ? Math.min(99, v.delay) : 0;
}

// ───────────── bitmapy ─────────────

const FONT = '700 {px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (px) => FONT.replace('{px}', px.toFixed(2));

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Štítek s číslem linky (createLineMarkerDrawable v appce). Velikosti v CSS px, bitmapa v rozlišení displeje.
 * phase 0 = běžný, 1/2 = blikání při upozornění na vůz, 3 = vybraný (o 20 % větší, s modrým kroužkem, nebliká).
 * late = červený rámeček KOLEM štítku (barevná část zůstane stejně velká).
 */
function drawLabel(line, styleKey, phase, late, dpr) {
  if (phase === 3) return drawSelected(line, styleKey, late, dpr);
  const st = STYLES[styleKey] || STYLES.BUS;
  const hl = phase !== 0;
  const textPx = phase === 1 ? 17 : phase === 2 ? 15 : 13;
  const hPx = phase === 1 ? 38 : phase === 2 ? 32 : 26;
  let pad = hl ? 26 : 18;
  const maxW = hl ? 84 : 72;
  const meas = canvas(1, 1).getContext('2d');
  let size = textPx;
  meas.font = font(size);
  if (line.length > 3) {
    pad = hl ? 20 : 12;
    const full = meas.measureText(line).width;
    if (full > maxW - pad) { size = Math.max(8, size * (maxW - pad) / full); meas.font = font(size); }
  }
  const tw = meas.measureText(line).width;
  const pillW = Math.max(36, Math.ceil(tw + pad));
  const ring = late && !hl ? 4 : 0;
  const w = pillW + 2 * ring, h = hPx + 2 * ring;
  const c = canvas(w * dpr, h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  if (ring) { g.fillStyle = LATE_COLOR; roundRect(g, 0, 0, w, h, h / 2); g.fill(); }
  const stroke = hl ? 2.5 : 0;
  const ins = stroke / 2;
  g.fillStyle = hl ? HL_COLORS[phase - 1] : st.color;
  roundRect(g, ring + ins, ring + ins, pillW - 2 * ins, hPx - 2 * ins, (hPx - 2 * ins) / 2);
  g.fill();
  if (hl) { g.strokeStyle = '#fff'; g.lineWidth = stroke; g.stroke(); }
  g.fillStyle = phase === 1 || (!hl && st.darkText) ? '#000' : '#fff';
  g.font = font(size);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(line, w / 2, h / 2 + size * 0.04);
  return { img: c, w, h };
}

/** Vybrané vozidlo: běžný štítek zvětšený o 20 % s modrým kroužkem kolem (jako dřívější DOM značka .veh.sel). */
function drawSelected(line, styleKey, late, dpr) {
  const base = drawLabel(line, styleKey, 0, late, dpr * 1.2);
  const ring = 4;
  const w = base.w * 1.2 + 2 * ring, h = base.h * 1.2 + 2 * ring;
  const c = canvas(w * dpr, h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = SEL_RING;
  roundRect(g, 0, 0, w, h, h / 2); g.fill();
  g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 8; g.shadowOffsetY = 2;
  g.drawImage(base.img, ring, ring, w - 2 * ring, h - 2 * ring);
  return { img: c, w, h };
}

/** Malá tečka (~9 px) v barvě vozu se světlým okrajem; zpožděná tramvaj / metro: okraj červený a silnější. */
function drawDot(color, late, dpr) {
  const d = late ? 11 : 9;
  const c = canvas(d * dpr, d * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const r = d / 2;
  g.fillStyle = late ? LATE_COLOR : 'rgba(255,255,255,.8)';
  g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = color;
  g.beginPath(); g.arc(r, r, r - (late ? 2.2 : 1.2), 0, Math.PI * 2); g.fill();
  return { img: c, w: d, h: d };
}

// ───────────── prolínání (VehicleFade v appce) ─────────────

/**
 * Průběh se posouvá po snímcích a jeden snímek ho posune nejvýš o MAX_STEP ms: při zaseknutí (načítání dat,
 * stovky nových štítků) se animace jen zpomalí, ale je vidět. Přechod na štítky počká, než jsou nakreslené.
 */
class Fade {
  static APPEAR = 700; static SWITCH = 380; static MAX_STEP = 34; static HOLD_MAX = 600;
  constructor() { this.appearT = -1; this.switchT = 1; this.hold = 0; this.last = 0; this.dotMode = true; }
  startAppear() { if (this.appearT < 0) this.appearT = 0; }
  resetAppear() { this.appearT = -1; }
  setDotMode(dot) { if (dot === this.dotMode) return; this.dotMode = dot; this.switchT = 1 - this.switchT; this.hold = 0; }
  initDotMode(dot) { this.dotMode = dot; this.switchT = 1; }
  tick(now, labelsPending = false) {
    const dt = this.last ? Math.min(Fade.MAX_STEP, Math.max(0, now - this.last)) : 16;
    this.last = now;
    if (this.appearT >= 0 && this.appearT < 1) this.appearT = Math.min(1, this.appearT + dt / Fade.APPEAR);
    if (this.switchT < 1) {
      if (labelsPending && !this.dotMode && this.hold < Fade.HOLD_MAX) this.hold += dt;
      else this.switchT = Math.min(1, this.switchT + dt / Fade.SWITCH);
    }
  }
  get appear() { return this.appearT < 0 ? 0 : ease(this.appearT); }
  get switching() { return this.switchT < 1; }
  get dotAlpha() { return ease(this.dotMode ? this.switchT : 1 - this.switchT); }
  get labelAlpha() { return ease(this.dotMode ? 1 - this.switchT : this.switchT); }
  get animating() { return this.switching || (this.appearT >= 0 && this.appearT < 1); }
}
const ease = (t) => t * t * (3 - 2 * t);

// ───────────── vrstva ─────────────

const wxOf = (lng) => (lng + 180) / 360;
const wyOf = (lat) => {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const M_PER_DEG = 111_320;

export class VehicleLayer {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {{onTap?: (vehicles: object[]) => void}} opts
   */
  constructor(map, { onTap } = {}) {
    this.map = map;
    this.onTap = onTap;
    this.items = new Map();      // uid → {v, fx, fy, tx, ty, t0, dur, born, key}
    this.order = [];             // pevné pořadí kreslení (podle uid) = stabilní překrývání
    this.filter = null;          // Set kategorií, null = vše
    this.selected = null; this.flash = null;
    this.fade = new Fade();
    this.labels = new Map(); this.dots = new Map();
    this.labelQueue = new Map(); // klíč → parametry: štítky se kreslí po dávkách, ať se snímek nezasekne
    this.screen = [];            // poslední nakreslené pozice (hit test)
    this.visible = true;
    this._dpr = 0;

    const cv = (this.canvas = document.createElement('canvas'));
    cv.className = 'veh-canvas';
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1';
    map.getContainer().append(cv);
    this.g = cv.getContext('2d');
    this._resize();
    map.on('resize', () => this._resize());
    map.on('render', () => this._draw(performance.now(), true));   // pohyb kamery: kreslí se ve snímku mapy
    map.on('click', (e) => this._click(e));
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = this.hitTest(e.point.x, e.point.y).length ? 'pointer' : ''; });
    this.fade.initDotMode(map.getZoom() < DOT_ZOOM);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ───── data ─────

  /** Nové polohy ze serveru. Vozidla se k nim plynule přesunou (za dobu do příští aktualizace). */
  setVehicles(list) {
    const now = performance.now();
    const seen = new Set();
    let added = false;
    for (const v of list) {
      const uid = v.uid;
      seen.add(uid);
      const tx = wxOf(v.lng), ty = wyOf(v.lat);
      const it = this.items.get(uid);
      if (!it) {
        this.items.set(uid, { v, fx: tx, fy: ty, tx, ty, t0: now, dur: 0, born: now });
        added = true;
        continue;
      }
      it.v = v;
      if (it.tx === tx && it.ty === ty) continue;
      const [cx, cy] = this._pos(it, now);
      const distM = Math.hypot((tx - cx) * 360 * M_PER_DEG * Math.cos((v.lat * Math.PI) / 180), (ty - cy) * 360 * M_PER_DEG);
      if (distM > TELEPORT_M) { it.fx = tx; it.fy = ty; it.dur = 0; }
      else { it.fx = cx; it.fy = cy; it.dur = MOVE_MS; }
      it.tx = tx; it.ty = ty; it.t0 = now;
      this._moveUntil = now + MOVE_MS;
    }
    for (const uid of this.items.keys()) if (!seen.has(uid)) this.items.delete(uid);
    if (added || this.order.length !== this.items.size) this.order = [...this.items.keys()].sort();
    if (this.items.size) this.fade.startAppear();
    this._dirty = true;
  }

  vehicle(uid) { return this.items.get(uid)?.v; }
  position(uid) {
    const it = this.items.get(uid);
    if (!it) return null;
    const [x, y] = this._pos(it, performance.now());
    const lng = x * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
    return { lat, lng };
  }

  setFilter(cats) { this.filter = cats; this._dirty = true; }
  setSelected(uid) { this.selected = uid; this._dirty = true; }
  setFlash(uid) { this.flash = uid; this._dirty = true; }

  /** Mapa schovaná (jiná záložka): nic se nekreslí; po návratu se vozidla znovu plynule objeví. */
  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) { this.fade.resetAppear(); if (this.items.size) this.fade.startAppear(); this._resize(); }
    this._dirty = true;
  }

  // ───── kreslení ─────

  _pos(it, now) {
    if (!it.dur) return [it.tx, it.ty];
    const l = Math.min(1, (now - it.t0) / it.dur);
    const t = 1 - (1 - l) * (1 - l);   // zpomalení na konci (jako dřívější DOM značky)
    return [it.fx + (it.tx - it.fx) * t, it.fy + (it.ty - it.fy) * t];
  }

  _resize() {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr !== this._dpr) { this._dpr = dpr; this.labels.clear(); this.dots.clear(); }
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`;
    this._dirty = true;
  }

  _dot(color, late) {
    const k = `${color}|${late ? 1 : 0}`;
    let b = this.dots.get(k);
    if (!b) { b = drawDot(color, late, this._dpr); this.dots.set(k, b); }
    return b;
  }

  /** Štítek z cache; chybějící se zařadí do fronty a nakreslí v dalších snímcích (null = zatím tečka). */
  _label(line, style, phase, late, now = false) {
    const k = `${line}|${style}|${phase}|${late ? 1 : 0}`;
    const b = this.labels.get(k);
    if (b) return b;
    if (now) { const n = drawLabel(line, style, phase, late, this._dpr); this.labels.set(k, n); return n; }
    if (!this.labelQueue.has(k)) this.labelQueue.set(k, [line, style, phase, late]);
    return null;
  }

  _drainLabels(budgetMs = 4) {
    if (!this.labelQueue.size) return;
    const t0 = performance.now();
    for (const [k, a] of this.labelQueue) {
      this.labelQueue.delete(k);
      this.labels.set(k, drawLabel(a[0], a[1], a[2], a[3], this._dpr));
      if (performance.now() - t0 > budgetMs) break;
    }
    if (this.labels.size > 4000) this.labels.clear();   // dlouhý běh: cache se občas vyprázdní
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (!this.visible) return;
    if (this.map.isMoving()) return;   // při pohybu kamery kreslí 'render' (ve stejném snímku jako mapa)
    // kreslí se jen při změně: přesun na novou polohu, prolínání, nové štítky, výběr (jinak se nic nehýbe)
    const moving = now < (this._moveUntil || 0);
    if (!this._dirty && !moving) return;
    // oddáleno stačí přesun ~10× za vteřinu (tisíce teček), přiblíženo plynule každý snímek
    const z = this.map.getZoom();
    const interval = this.fade.animating || this.labelQueue.size || !moving ? 0 : z < 9.5 ? 100 : z < DOT_ZOOM ? 50 : 0;
    if (now - (this._last || 0) < interval) return;
    this._draw(now, false);
  }

  _draw(now, fromMap) {
    if (!this.visible) return;
    this._last = now; this._dirty = false;
    const map = this.map, g = this.g, dpr = this._dpr, w = this.w, h = this.h;
    const zoom = map.getZoom();
    const c = map.getCenter();
    const world = 512 * 2 ** zoom;
    const cwx = wxOf(c.lng), cwy = wyOf(c.lat);
    const pad = 48;

    // režim podle zoomu a počtu vozidel v záběru (s hysterezí)
    const items = [];
    for (const uid of this.order) {
      const it = this.items.get(uid);
      if (!it) continue;
      if (this.filter && !this.filter.has(vehicleCategory(it.v))) continue;
      const [px, py] = this._pos(it, now);
      const x = (px - cwx) * world + w / 2, y = (py - cwy) * world + h / 2;
      if (x < -pad || x > w + pad || y < -pad || y > h + pad) continue;
      items.push([it, x, y]);
    }
    const dotNow = this.fade.dotMode;
    const zoomOk = dotNow ? zoom >= DOT_ZOOM + DOT_HYST : zoom >= DOT_ZOOM;
    const countOk = items.length <= (dotNow ? LABEL_MAX : LABEL_MAX * 1.2);
    this.fade.setDotMode(!(zoomOk && countOk));

    // štítky pro záběr (i těsně před přepnutím a během prolínání)
    const wantLabels = !this.fade.dotMode || this.fade.switching || zoom >= DOT_ZOOM - 0.6;
    let pending = false;
    if (wantLabels) {
      for (const e of items) {
        const v = e[0].v;
        e[3] = this._label(String(v.line ?? '?'), vehicleStyle(v), 0, lateMinutes(v) > 0);
        if (!e[3]) pending = true;
      }
      this._drainLabels(fromMap ? 2 : 5);
    }
    this.fade.tick(now, pending && !this.fade.dotMode);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const appear = this.fade.appear;
    const dotA = this.fade.dotAlpha * appear, labA = this.fade.labelAlpha * appear;
    const screen = (this.screen = []);
    let hlItem = null;

    const blit = (b, x, y, a) => {
      if (a <= 0.003) return;
      g.globalAlpha = a;
      g.drawImage(b.img, Math.round(x - b.w / 2), Math.round(y - b.h / 2), b.w, b.h);
    };
    const bornA = (it) => Math.min(1, (now - it.born) / 400);   // nová vozidla se objeví plynule

    for (const e of items) {
      const [it, x, y, lab] = e;
      const v = it.v;
      if (v.uid === this.selected || v.uid === this.flash) { hlItem = e; continue; }
      const stale = v.ageSec >= STALE_S ? 0.65 : 1;
      const a = stale * (appear < 1 ? 1 : bornA(it));
      const dot = this._dot(STYLES[vehicleStyle(v)].color, lateMinutes(v) > 0);
      if (lab) {
        blit(dot, x, y, dotA * a);
        blit(lab, x, y, labA * a);
      } else blit(dot, x, y, appear * a);
      const shown = lab && labA > 0.5 ? lab : dot;
      screen.push([x, y, shown.w / 2, shown.h / 2, v]);
    }

    // vybrané vozidlo navrch: větší štítek s kroužkem (i v režimu teček); upozornění na vůz krátce bliká
    if (hlItem) {
      const [, x, y] = hlItem;
      const v = hlItem[0].v;
      const flash = v.uid === this.flash;
      const phase = flash ? (Math.floor(now / 400) % 2 === 0 ? 1 : 2) : 3;
      const b = this._label(String(v.line ?? '?'), vehicleStyle(v), phase, lateMinutes(v) > 0, true);
      blit(b, x, y, Math.max(appear, 0.01));
      screen.push([x, y, b.w / 2, b.h / 2, v, true]);
      if (flash) this._dirty = true;   // blikání
    }
    g.globalAlpha = 1;
    if (this.fade.animating || pending || this.labelQueue.size) this._dirty = true;
  }

  // ───── ťuknutí ─────

  /** Vozidla pod bodem (CSS px v mapě): víc přes sebe = všechna (výběr), jinak nejbližší s rezervou na prst. */
  hitTest(px, py) {
    let best = null, bestD = Infinity;
    const covering = [];
    for (const [x, y, hw, hh, v, hl] of this.screen) {
      const dx = Math.abs(x - px), dy = Math.abs(y - py);
      const dotLike = hw < 8;
      if (dx > hw + (dotLike ? 7 : 4) || dy > hh + (dotLike ? 7 : 3)) continue;
      const d = dx * dx + dy * dy - (hl ? 1e6 : 0);
      if (d < bestD) { bestD = d; best = v; }
      if (dx <= hw && dy <= hh) covering.push([d, v]);
    }
    if (covering.length >= 2) {
      const out = [], uids = new Set();
      for (const [, v] of covering.sort((a, b) => a[0] - b[0])) if (!uids.has(v.uid)) { uids.add(v.uid); out.push(v); }
      if (out.length >= 2) return out;
    }
    return best ? [best] : [];
  }

  _click(e) {
    const hits = this.hitTest(e.point.x, e.point.y);
    if (!hits.length) return;
    e.preventDefault?.();
    e.originalEvent?.stopPropagation?.();
    e._vehicleHit = true;
    this.onTap?.(hits);
  }

  destroy() { this.canvas.remove(); this.items.clear(); }
}
