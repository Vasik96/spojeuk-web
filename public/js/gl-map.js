// Mapa na MapLibre GL JS (stejný engine jako v Android appce). Tenký obal se stejným API jako dřívější
// vlastní engine: setView, fitBounds, addMarker, addPolyline, setTheme, on('click' | 'tilesfailed').
// Plynulé přibližování, setrvačnost a gesta řeší MapLibre; vozidla jsou DOM značky s animací mezi polohami.
import { loadMapConfig, softenDark } from './map-style.js';

const ml = () => window.maplibregl;
const EMPTY = (bg) => ({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': bg } }] });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Šipka směru jízdy jako v Android appce (routeArrowBitmap): široký chevron, který přesahuje z trasy.
 * Tvar je z appky (mřížka 72, otočený tak, aby mířil doprava = ve směru čáry), výplň bílá, obrys jen jemně černý.
 */
function arrowImage() {
  const s = 96, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.scale(s / 72, s / 72);
  g.lineCap = g.lineJoin = 'round';
  g.beginPath(); g.moveTo(29, 13); g.lineTo(57, 36); g.lineTo(29, 59);
  g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 13.5; g.stroke();   // velmi slabý černý okraj
  g.strokeStyle = '#fff'; g.lineWidth = 11; g.stroke();
  return g.getImageData(0, 0, s, s);
}

export class MapView {
  /**
   * @param {HTMLElement} el
   * @param {{center?:[number,number], zoom?:number, minZoom?:number, maxZoom?:number, theme?:'light'|'dark', configUrl:string}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = { minZoom: 7, maxZoom: 18, center: [50.66, 14.04], zoom: 12, theme: 'light', ...opts };
    this.theme = this.opts.theme;
    this.listeners = {};
    this.markers = new Set();
    this.lines = new Set();
    this._seq = 0;
    this._errors = 0; this._tilesOk = 0; this._warned = false;

    el.setAttribute('role', 'application');
    el.setAttribute('aria-label', 'Mapa vozidel');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    el.append(host);

    const L = ml();
    L.setWorkerUrl('/vendor/maplibre-gl-csp-worker.js');
    this.map = new L.Map({
      container: host,
      style: EMPTY(this.theme === 'dark' ? '#2a2f3a' : '#e8f1fa'),
      center: [this.opts.center[1], this.opts.center[0]], zoom: this.opts.zoom,
      minZoom: this.opts.minZoom, maxZoom: this.opts.maxZoom,
      dragRotate: false, pitchWithRotate: false, attributionControl: false, renderWorldCopies: false,
      fadeDuration: 200,
      // plynulejší kolečko myši (výchozí je dost skokové)
      scrollZoom: true,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation?.();
    this.map.addControl(new L.AttributionControl({ compact: true }), 'bottom-right');
    this._buildControls();

    this.map.on('click', (e) => this._emit('click', e));
    this.map.on('style.load', () => { this._styleOk = true; this._reapply(); });
    this.map.on('styleimagemissing', (e) => { if (e.id === 'route-arrow' && !this.map.hasImage('route-arrow')) this.map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 }); });
    this.map.on('data', (e) => { if (e.dataType === 'source' && e.tile) this._tilesOk++; });
    this.map.on('error', (e) => this._onError(e));
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
    this._applyStyle(this.theme);
  }

  // ───────────── styl ─────────────

  async _applyStyle(theme, useFallback = false) {
    const seq = ++this._seq;
    this.cfg ||= await loadMapConfig(this.opts.configUrl);
    if (seq !== this._seq) return;
    const cfg = this.cfg;
    const url = cfg && (useFallback ? cfg.fallback?.[theme] : cfg[theme]);
    if (!url) { this._warn(); return; }
    this._styleOk = false; this._styleUrl = url; this._usingFallback = useFallback;
    const recolor = useFallback || cfg.provider !== 'carto';
    this.map.setStyle(url, {
      diff: false,
      transformStyle: (_prev, next) => (theme === 'dark' ? softenDark(next, { recolorLabels: recolor }) : next),
    });
  }

  _onError(e) {
    const status = e?.error?.status;
    if (!this._styleOk && !this._usingFallback && this.cfg?.fallback) {
      // hlavní styl (CARTO) se nenačetl, třeba kvůli klíči: přepne se na záložní bez klíče
      this._applyStyle(this.theme, true);
      return;
    }
    if (!this._styleOk) return this._warn();
    if (e?.sourceId || status) { this._errors++; if (this._errors >= 8 && !this._tilesOk) this._warn(); }
  }

  _warn() { if (!this._warned) { this._warned = true; this._emit('tilesfailed', {}); } }

  setTheme(theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    this._applyStyle(theme);
  }

  // ───────────── veřejné API ─────────────

  on(type, fn) { (this.listeners[type] ||= []).push(fn); return this; }
  _emit(type, e) { for (const fn of this.listeners[type] || []) fn(e); }

  get zoom() { return this.map.getZoom(); }
  invalidate() { this.map.resize(); }

  getBounds() {
    const b = this.map.getBounds();
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  }

  toScreen(lat, lng) { const p = this.map.project([lng, lat]); return { x: p.x, y: p.y }; }

  setView(center, zoom, { animate = false } = {}) {
    const o = { center: [center[1], center[0]], zoom: clamp(zoom ?? this.map.getZoom(), this.opts.minZoom, this.opts.maxZoom) };
    if (animate) this.map.easeTo({ ...o, duration: 600 }); else this.map.jumpTo(o);
  }

  /** Přiblíží tak, aby se vešly všechny body. padding = {top,right,bottom,left} v px. */
  fitBounds(points, { padding = {}, maxZoom = 16, animate = true } = {}) {
    if (!points.length) return;
    const b = new (ml().LngLatBounds)();
    for (const [la, lo] of points) b.extend([lo, la]);
    this.map.fitBounds(b, { padding: { top: 40, right: 40, bottom: 40, left: 40, ...padding }, maxZoom, duration: animate ? 700 : 0 });
  }

  zoomBy(delta) { this.map.zoomTo(clamp(this.map.getZoom() + delta, this.opts.minZoom, this.opts.maxZoom), { duration: 350 }); }

  addMarker({ lat, lng, el, onClick, z = 0 }) {
    const m = new GlMarker(this, lat, lng, el, onClick, z);
    this.markers.add(m);
    return m;
  }

  addPolyline(points, style = {}) {
    const line = new GlLine(this, points, style);
    this.lines.add(line);
    line._apply();
    return line;
  }

  destroy() { this._dead = true; this.map.remove(); }

  _reapply() {
    if (!this.map.hasImage('route-arrow')) this.map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 });
    for (const l of this.lines) l._apply(true);
  }

  _buildControls() {
    const box = document.createElement('div');
    box.className = 'map-controls';
    const mk = (label, aria, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.setAttribute('aria-label', aria);
      b.addEventListener('click', fn);
      return b;
    };
    box.append(mk('+', 'Přiblížit', () => this.zoomBy(1)), mk('−', 'Oddálit', () => this.zoomBy(-1)));
    this.el.append(box);
  }

  /** Jedna smyčka na animaci značek (plynulý přesun vozidel mezi dvěma polohami). */
  _frame(now) {
    if (this._dead) return;
    for (const m of this.markers) m._step(now);
    requestAnimationFrame(this._frame);
  }
}

