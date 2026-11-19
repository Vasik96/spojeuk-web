// Vozidla na mapě: GPU vrstvy MapLibre (jako vozidla na OpenStreetMap v Android appce).
//
// Dřív bylo každé vozidlo DOM značka (~3 000 elementů s celostátním feedem), pak canvas 2D: tisíce drawImage
// za snímek stály na mobilu při zoomu desítky ms, nejvíc kolem přechodu teček na štítky. Teď jsou tečky vrstva
// kruhů a štítky vrstva symbolů (obrázek štítku podle linky / barvy) nad jedním GeoJSON zdrojem, kreslí je GPU
// spolu s mapou a zoom ani posun nestojí žádnou práci v JavaScriptu. Štítek je jeden obrázek (linka + barva + zpoždění),
// takže se překrývající štítky kryjí celé (text + pilulka jako vrstva symbolů by text spodních štítků propouštěl).
// Obrázky se chystají dopředu po dávkách, když se mapa nehýbe, a vrstvy se nikdy nevypínají (jen průhlednost):
// zapnutí vrstvy i přidání obrázku znamená nové rozvržení symbolů, to dřív zasekávalo přechod teček na štítky.
// Canvas kreslí jen vybrané vozidlo.
//
// Oddáleno (pod DOT_ZOOM) malé barevné tečky, přiblíženo štítky s číslem linky. Přechod mezi nimi i objevení
// vozidel po otevření mapy se plynule prolíná ([Fade], průhlednost celé vrstvy). Vozidla stojí na poslední poloze
// ze serveru: web nic nepředpovídá.

export const DOT_ZOOM = 11;           // stejně jako DOT_ZOOM_ML v appce (MapLibre má stejné zoomy jako web)
const DOT_HYST = 0.15;                // hystereze proti blikání na hranici
const LABEL_MAX = 1500;               // víc štítků v záběru = nečitelné a drahé: zůstanou tečky
const STALE_S = 60;                   // starší poloha: poloprůhledně (jako v appce)

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
const meas = canvas(1, 1).getContext('2d');

