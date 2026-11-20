// Zastávky na mapě (jako v Android appce): kruh v barvě motivu s ikonou autobusu / vlaku, nad vozidly (vlak u
// nástupiště nesmí zakrýt zastávku), od zoomu STOP_MIN_ZOOM; při přechodu přes hranici zoomu se plynule objeví / zmizí.
// Vybrané vozidlo kreslí vehicle-layer.js do vlastního canvasu nad mapou, takže zůstává nad zastávkami.
import { GL_LAYER } from './vehicle-layer.js';

const SRC = 'stops-src';
const LAYER = 'stops';
const IMG_BUS = 'stop-bus';
const IMG_RAIL = 'stop-rail';
/** Zoom MapLibre (= Google zoom − 1 v appce, tam 14,5). */
export const STOP_MIN_ZOOM = 13.5;
const FADE_MS = 250;
const ICON_PX = 30;          // průměr ikony v CSS px (jako 30 dp v appce)
const HIT_PX = 18;           // ťuknutí do takové vzdálenosti od středu

const BUS_PATH = 'M6,21q-0.42,0-0.71-0.29Q5,20.43 5,20V17.95q-0.45-0.5-0.72-1.11Q4,16.23 4,15.5V6Q4,3.92 5.93,2.96T12,2q4.3,0 6.15,0.92T20,6v9.5q0,0.73-0.27,1.34T19,17.95V20q0,0.43-0.29,0.71T18,21H17q-0.43,0-0.71-0.29Q16,20.43 16,20V19H8v1q0,0.43-0.29,0.71T7,21H6ZM6,10H18V7H6v3Zm3.56,5.56Q10,15.13 10,14.5T9.56,13.44T8.5,13T7.44,13.44T7,14.5t0.44,1.06T8.5,16t1.06-0.44Zm7,0Q17,15.13 17,14.5t-0.44-1.06T15.5,13t-1.06,0.44T14,14.5t0.44,1.06T15.5,16t1.06-0.44Z';

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Ikona: světlý lem, výplň v barvě motivu, bílá ikona (autobus vyplněný, vlak obrysem jako v icons.svg). */
function iconImage(kind, dpr) {
  const px = Math.round(ICON_PX * dpr);
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const r = px / 2, ring = 2.5 * dpr;
  g.fillStyle = cssVar('--surface', '#fff');
  g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = cssVar('--brand-600', '#2786d6');
  g.beginPath(); g.arc(r, r, r - ring, 0, Math.PI * 2); g.fill();
  const s = px * 0.58 / 24;
  g.translate(r - 12 * s, r - 12 * s);
  g.scale(s, s);
  g.fillStyle = g.strokeStyle = '#fff';
  if (kind === 'rail') {
    g.lineWidth = 2; g.lineCap = g.lineJoin = 'round';
    g.stroke(new Path2D('M8 3h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z'));
    g.stroke(new Path2D('M5 11h14M8 21l2-3M16 21l-2-3'));
    g.beginPath(); g.arc(9, 14.6, 1.1, 0, Math.PI * 2); g.arc(15, 14.6, 1.1, 0, Math.PI * 2); g.fill();
  } else {
    g.fill(new Path2D(BUS_PATH));
  }
  return g.getImageData(0, 0, px, px);
}

export class StopLayer {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {import('./stops.js').StopIndex} index
   */
  constructor(map, index) {
    this.map = map;
    this.index = index;
    this.shown = null;          // jsou zastávky vidět (podle zoomu)
    this.list = [];             // zastávky ve zdroji (pro ťuknutí)
    this._dpr = Math.min(3, window.devicePixelRatio || 1);
    this._add();
    map.on('style.load', () => { this.shown = null; this._add(); });
    map.on('moveend', () => this._update());
    map.on('zoom', () => this._visibility());
    // nad vozidla i když vrstva vozidel přibude až po nás (výměna stylu)
    map.on('styledata', () => this._top());
  }

  /** Barvy motivu se změnily (světlý / tmavý): překreslit ikony. */
  refreshTheme() {
    const map = this.map;
    try {
      for (const [id, kind] of [[IMG_BUS, 'bus'], [IMG_RAIL, 'rail']]) {
        const img = iconImage(kind, this._dpr);
        if (map.hasImage(id)) map.updateImage(id, img); else map.addImage(id, img, { pixelRatio: this._dpr });
      }
    } catch { /* styl se načítá */ }
  }

  _add() {
    const map = this.map;
    try {
      this.refreshTheme();
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer(LAYER)) {
        map.addLayer({
          id: LAYER, type: 'symbol', source: SRC,
          layout: { 'icon-image': ['get', 'img'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
          paint: { 'icon-opacity': 0, 'icon-opacity-transition': { duration: FADE_MS, delay: 0 } },
        });
      }
      this._top();
      this._visibility();
      this._update(true);
    } catch { /* styl se ještě načítá: doplní se při 'style.load' */ }
  }

  _top() {
    const map = this.map;
    try {
      if (!map.getLayer(LAYER) || !map.getLayer(GL_LAYER)) return;
      const ids = map.getStyle().layers.map((l) => l.id);
      if (ids.indexOf(LAYER) < ids.indexOf(GL_LAYER)) map.moveLayer(LAYER);
    } catch { /* ignore */ }
  }

  _visibility() {
    const show = this.map.getZoom() >= STOP_MIN_ZOOM;
    if (show === this.shown) return;
    this.shown = show;
    try { if (this.map.getLayer(LAYER)) this.map.setPaintProperty(LAYER, 'icon-opacity', show ? 1 : 0); } catch { /* ignore */ }
    if (show) this._update(true);
  }

  /** Zastávky v záběru do zdroje; skryté (malý zoom) zůstanou, ať je co prolínat. */
  _update(force = false) {
    if (!this.shown && !force) return;
    if (!this.shown) return;
    const b = this.map.getBounds();
    const dy = (b.getNorth() - b.getSouth()) * 0.1, dx = (b.getEast() - b.getWest()) * 0.1;
    const list = this.index.inView({ south: b.getSouth() - dy, north: b.getNorth() + dy, west: b.getWest() - dx, east: b.getEast() + dx });
    if (!force && list.length === this.list.length && list.every((s, i) => s === this.list[i])) return;
    this.list = list;
    const src = this.map.getSource(SRC);
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: list.map((s) => ({ type: 'Feature', properties: { img: s.kind === 'rail' ? IMG_RAIL : IMG_BUS }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })),
    });
  }

  /** Zastávka pod bodem (CSS px v mapě), nebo null. */
  hitTest(px, py) {
    if (!this.shown) return null;
    let best = null, bestD = HIT_PX * HIT_PX;
    for (const s of this.list) {
      const p = this.map.project([s.lng, s.lat]);
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best;
  }
}