class GlMarker {
  constructor(view, lat, lng, el, onClick, z) {
    this.view = view;
    this.lat = lat; this.lng = lng; this.dLat = lat; this.dLng = lng; this.anim = null;
    this.root = document.createElement('div');
    this.root.className = 'map-marker';
    this.root.style.zIndex = z;
    this.root.append(el);
    this.el = el;
    if (onClick) this.root.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    this.marker = new (ml().Marker)({ element: this.root, anchor: 'center' }).setLngLat([lng, lat]).addTo(view.map);
  }

  setLatLng(lat, lng, animate = false) {
    if (lat === this.lat && lng === this.lng) return;
    this.anim = animate ? { fromLat: this.dLat, fromLng: this.dLng, t0: performance.now(), dur: 1200 } : null;
    this.lat = lat; this.lng = lng;
    if (!animate) { this.dLat = lat; this.dLng = lng; this.marker.setLngLat([lng, lat]); }
  }

  setZ(z) { this.root.style.zIndex = z; }

  _step(now) {
    if (!this.anim) return;
    const t = Math.min(1, (now - this.anim.t0) / this.anim.dur), e = 1 - (1 - t) ** 2;
    this.dLat = this.anim.fromLat + (this.lat - this.anim.fromLat) * e;
    this.dLng = this.anim.fromLng + (this.lng - this.anim.fromLng) * e;
    this.marker.setLngLat([this.dLng, this.dLat]);
    if (t >= 1) this.anim = null;
  }

  remove() { this.marker.remove(); this.view.markers.delete(this); }
}

let lineSeq = 0;

class GlLine {
  constructor(view, points, style) {
    this.view = view;
    this.points = points;
    this.id = `route-${++lineSeq}`;
    this.style = { color: '#2b85d6', width: 5, dash: null, opacity: 0.9, casing: '#fff', arrows: false, ...style };
  }

  _data() {
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.points.map(([la, lo]) => [lo, la]) } };
  }

  /** Přidá zdroj a vrstvy (znovu i po výměně stylu). */
  _apply() {
    const map = this.view.map, s = this.style, id = this.id;
    try {
      if (map.getSource(id)) { map.getSource(id).setData(this._data()); return; }
      this._add(map, s, id);
    } catch { /* styl se právě načítá; vrstvy se doplní ze 'style.load' */ }
  }

  _add(map, s, id) {
    map.addSource(id, { type: 'geojson', data: this._data() });
    if (s.casing && !s.dash) map.addLayer({ id: `${id}-casing`, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': s.casing, 'line-width': s.width + 4, 'line-opacity': 0.85 } });
    map.addLayer({
      id: `${id}-line`, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': s.color, 'line-width': s.width, 'line-opacity': s.opacity, ...(s.dash ? { 'line-dasharray': [0.1, 2.2] } : {}) },
    });
    if (s.arrows) {
      map.addLayer({
        id: `${id}-arrows`, type: 'symbol', source: id,
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 110, 'icon-image': 'route-arrow', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' },
        paint: {},
      });
      map.setLayoutProperty(`${id}-arrows`, 'icon-size', ['interpolate', ['linear'], ['zoom'], 8, 0.32, 10, 0.45, 12, 0.6, 14, 0.78, 16, 0.95, 18, 1.1]);
    }
  }

  setPoints(points) {
    this.points = points;
    const src = this.view.map.getSource?.(this.id);
    if (src) src.setData(this._data());
  }

  remove() {
    const map = this.view.map, id = this.id;
    try {
      for (const l of ['arrows', 'line', 'casing']) if (map.getLayer(`${id}-${l}`)) map.removeLayer(`${id}-${l}`);
      if (map.getSource(id)) map.removeSource(id);
    } catch { /* mapa už je zrušená */ }
    this.view.lines.delete(this);
  }
}