function drawLabel(line, styleKey, phase, late, dpr, alpha = 1) {
  if (phase === 3) return drawSelected(line, styleKey, late, dpr);
  const st = STYLES[styleKey] || STYLES.BUS;
  const hl = phase !== 0;
  const textPx = phase === 1 ? 17 : phase === 2 ? 15 : 13;
  const hPx = phase === 1 ? 38 : phase === 2 ? 32 : 26;
  let pad = hl ? 26 : 18;
  const maxW = hl ? 84 : 72;
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
  g.globalAlpha = alpha;   // zastaralá poloha: poloprůhledný štítek (jako v appce)
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

const DOT_SRC = 'veh-src';
export const DOT_LAYER = 'veh-dots';
export const LABEL_LAYER = 'veh-labels';
const PEND_LAYER = 'veh-dots-pending';   // tečky vozidel, jejichž štítek ještě není nakreslený (v režimu štítků)
const IMG_PREFIX = 'veh:';
/** "#RRGGBB" → "rgba(r,g,b,a)" */
const withAlpha = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const wxOf = (lng) => (lng + 180) / 360;
const wyOf = (lat) => {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export class VehicleLayer {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {{onTap?: (vehicles: object[]) => void}} opts
   */
  constructor(map, { onTap } = {}) {
    this.map = map;
    this.onTap = onTap;
    this.items = new Map();      // uid → { v, x, y (světové 0..1), style, late, line, key, color, cat, stale }
    this.filter = null;          // Set kategorií, null = vše
    this.selected = null; this.flash = null;
    this.fade = new Fade();
    this.selBmp = new Map();     // štítky vybraného vozidla (canvas)
    this.queue = new Set();      // klíče obrázků štítků k nakreslení (po dávkách, když se mapa nehýbe)
    this.visible = true;
    this._dpr = Math.min(3, window.devicePixelRatio || 1);

    const cv = (this.canvas = document.createElement('canvas'));
    cv.className = 'veh-canvas';
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1';
    map.getContainer().append(cv);
    this.g = cv.getContext('2d');
    this._resize();
    map.on('resize', () => this._resize());
    map.on('render', () => this._draw(performance.now(), true));   // pohyb kamery: vybrané vozidlo ve snímku mapy
    map.on('click', (e) => this._click(e));
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = this.hitTest(e.point.x, e.point.y).length ? 'pointer' : ''; });
    // vrstvy se přidávají znovu po výměně stylu (motiv)
    map.on('style.load', () => { this._ready = false; this._ensureLayers(); this._prewarm(); });
    map.on('styledata', () => this._ensureLayers());
    map.on('styleimagemissing', (e) => this._imageMissing(e.id));
    // do mapy jdou jen vozidla v okolí záběru; po posunu / oddálení mimo ně se zdroj doplní
    map.on('moveend', () => { if (!this._boxCovers()) { this._push(); this._prewarm(); } });
    this.fade.initDotMode(map.getZoom() < DOT_ZOOM);
    this._ensureLayers();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ───── data ─────

  /** Nové polohy ze serveru: vozidla se přesunou rovnou na ně (žádná předpověď ani animace pohybu). */
  setVehicles(list) {
    const seen = new Set();
    for (const v of list) {
      seen.add(v.uid);
      let it = this.items.get(v.uid);
      if (!it) { it = {}; this.items.set(v.uid, it); }
      it.v = v; it.x = wxOf(v.lng); it.y = wyOf(v.lat);
      this._meta(it);
    }
    for (const uid of this.items.keys()) if (!seen.has(uid)) this.items.delete(uid);
    if (this.items.size) this.fade.startAppear();
    this._push();
    this._prewarm();
    this._dirty = true;
  }

  /**
   * Obrázky štítků vozidel v okolí záběru do fronty (chystají se v klidu po dávkách, viz _loop). Vozidlo
   * dostane odkaz na obrázek (_push, vlastnost 'i') až když je hotový: jinak si MapLibre při prvním zobrazení
   * řekl o stovky obrázků najednou a jejich nakreslení zaseklo mapu na několik sekund.
   */
  _prewarm() {
    if (!this._ready) return;
    for (const it of this._pushed || []) if (!this.map.hasImage(it.key)) this.queue.add(it.key);
  }

  /** Oblast, pro kterou jsou vozidla v mapě: záběr zvětšený na každou stranu o celou jeho šířku / výšku. */
  _viewBox() {
    const b = this.map.getBounds();
    const dLat = b.getNorth() - b.getSouth(), dLng = b.getEast() - b.getWest();
    return { s: b.getSouth() - dLat, n: b.getNorth() + dLat, w: b.getWest() - dLng, e: b.getEast() + dLng };
  }

  _boxCovers() {
    const box = this._box;
    if (!box) return false;
    const b = this.map.getBounds();
    return b.getSouth() >= box.s && b.getNorth() <= box.n && b.getWest() >= box.w && b.getEast() <= box.e;
  }

  /** Vlastnosti vozidla pro kreslení, spočítané jednou při nové poloze (ne v každém snímku). */
  _meta(it) {
    const v = it.v;
    const style = vehicleStyle(v);
    it.style = style;
    it.late = lateMinutes(v) > 0;
    it.line = String(v.line ?? '?');
    it.stale = v.ageSec >= STALE_S;
    it.color = STYLES[style].color;
    it.cat = vehicleCategory(v);
    it.key = `${IMG_PREFIX}${it.line}|${style}|${it.late ? 1 : 0}|${it.stale ? 1 : 0}`;
  }

  vehicle(uid) { return this.items.get(uid)?.v; }
  position(uid) { const v = this.items.get(uid)?.v; return v ? { lat: v.lat, lng: v.lng } : null; }

  setFilter(cats) { this.filter = cats; this._applyFilter(); this._dirty = true; }
  setSelected(uid) { this.selected = uid; this._applyFilter(); this._dirty = true; }
  setFlash(uid) { this.flash = uid; this._applyFilter(); this._dirty = true; }

  /** Mapa schovaná (jiná záložka): nic se nekreslí; po návratu se vozidla znovu plynule objeví. */
  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) { this.fade.resetAppear(); if (this.items.size) this.fade.startAppear(); this._resize(); }
    this._opa = null;
    this._dirty = true;
    if (!on) this._setOpacity(0, 0);
  }

  // ───── vrstvy MapLibre ─────

  _ensureLayers() {
    const m = this.map;
    if (this._ready && m.getLayer(DOT_LAYER) && m.getLayer(LABEL_LAYER)) return;
    try {
      if (!m.getSource(DOT_SRC)) m.addSource(DOT_SRC, { type: 'geojson', data: this._geo || { type: 'FeatureCollection', features: [] } });
      if (!m.getLayer(DOT_LAYER)) {
        m.addLayer({
          id: DOT_LAYER, type: 'circle', source: DOT_SRC,
          paint: {
            // tečka ~9 px se světlým okrajem; zpožděná tramvaj / metro: okraj červený a silnější
            'circle-radius': 3.3,
            'circle-color': ['get', 'c'],
            'circle-stroke-width': ['case', ['get', 'l'], 2.2, 1.2],
            'circle-stroke-color': ['case', ['get', 'l'], LATE_COLOR, 'rgba(255,255,255,0.8)'],
            // průhlednost celé vrstvy je konstanta (změna za snímek při prolínání je levná); zastaralé polohy
            // mají poloprůhlednost už v barvě, výraz podle dat by při každé změně přepočítal všechny tečky
            'circle-opacity': 0,
            'circle-stroke-opacity': 0,
          },
        });
      }
      if (!m.getLayer(PEND_LAYER)) {
        const dots = m.getLayer(DOT_LAYER).serialize();
        m.addLayer({ ...dots, id: PEND_LAYER, filter: ['!', ['has', 'i']] });
      }
      if (!m.getLayer(LABEL_LAYER)) {
        m.addLayer({
          id: LABEL_LAYER, type: 'symbol', source: DOT_SRC,
          minzoom: Math.floor(DOT_ZOOM - 1),   // oddáleně se štítky vůbec nerozvrhují (jsou jen tečky)
          layout: {
            'icon-image': ['get', 'i'],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-z-order': 'source',   // pevné pořadí (podle uid) = stabilní překrývání
          },
          paint: { 'icon-opacity': 0 },
        });
      }
      this._ready = true;
      this._opa = null;
      this._filterKey = null;
      this._applyFilter();
      this._dirty = true;
    } catch { /* styl se ještě načítá: zkusí se znovu při 'styledata' */ }
  }

  /**
   * Vozidla do zdroje mapy. Jen v okolí záběru (jako appka): celá ČR (~3 000 vozidel) při každé aktualizaci znamenala
   * nové rozdělení do dlaždic a rozvržení všech štítků, to byl pravidelný „záškub“ každých 8 s.
   */
  _push() {
    const box = (this._box = this._viewBox());
    const m = this.map;
    const features = [], pushed = [];
    let missing = false;
    for (const uid of [...this.items.keys()].sort()) {
      const it = this.items.get(uid), v = it.v;
      if (v.lat < box.s || v.lat > box.n || v.lng < box.w || v.lng > box.e) continue;
      pushed.push(it);
      // zastaralá poloha: poloprůhledně (jako v appce), u tečky v barvě, u štítku v obrázku
      const props = { u: uid, k: it.cat, l: it.late, c: it.stale ? withAlpha(it.color, 0.65) : it.color };
      if (this._ready && m.hasImage(it.key)) props.i = it.key; else missing = true;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lng, v.lat] }, properties: props });
    }
    this._pushed = pushed;
    this._missing = missing;
    this._geo = { type: 'FeatureCollection', features };
    m.getSource(DOT_SRC)?.setData(this._geo);
  }

  /** Filtr druhů dopravy; vybrané vozidlo se z vrstev vynechá (kreslí ho canvas větší, s kroužkem). */
  _applyFilter() {
    if (!this._ready) return;
    const cats = this.filter ? [...this.filter].sort() : null;
    const hide = [this.selected, this.flash].filter(Boolean);
    const key = JSON.stringify([cats, hide]);
    if (key === this._filterKey) return;
    this._filterKey = key;
    const f = ['all'];
    if (cats) f.push(['in', ['get', 'k'], ['literal', cats]]);
    for (const u of hide) f.push(['!=', ['get', 'u'], u]);
    try {
      for (const l of [DOT_LAYER, LABEL_LAYER]) this.map.setFilter(l, f.length > 1 ? f : null);
      this.map.setFilter(PEND_LAYER, [...f, ['!', ['has', 'i']]]);
    } catch { /* vrstva ještě není */ }
  }

  /** Průhlednost teček a štítků (prolínání, objevení po otevření mapy), jen při změně. */
  _setOpacity(dotA, labA) {
    const d = Math.round(dotA * 100) / 100, l = Math.round(labA * 100) / 100;
    const key = `${d}|${l}`;
    if (!this._ready || key === this._opa) return;
    this._opa = key;
    try {
      const m = this.map;
      // jen průhlednost, viditelnost vrstev se nepřepíná: zapnutí vrstvy symbolů znamená nové rozvržení všech
      // štítků (stovky ms na mobilu), právě to zasekávalo přechod mezi tečkami a štítky
      m.setPaintProperty(DOT_LAYER, 'circle-opacity', d);
      m.setPaintProperty(DOT_LAYER, 'circle-stroke-opacity', d);
      m.setPaintProperty(LABEL_LAYER, 'icon-opacity', l);
      // vozidla bez hotového štítku: tečka ve stejné průhlednosti, v jaké jsou vidět štítky
      m.setPaintProperty(PEND_LAYER, 'circle-opacity', l);
      m.setPaintProperty(PEND_LAYER, 'circle-stroke-opacity', l);
    } catch { /* vrstva ještě není */ }
  }

  // ───── obrázky štítků ─────

  /** Nakreslí štítek a předá ho MapLibre (ten si drží vlastní kopii). */
  _addImage(key) {
    const m = this.map;
    if (m.hasImage(key)) return;
    const [line, style, late, stale] = key.slice(IMG_PREFIX.length).split('|');
    const lb = drawLabel(line, style, 0, late === '1', this._dpr, stale === '1' ? 0.65 : 1);
    m.addImage(key, lb.img.getContext('2d').getImageData(0, 0, lb.img.width, lb.img.height), { pixelRatio: this._dpr });
  }

  /** MapLibre chce obrázek, který ještě nemá (předchystání nestihlo): nakreslí se hned. */
  _imageMissing(id) {
    if (!id.startsWith(IMG_PREFIX)) return;
    this.queue.delete(id);
    try { this._addImage(id); } catch { /* ignore */ }
  }

  _drain(budgetMs) {
    if (!this.queue.size || !this._ready) return;
    const t0 = performance.now();
    for (const k of this.queue) {
      this.queue.delete(k);
      try { this._addImage(k); } catch { /* ignore */ }
      if (performance.now() - t0 > budgetMs) break;
    }
    // hotové obrázky do zdroje: po dávce nejvýš 3× za vteřinu, nebo hned když je fronta prázdná
    const now = performance.now();
    if (this._missing && (!this.queue.size || now - (this._repushAt || 0) > 330)) { this._repushAt = now; this._push(); }
  }

  // ───── kreslení ─────

  _resize() {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr !== this._dpr) { this._dpr = dpr; this.selBmp.clear(); }
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`;
    this._dirty = true;
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (!this.visible || this.map.isMoving()) return;   // při pohybu kamery kreslí 'render' (ve stejném snímku jako mapa)
    if (this.queue.size) this._drain(4);                 // štítky dopředu: jen v klidu, po malých dávkách
    if (!this._dirty) return;
    this._draw(now, false);
  }

  _draw(now, fromMap) {
    if (!this.visible) return;
    this._dirty = false;
    const map = this.map, w = this.w, h = this.h;
    const zoom = map.getZoom();

    // režim podle zoomu a počtu vozidel v záběru (s hysterezí); počítá se jen při změně kamery nebo dat
    const camKey = `${zoom.toFixed(3)}|${map.getCenter().lng.toFixed(5)}|${map.getCenter().lat.toFixed(5)}|${w}x${h}|${this.items.size}`;
    if (camKey !== this._camKey) {
      this._camKey = camKey;
      const c = map.getCenter(), world = 512 * 2 ** zoom, cwx = wxOf(c.lng), cwy = wyOf(c.lat), hw = w / 2, hh = h / 2;
      const vis = (this._vis = []);
      for (const it of this.items.values()) {
        if (this.filter && !this.filter.has(it.cat)) continue;
        const x = (it.x - cwx) * world + hw, y = (it.y - cwy) * world + hh;
        if (x >= -48 && x <= w + 48 && y >= -48 && y <= h + 48) vis.push(it);
      }
    }
    const n = this._vis?.length ?? 0;
    const dotNow = this.fade.dotMode;
    const zoomOk = dotNow ? zoom >= DOT_ZOOM + DOT_HYST : zoom >= DOT_ZOOM;
    const countOk = n <= (dotNow ? LABEL_MAX : LABEL_MAX * 1.2);
    this.fade.setDotMode(!(zoomOk && countOk));

    // přechod na štítky počká (nejvýš chvíli, viz Fade), než mají vozidla v záběru hotové obrázky štítků
    let pending = false;
    if (!this.fade.dotMode) for (const it of this._vis || []) if (!map.hasImage(it.key)) { pending = true; this.queue.add(it.key); }
    if (pending && !this.map.isMoving()) this._drain(6);
    this.fade.tick(now, pending);
    const appear = this.fade.appear;
    this._setOpacity(this.fade.dotAlpha * appear, this.fade.labelAlpha * appear);

    // canvas: jen vybrané vozidlo (větší štítek s kroužkem, i v režimu teček); upozornění na vůz krátce bliká
    const g = this.g, dpr = this._dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this._hl = null;
    const uid = this.flash || this.selected;
    const it = uid && this.items.get(uid);
    if (it && (!this.filter || this.filter.has(it.cat))) {
      const p = map.project([it.v.lng, it.v.lat]);
      const flash = uid === this.flash;
      const phase = flash ? (Math.floor(now / 400) % 2 === 0 ? 1 : 2) : 3;
      const k = `${it.line}|${it.style}|${phase}|${it.late ? 1 : 0}`;
      let b = this.selBmp.get(k);
      if (!b) { b = drawLabel(it.line, it.style, phase, it.late, dpr); this.selBmp.set(k, b); }
      g.globalAlpha = Math.max(appear, 0.01);
      g.drawImage(b.img, Math.round(p.x - b.w / 2), Math.round(p.y - b.h / 2), b.w, b.h);
      g.globalAlpha = 1;
      this._hl = { x: p.x, y: p.y, hw: b.w / 2, hh: b.h / 2, v: it.v };
      if (flash) this._dirty = true;   // blikání
    }
    if (this.fade.animating) this._dirty = true;
  }

  // ───── ťuknutí ─────

  /**
   * Vozidla pod bodem (CSS px v mapě): víc přes sebe = všechna (výběr), jinak nejbližší s rezervou na prst.
   * Dotaz jde přímo do vykreslených vrstev mapy (tečky / štítky), vybrané vozidlo z canvasu má přednost.
   */
  hitTest(px, py) {
    const hl = this._hl;
    if (hl && Math.abs(hl.x - px) <= hl.hw + 4 && Math.abs(hl.y - py) <= hl.hh + 3) return [hl.v];
    if (!this._ready || !this.visible) return [];
    const layers = [];
    const o = (this._opa || '0|0').split('|').map(Number);
    if (o[0] > 0) layers.push(DOT_LAYER);
    if (o[1] > 0) layers.push(LABEL_LAYER, PEND_LAYER);
    if (!layers.length) return [];
    const uids = (fs) => [...new Set(fs.map((f) => f.properties.u))].map((u) => this.items.get(u)?.v).filter(Boolean);
    let hits;
    try {
      // přesně pod prstem (štítek / tečka kryje bod); víc vozidel => výběr
      hits = uids(this.map.queryRenderedFeatures([px, py], { layers }));
      if (hits.length) return hits;
      // jinak nejbližší v okolí (tečky jsou malé)
      const r = 9;
      const near = this.map.queryRenderedFeatures([[px - r, py - r], [px + r, py + r]], { layers });
      if (!near.length) return [];
      let best = null, bestD = Infinity;
      for (const f of near) {
        const v = this.items.get(f.properties.u)?.v;
        if (!v) continue;
        const p = this.map.project([v.lng, v.lat]);
        const d = (p.x - px) ** 2 + (p.y - py) ** 2;
        if (d < bestD) { bestD = d; best = v; }
      }
      return best ? [best] : [];
    } catch { return []; }
  }

  _click(e) {
    const hits = this.hitTest(e.point.x, e.point.y);
    if (!hits.length) return;
    e.preventDefault?.();
    e.originalEvent?.stopPropagation?.();
    this.onTap?.(hits);
  }

  destroy() { this.canvas.remove(); this.items.clear(); }
}
