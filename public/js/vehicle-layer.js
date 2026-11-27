// Vozidla na mapě: vlastní WebGL vrstva uvnitř MapLibre (kreslí se v jednom snímku s mapou, na GPU).
import { t } from './i18n.js';
//
// Historie: DOM značky (~3 000 elementů) a pak canvas 2D (tisíce drawImage za snímek) zasekávaly zoom na mobilu,
// vrstvy MapLibre (GeoJSON) zase při každé změně dat znovu rozvrhovaly všechny štítky, takže pohyb vozidel
// nešel animovat. Tady má každé vozidlo v GPU bufferu starou a novou polohu a čas začátku přesunu; přesun
// (~1 s se zpomalením na konci, bez předpovědi, jako v Android appce) počítá vertex shader, za snímek se
// v JavaScriptu nic nepřepočítává. Tečky = kruh ve fragment shaderu, štítky = obdélníky z atlasu textur
// (štítky se kreslí dopředu po dávkách, mezitím tečka). Pevné pořadí kreslení = štítky se kryjí celé.
//
// Oddáleno (pod DOT_ZOOM) tečky, přiblíženo štítky s číslem linky; přechod mezi nimi i objevení vozidel po otevření
// mapy se plynule prolíná ([Fade], průhlednost celé vrstvy). Vybrané vozidlo kreslí canvas nad mapou.

export const DOT_ZOOM = 11;           // stejně jako DOT_ZOOM_ML v appce (MapLibre má stejné zoomy jako web)
const DOT_HYST = 0.15;                // hystereze proti blikání na hranici
const LABEL_MAX = 1500;               // víc štítků v záběru = nečitelné a drahé: zůstanou tečky
const STALE_S = 60;                   // starší poloha: poloprůhledně (jako v appce)

/** Barvy a druhy vozidel (VehicleStyle v appce). */
// color = vůz (štítek, tečka, odjezd); trasa spoje na mapě je odstín téže barvy: ve světlém motivu tmavší
// (route), v tmavém světlejší (routeDark), ať je čára vidět a neruší (jako v appce)
export const STYLES = {
  BUS: { color: '#2E7D32', route: '#1B5E20', routeDark: '#66BB6A' },
  BUS_LATE: { color: '#C62828', route: '#1B5E20', routeDark: '#66BB6A' },   // trasa zpožděného autobusu je autobusová
  TRAIN: { color: '#0277BD', route: '#01579B', routeDark: '#4FC3F7' },
  TRAM: { color: '#EF6C00', route: '#C25400', routeDark: '#FFB74D' },       // oranžová (dřív fialová)
  TROLLEYBUS: { color: '#009688', route: '#00695C', routeDark: '#4DB6AC' }, // tyrkysová
  TROLLEYBUS_LATE: { color: '#C62828', route: '#00695C', routeDark: '#4DB6AC' }, // červený vůz, trasa zůstává trolejbusová
  METRO_A: { color: '#00A562', route: '#007A48', routeDark: '#4CD08F' },
  METRO_B: { color: '#F8B322', darkText: true, route: '#C68A00', routeDark: '#FFD36B' },
  METRO_C: { color: '#D6006F', route: '#A10054', routeDark: '#F0609F' },     // malinová: červená C splývala se zpožděnými autobusy
  METRO: { color: '#37474F', route: '#263238', routeDark: '#90A4AE' },
  FERRY: { color: '#1565C0', route: '#0D47A1', routeDark: '#64B5F6' },
  FUNICULAR: { color: '#6D4C41', route: '#4E342E', routeDark: '#A1887F' },
  CHRISTMAS: { color: '#800000', route: '#800000', routeDark: '#EF5350' },  // vánoční vůz: tmavě červený „dárek“ se zlatou mašlí
};
export const LATE_COLOR = '#D32F2F';
// krátké upozornění na vůz (po „Mapa“ u spojení na mobilu): barvy motivu (nastavuje app.js podle světlého / tmavého),
// fáze 1 = hlavní barva, 2 = tmavší odstín, obrys v barvě plochy
const HL = { bg: ['#3d9de8', '#1d6cb2'], fg: ['#fff', '#fff'], stroke: '#fff' };
const SEL_RING = 'rgba(61, 157, 232, .55)';  // vybrané vozidlo: modrý kroužek jako dřívější .veh.sel

/** Druh dopravy: ze serveru (`mode`), u starších odpovědí odvozený z PID uid ("g0:…" tramvaj) a linek metra. */
export function vehicleMode(v) {
  if (v.mode) return v.mode;
  if (v.train) return 'train';
  const m = /^g(\d+):/.exec(v.uid || '');
  if (m) return { 0: 'tram', 1: 'metro', 2: 'train', 4: 'ferry', 7: 'funicular' }[m[1]] || 'bus';
  if (v.source === 'pid' && /^[ABC]$/i.test(String(v.line).trim())) return 'metro';
  return 'bus';
}

export function vehicleStyle(v) {
  return v.christmas ? 'CHRISTMAS' : baseStyle(v);
}

/** Styl podle druhu dopravy a zpoždění, bez vánočního přebarvení (kategorie, ikona, rámeček zpoždění). */
export function baseStyle(v) {
  if (v.mode === 'trolleybus') return v.delay > 3 ? 'TROLLEYBUS_LATE' : 'TROLLEYBUS';
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
  const s = baseStyle(v);
  if (s === 'TRAIN') return 'train';
  if (s === 'TRAM') return 'tram';
  if (s.startsWith('METRO')) return 'metro';
  return 'bus';
}
export const CATEGORIES = [
  { id: 'bus', label: t('cat.bus'), note: t('cat.bus.note') },
  { id: 'tram', label: t('cat.tram') },
  { id: 'metro', label: t('cat.metro') },
  { id: 'train', label: t('cat.train') },
];

/** Zpoždění tramvaje / metra (u nich barva zpoždění neukazuje): červený rámeček kolem štítku / tečky. */
export function lateMinutes(v) {
  const s = baseStyle(v);
  return (s === 'TRAM' || s === 'TROLLEYBUS' || s.startsWith('METRO')) && v.delay > 3 ? Math.min(99, v.delay) : 0;
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

function drawLabel(line, styleKey, phase, late, dpr, alpha = 1, target = null) {
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
  const xmas = styleKey === 'CHRISTMAS' && !hl;
  const ring = late && !hl ? 4 : 0;
  // místo pro mašli nad štítkem; stejně tak dole, aby štítek zůstal na středu bitmapy (tj. na poloze vozu)
  const xt = xmas ? 10 : 0;
  const w = pillW + 2 * ring, h = hPx + 2 * ring + 2 * xt;
  let c;
  if (target) { c = target; c.width = Math.max(1, Math.ceil(w * dpr)); c.height = Math.max(1, Math.ceil(h * dpr)); }   // změna rozměru = čisté plátno
  else c = canvas(w * dpr, h * dpr);
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.scale(dpr, dpr);
  g.globalAlpha = alpha;   // zastaralá poloha: poloprůhledný štítek (jako v appce)
  if (ring) { g.fillStyle = LATE_COLOR; roundRect(g, 0, xt, w, h - 2 * xt, (h - 2 * xt) / 2); g.fill(); }
  const stroke = hl ? 2.5 : 0;
  const ins = stroke / 2;
  g.fillStyle = hl ? HL.bg[phase - 1] : st.color;
  roundRect(g, ring + ins, xt + ring + ins, pillW - 2 * ins, hPx - 2 * ins, (hPx - 2 * ins) / 2);
  g.fill();
  if (xmas) drawBow(g, ring + pillW / 2, xt + ring + 0.5);
  if (hl) { g.strokeStyle = HL.stroke; g.lineWidth = stroke; g.stroke(); }
  g.fillStyle = hl ? HL.fg[phase - 1] : st.darkText ? '#000' : '#fff';
  g.font = font(size);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(line, w / 2, h / 2 + size * 0.04);
  return { img: c, w, h };
}

/** Zlatá dárková mašle na horním okraji vánočního štítku (smyčky nahoru, stužky přes okraj; MapMarkers.kt v appce). */
function drawBow(g, cx, ky) {
  const gold = '#FFC107';
  const side = (s) => {
    g.beginPath();
    g.moveTo(cx + s * 0.5, ky - 0.5);
    g.bezierCurveTo(cx + s * 6, ky, cx + s * 13, ky - 2.5, cx + s * 10, ky - 7);
    g.bezierCurveTo(cx + s * 7, ky - 8.5, cx + s * 2, ky - 4.5, cx + s * 0.5, ky - 0.5);
    g.closePath();
  };
  const tail = (s) => {
    g.beginPath();
    g.moveTo(cx + s * 0.5, ky);
    g.lineTo(cx + s * 7.5, ky + 6.5); g.lineTo(cx + s * 3.2, ky + 7.8); g.lineTo(cx - s * 0.5, ky + 1.2);
    g.closePath();
  };
  g.save();
  g.fillStyle = gold; g.strokeStyle = gold; g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of [-1, 1]) { tail(s); g.fill(); }
  for (const s of [-1, 1]) { side(s); g.stroke(); }
  g.beginPath(); g.arc(cx, ky - 1.2, 3.5, 0, Math.PI * 2); g.fill();
  g.restore();
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
  // vánoční štítek má nad a pod sebou rezervu na mašli: kroužek se kreslí jen kolem štítku, mašle z něj přesahuje
  const xt = styleKey === 'CHRISTMAS' ? 10 * 1.2 : 0;
  roundRect(g, 0, xt, w, h - 2 * xt, (h - 2 * xt) / 2); g.fill();
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
  static APPEAR = 700; static SWITCH = 380; static MAX_STEP = 34; static HOLD_MAX = 600; static APPEAR_HOLD_MAX = 1500;
  constructor() { this.appearT = -1; this.switchT = 1; this.hold = 0; this.ahold = 0; this.last = 0; this.dotMode = true; }
  startAppear() { if (this.appearT < 0) this.appearT = 0; }
  resetAppear() { this.appearT = -1; this.ahold = 0; }
  setDotMode(dot) { if (dot === this.dotMode) return; this.dotMode = dot; this.switchT = 1 - this.switchT; this.hold = 0; }
  initDotMode(dot) { this.dotMode = dot; this.switchT = 1; }
  tick(now, labelsPending = false) {
    const dt = this.last ? Math.min(Fade.MAX_STEP, Math.max(0, now - this.last)) : 16;
    this.last = now;
    if (this.appearT >= 0 && this.appearT < 1) {
      // první objevení ve štítcích počká na štítky v záběru (jinak by se ukázaly tečky a po kouscích přeskočily na štítky)
      if (this.appearT === 0 && labelsPending && !this.dotMode && this.ahold < Fade.APPEAR_HOLD_MAX) this.ahold += dt;
      else this.appearT = Math.min(1, this.appearT + dt / Fade.APPEAR);
    }
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

export const GL_LAYER = 'veh-gl';
const MOVE_MS = 1000;          // přesun na novou polohu ze serveru (bez předpovědi pohybu)
const TELEPORT_M = 3000;       // větší skok se neanimuje (jiný spoj, chyba polohy)
const M_PER_DEG = 111_320;
const FLOATS = 18;             // na vrchol: from(2) to(2) t0(1) corner(2) half(2) uv(4) color(4) late(1)

const rgba = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a];
const wxOf = (lng) => (lng + 180) / 360;
const wyOf = (lat) => {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const easeOut = (l) => 1 - (1 - l) * (1 - l);   // zpomalení na konci (přesun vozidla)

const VS = `
attribute vec2 a_from; attribute vec2 a_to; attribute float a_t0; attribute vec2 a_corner; attribute vec2 a_half;
attribute vec4 a_uv; attribute vec4 a_color; attribute float a_late;
uniform mat4 u_matrix; uniform float u_time; uniform float u_dur; uniform vec2 u_vp; uniform float u_dpr;
varying vec2 v_uv; varying vec2 v_local; varying vec4 v_color; varying float v_dot; varying float v_late;
void main() {
  float l = a_t0 < 0.0 ? 1.0 : clamp((u_time - a_t0) / u_dur, 0.0, 1.0);
  float t = 1.0 - (1.0 - l) * (1.0 - l);
  vec4 c = u_matrix * vec4(mix(a_from, a_to, t), 0.0, 1.0);
  // střed na celé pixely displeje a velikost v celých pixelech = štítek 1:1 s atlasem (ostrý)
  vec2 px = floor((c.xy / c.w * 0.5 + 0.5) * u_vp * u_dpr + 0.5);
  vec2 q = (px + a_corner * a_half * u_dpr) / (u_vp * u_dpr) * 2.0 - 1.0;
  gl_Position = vec4(q * c.w, c.z, c.w);
  vec2 k = a_corner * 0.5 + 0.5;
  v_uv = vec2(mix(a_uv.x, a_uv.z, k.x), mix(a_uv.w, a_uv.y, k.y));
  v_local = a_corner * a_half;
  v_color = a_color; v_dot = a_uv.x < 0.0 ? 1.0 : 0.0; v_late = a_late;
}`;
const FS = `
precision mediump float;
uniform sampler2D u_tex; uniform float u_opacity;
varying vec2 v_uv; varying vec2 v_local; varying vec4 v_color; varying float v_dot; varying float v_late;
void main() {
  if (v_dot > 0.5) {
    // tečka ~9 px se světlým okrajem; zpožděná tramvaj / metro: okraj červený a silnější (jako v appce)
    float r = length(v_local);
    float R = v_late > 0.5 ? 5.5 : 4.5;
    float sw = v_late > 0.5 ? 2.2 : 1.2;
    float outer = 1.0 - smoothstep(R - 0.6, R + 0.4, r);
    float inner = 1.0 - smoothstep(R - sw - 0.5, R - sw + 0.5, r);
    vec4 stroke = v_late > 0.5 ? vec4(0.827, 0.184, 0.184, 1.0) : vec4(1.0, 1.0, 1.0, 0.8);
    vec4 col = mix(stroke, vec4(v_color.rgb, 1.0), inner);
    float a = col.a * outer * v_color.a * u_opacity;
    gl_FragColor = vec4(col.rgb * a, a);
  } else {
    gl_FragColor = texture2D(u_tex, v_uv) * u_opacity;   // atlas je s přednásobenou alfou
  }
}`;

export class VehicleLayer {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {{onTap?: (vehicles: object[]) => void}} opts
   */
  constructor(map, { onTap } = {}) {
    this.map = map;
    this.onTap = onTap;
    this.items = new Map();      // uid → { v, fx, fy, tx, ty (světové 0..1), t0, style, late, line, key, color, cat, stale }
    this.filter = null;          // Set kategorií, null = vše
    this.selected = null; this.flash = null;
    this.fade = new Fade();
    this.selBmp = new Map();     // štítky vybraného vozidla (canvas)
    this.queue = new Set();      // klíče štítků k nakreslení (po dávkách)
    this.uploads = [];           // nakreslené štítky čekající na nahrání do atlasu (v render)
    this.rects = new Map();      // klíč štítku → místo v atlasu
    this.visible = true;
    this._base = performance.now();
    this._dpr = Math.min(3, window.devicePixelRatio || 1);
    this._rebuild = true;
    this._back = null;           // rozestavěný nový atlas (při zaplnění), viz _upload
    this._visMissing = 0;        // vozidla v záběru, jejichž štítek ještě není v atlasu

    const cv = (this.canvas = document.createElement('canvas'));
    cv.className = 'veh-canvas';
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1';
    map.getContainer().append(cv);
    this.g = cv.getContext('2d');
    this._resize();
    map.on('resize', () => this._resize());
    map.on('render', () => this._drawSelected());   // vybrané vozidlo ve stejném snímku jako mapa
    map.on('click', (e) => this._click(e));
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = this.hitTest(e.point.x, e.point.y).length ? 'pointer' : ''; });
    // vlastní vrstvu po výměně stylu (motiv) MapLibre zahodí: přidá se znovu (GL prostředky se vytvoří v onAdd)
    map.on('style.load', () => this._addLayer());
    this.fade.initDotMode(map.getZoom() < DOT_ZOOM);
    this._addLayer();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ───── data ─────

  /** Nové polohy ze serveru: každé vozidlo se k nové poloze plynule přesune (~1 s), nic se nepředpovídá. */
  setVehicles(list) {
    const now = performance.now();
    const seen = new Set();
    for (const v of list) {
      seen.add(v.uid);
      const x = wxOf(v.lng), y = wyOf(v.lat);
      let it = this.items.get(v.uid);
      if (!it) {
        it = { fx: x, fy: y, tx: x, ty: y, t0: -1 };
        this.items.set(v.uid, it);
      } else if (it.tx !== x || it.ty !== y) {
        const [cx, cy] = this._pos(it, now);
        const dist = Math.hypot((x - cx) * 360 * M_PER_DEG * Math.cos((v.lat * Math.PI) / 180), (y - cy) * 360 * M_PER_DEG);
        if (dist > TELEPORT_M) { it.fx = x; it.fy = y; it.t0 = -1; }
        else { it.fx = cx; it.fy = cy; it.t0 = now; this._animUntil = now + MOVE_MS; }
        it.tx = x; it.ty = y;
      }
      it.v = v;
      const oldKey = it.key;
      this._meta(it);
      // jiná varianta štítku (zpoždění, zastaralá poloha): do nakreslení nové se ukazuje stará, ne tečka
      if (oldKey && oldKey !== it.key && this.rects.has(oldKey)) it.prevKey = oldKey;
      if (!this._target().rects.has(it.key)) this.queue.add(it.key);
    }
    for (const uid of this.items.keys()) if (!seen.has(uid)) this.items.delete(uid);
    if (this.items.size) this.fade.startAppear();
    this._rebuild = true;
    this._camKey = null;
    this.map.triggerRepaint();
  }

  _meta(it) {
    const v = it.v;
    const style = vehicleStyle(v);
    it.style = style;
    it.late = lateMinutes(v) > 0;
    it.line = String(v.line ?? '?');
    it.stale = v.ageSec >= STALE_S;
    it.color = STYLES[style].color;
    it.cat = vehicleCategory(v);
    it.key = `${it.line}|${style}|${it.late ? 1 : 0}|${it.stale ? 1 : 0}`;
  }

  /** Aktuální (animovaná) poloha ve světových souřadnicích 0..1. */
  _pos(it, now) {
    if (it.t0 < 0) return [it.tx, it.ty];
    const l = Math.min(1, (now - it.t0) / MOVE_MS);
    if (l >= 1) return [it.tx, it.ty];
    const t = easeOut(l);
    return [it.fx + (it.tx - it.fx) * t, it.fy + (it.ty - it.fy) * t];
  }

  vehicle(uid) { return this.items.get(uid)?.v; }
  position(uid) {
    const it = this.items.get(uid);
    if (!it) return null;
    const [x, y] = this._pos(it, performance.now());
    return { lng: x * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI };
  }

  setFilter(cats) { this.filter = cats; this._rebuild = true; this._camKey = null; this.map.triggerRepaint(); }
  setSelected(uid) { this.selected = uid; this._rebuild = true; this.map.triggerRepaint(); }
  /** Barvy zvýraznění podle motivu: bg/fg = [fáze 1, fáze 2], stroke = obrys. */
  setHighlightColors({ bg, fg, stroke }) {
    HL.bg = bg; HL.fg = fg; HL.stroke = stroke;
    this.selBmp.clear();
    this.map.triggerRepaint();
  }

  setFlash(uid) { this.flash = uid; this._rebuild = true; this.map.triggerRepaint(); }

  /** Mapa schovaná (jiná záložka): po návratu se vozidla znovu plynule objeví. */
  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) { this.fade.resetAppear(); if (this.items.size) this.fade.startAppear(); this._resize(); }
    this.map.triggerRepaint();
  }

  // ───── WebGL vrstva ─────

  _addLayer() {
    if (this.map.getLayer(GL_LAYER)) return;
    const self = this;
    try {
      this.map.addLayer({
        id: GL_LAYER, type: 'custom', renderingMode: '2d',
        onAdd(_map, gl) { self._glInit(gl); },
        onRemove(_map, gl) { self._glFree(gl); },
        render(gl, args) { self._render(gl, args); },
      });
    } catch { /* styl se ještě načítá: přidá se při 'style.load' */ }
  }

  _glInit(gl) {
    this.gl = gl;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.prog = pr;
    this.attr = {};
    for (const n of ['a_from', 'a_to', 'a_t0', 'a_corner', 'a_half', 'a_uv', 'a_color', 'a_late']) this.attr[n] = gl.getAttribLocation(pr, n);
    this.uni = {};
    for (const n of ['u_matrix', 'u_time', 'u_dur', 'u_vp', 'u_dpr', 'u_tex', 'u_opacity']) this.uni[n] = gl.getUniformLocation(pr, n);
    this.bufDots = gl.createBuffer();
    this.bufLabels = gl.createBuffer();
    this.isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.vaoExt = this.isGL2 ? null : gl.getExtension('OES_vertex_array_object');
    this.vao = this.isGL2 ? gl.createVertexArray() : this.vaoExt?.createVertexArrayOES() ?? null;
    // atlas štítků: jedna textura, řádkové skládání; při zaplnění se postaví nový (_upload)
    this.atlasSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this._back = null;
    this.tex = gl.createTexture();
    this._atlasReset();
    this._rebuild = true;
    // obrázky v atlasu jsou pryč: nakreslit znovu
    for (const it of this.items.values()) this.queue.add(it.key);
  }

  _glFree(gl) {
    try {
      gl.deleteProgram(this.prog); gl.deleteBuffer(this.bufDots); gl.deleteBuffer(this.bufLabels); gl.deleteTexture(this.tex);
      if (this._back) gl.deleteTexture(this._back.tex);
      this._back = null;
      if (this.vao) { if (this.isGL2) gl.deleteVertexArray(this.vao); else this.vaoExt?.deleteVertexArrayOES(this.vao); }
    } catch { /* ignore */ }
    this.gl = null;
  }

  /** Rozlišení štítků v atlasu: nejvýš 2× (při 3× by se do atlasu vešlo jen ~1 300 štítků, rozdíl ostrosti není vidět). */
  get _adpr() { return Math.min(2, this._dpr); }

  _initTex(tex) {
    const gl = this.gl, S = this.atlasSize;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Úplně nový atlas (start, ztráta kontextu, jiná hustota pixelů): štítky se nakreslí znovu. */
  _atlasReset() {
    if (this._back) { this.gl.deleteTexture(this._back.tex); this._back = null; }
    this._initTex(this.tex);
    this.rects.clear();
    this.ax = 2; this.ay = 2; this.arow = 0;
    this._rebuild = true;
  }

  /** Atlas, do kterého se teď kreslí: rozestavěný nový, jinak ten zobrazený. */
  _target() { return this._back || this; }

  /**
   * Zobrazený atlas je plný: nový se staví vedle jen se štítky vozidel, která teď jsou (staré varianty zpoždění,
   * vozy, co odjely, vypadnou). Do té doby se kreslí ze starého, přepne se naráz (dřív se atlas smazal a všechny
   * štítky na pár sekund spadly na tečky = blikání). Nejvýš jednou za 30 s, kdyby se ani nový nevešel.
   */
  _startBack() {
    const now = performance.now();
    if (now - (this._backAt || -1e9) < 30_000) return false;
    this._backAt = now;
    const tex = this.gl.createTexture();
    this._initTex(tex);
    this._back = { tex, rects: new Map(), ax: 2, ay: 2, arow: 0 };
    for (const it of this.items.values()) this.queue.add(it.key);
    return true;
  }

  _swapBack() {
    const b = this._back;
    this.gl.deleteTexture(this.tex);
    this.tex = b.tex; this.rects = b.rects; this.ax = b.ax; this.ay = b.ay; this.arow = b.arow;
    this._back = null;
    this._rebuild = true;
  }

  /** Nakreslí štítek do sdíleného plátna v paměti procesoru (rychlé, ~0,3 ms) a uloží ho k nahrání do atlasu. */
  _paint(key) {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.getContext('2d', { willReadFrequently: true });
    }
    const [line, style, late, stale] = key.split('|');
    const lb = drawLabel(line, style, 0, late === '1', this._adpr, stale === '1' ? 0.65 : 1, this._scratch);
    const c = lb.img;
    this.uploads.push({ key, data: c.getContext('2d').getImageData(0, 0, c.width, c.height) });
  }

  _upload(gl) {
    if (this.uploads.length) {
      const S = this.atlasSize, adpr = this._adpr;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      for (const { key, data } of this.uploads) {
        let a = this._target();
        if (a.rects.has(key)) continue;
        // sudé rozměry: polovina velikosti v celých pixelech (vertex shader kreslí od středu)
        const w = data.width + (data.width & 1), h = data.height + (data.height & 1);
        const fits = () => {
          if (a.ax + w + 2 > S) { a.ax = 2; a.ay += a.arow + 2; a.arow = 0; }
          return a.ay + h + 2 <= S;
        };
        if (!fits()) {
          if (a === this) {
            if (!this._startBack()) continue;   // plný a nový se teď stavět nemá: vůz zatím jako tečka
            a = this._back;
            fits();
          } else {
            this._swapBack();                   // ani nový se nevešel: aspoň to, co je hotové
            continue;
          }
        }
        gl.bindTexture(gl.TEXTURE_2D, a.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, a.ax, a.ay, gl.RGBA, gl.UNSIGNED_BYTE, data);
        a.rects.set(key, { u0: a.ax / S, v0: a.ay / S, u1: (a.ax + w) / S, v1: (a.ay + h) / S, hw: w / 2 / adpr, hh: h / 2 / adpr });
        a.ax += w + 2;
        if (h > a.arow) a.arow = h;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.uploads = [];
      if (!this._back) this._rebuild = true;
    }
    // nový atlas hotový (všechny štítky současných vozidel): přepnout naráz
    if (this._back && !this.queue.size) {
      let done = true;
      for (const it of this.items.values()) if (!this._back.rects.has(it.key)) { done = false; break; }
      if (done) this._swapBack();
      else for (const it of this.items.values()) if (!this._back.rects.has(it.key)) this.queue.add(it.key);
    }
  }

  /** Buffery vrcholů: tečky a štítky (štítek, který ještě není v atlasu, zastoupí tečka). Jen při změně dat. */
  _build(gl) {
    const list = [];
    for (const uid of [...this.items.keys()].sort()) {
      const it = this.items.get(uid);
      if (this.filter && !this.filter.has(it.cat)) continue;
      if (uid === this.selected || uid === this.flash) continue;   // vybrané kreslí canvas
      list.push(it);
    }
    list.sort((a, b) => (a.style === 'CHRISTMAS') - (b.style === 'CHRISTMAS'));   // vánoční vozy se kreslí poslední = nad ostatními (stabilní řazení)
    const now = performance.now();
    const ox = (this._ox = this.map.getCenter ? wxOf(this.map.getCenter().lng) : 0.5);
    const oy = (this._oy = wyOf(this.map.getCenter().lat));
    const dots = new Float32Array(list.length * 6 * FLOATS);
    const labs = new Float32Array(list.length * 6 * FLOATS);
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
    const put = (arr, i, it, half, uv, col) => {
      let o = i * 6 * FLOATS;
      const t0 = it.t0 >= 0 && now - it.t0 < MOVE_MS ? it.t0 - this._base : -1;
      for (let k = 0; k < 6; k++) {
        arr[o++] = it.fx - ox; arr[o++] = it.fy - oy; arr[o++] = it.tx - ox; arr[o++] = it.ty - oy; arr[o++] = t0;
        arr[o++] = CORNERS[k * 2]; arr[o++] = CORNERS[k * 2 + 1];
        arr[o++] = half[0]; arr[o++] = half[1];
        arr[o++] = uv[0]; arr[o++] = uv[1]; arr[o++] = uv[2]; arr[o++] = uv[3];
        arr[o++] = col[0]; arr[o++] = col[1]; arr[o++] = col[2]; arr[o++] = col[3];
        arr[o++] = it.late ? 1 : 0;
      }
    };
    const DOT_UV = [-1, -1, -1, -1];
    list.forEach((it, i) => {
      const col = rgba(it.color, it.stale ? 0.65 : 1);
      const dh = it.late ? 6.5 : 5.5;
      put(dots, i, it, [dh, dh], DOT_UV, col);
      let r = this.rects.get(it.key);
      if (r) it.prevKey = null;
      else if (it.prevKey) r = this.rects.get(it.prevKey);
      if (r) put(labs, i, it, [r.hw, r.hh], [r.u0, r.v0, r.u1, r.v1], col);
      else put(labs, i, it, [dh, dh], DOT_UV, col);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufDots); gl.bufferData(gl.ARRAY_BUFFER, dots, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLabels); gl.bufferData(gl.ARRAY_BUFFER, labs, gl.DYNAMIC_DRAW);
    this.count = list.length;
    this.drawn = list;
    this._rebuild = false;
  }

  _bindAttribs(gl, buf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const st = FLOATS * 4;
    const a = this.attr;
    const set = (loc, n, off) => { if (loc < 0) return; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, st, off * 4); };
    set(a.a_from, 2, 0); set(a.a_to, 2, 2); set(a.a_t0, 1, 4); set(a.a_corner, 2, 5); set(a.a_half, 2, 7);
    set(a.a_uv, 4, 9); set(a.a_color, 4, 13); set(a.a_late, 1, 17);
  }

  _render(gl, args) {
    if (!this.prog) return;
    const now = performance.now();
    this._upload(gl);
    if (this._rebuild) this._build(gl);

    // režim podle zoomu a počtu vozidel v záběru (s hysterezí); počítá se jen při změně kamery nebo dat
    const map = this.map, zoom = map.getZoom();
    const camKey = `${zoom.toFixed(3)}|${map.getCenter().lng.toFixed(5)}|${map.getCenter().lat.toFixed(5)}|${this.w}x${this.h}`;
    if (camKey !== this._camKey) {
      this._camKey = camKey;
      const b = map.getBounds();
      let n = 0;
      for (const it of this.drawn || []) { const v = it.v; if (v.lat >= b.getSouth() && v.lat <= b.getNorth() && v.lng >= b.getWest() && v.lng <= b.getEast()) n++; }
      this._nVis = n;
    }
    const dotNow = this.fade.dotMode;
    const zoomOk = dotNow ? zoom >= DOT_ZOOM + DOT_HYST : zoom >= DOT_ZOOM;
    const countOk = (this._nVis || 0) <= (dotNow ? LABEL_MAX : LABEL_MAX * 1.2);
    this.fade.setDotMode(!(zoomOk && countOk));
    this.fade.tick(now, this._visMissing > 0);
    const appear = this.visible ? this.fade.appear : 0;
    const dotA = this.fade.dotAlpha * appear, labA = this.fade.labelAlpha * appear;

    // MapLibre 5 dává matici pro pixely světa při aktuálním zoomu (0..512·2^zoom); vozidla jsou v souřadnicích 0..1
    // relativně k počátku (přesnost float32 i při velkém přiblížení): M' = M · měřítko(ws) · posun(počátek)
    const M0 = args.modelViewProjectionMatrix || args.defaultProjectionData?.mainMatrix;
    const ws = 512 * 2 ** zoom;
    const M = this._M || (this._M = new Float64Array(16));
    for (let i = 0; i < 16; i++) M[i] = M0[i] * (i < 8 ? ws : 1);   // matice pro absolutní souřadnice 0..1
    const ox = this._ox, oy = this._oy;
    const m = this._m || (this._m = new Float32Array(16));
    for (let i = 0; i < 12; i++) m[i] = M[i];
    for (let r = 0; r < 4; r++) m[12 + r] = M[r] * ox + M[4 + r] * oy + M[12 + r];

    if (this.count && (dotA > 0.003 || labA > 0.003)) {
      if (this.vao) { if (this.isGL2) gl.bindVertexArray(this.vao); else this.vaoExt.bindVertexArrayOES(this.vao); }
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uni.u_matrix, false, m);
      gl.uniform1f(this.uni.u_time, now - this._base);
      gl.uniform1f(this.uni.u_dur, MOVE_MS);
      gl.uniform2f(this.uni.u_vp, this.w, this.h);
      gl.uniform1f(this.uni.u_dpr, this._dpr);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.uni.u_tex, 0);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const pass = (buf, a) => {
        if (a <= 0.003) return;
        this._bindAttribs(gl, buf);
        gl.uniform1f(this.uni.u_opacity, a);
        gl.drawArrays(gl.TRIANGLES, 0, this.count * 6);
      };
      pass(this.bufDots, dotA);
      pass(this.bufLabels, labA);
      if (this.vao) { if (this.isGL2) gl.bindVertexArray(null); else this.vaoExt.bindVertexArrayOES(null); }
    }
    this._opa = [dotA, labA];
    // další snímek, dokud se něco hýbe / prolíná / chystá
    if (now < (this._animUntil || 0) || this.fade.animating || this.uploads.length || this._back || (this.flash && this.items.has(this.flash))) map.triggerRepaint();
  }

  // ───── štítky dopředu (mimo snímek mapy) ─────

  _resize() {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr !== this._dpr) {
      this._dpr = dpr; this.selBmp.clear();
      if (this.gl) { this._atlasReset(); for (const it of this.items.values()) this.queue.add(it.key); }
    }
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`;
    this._camKey = null;
  }

  _loop() {
    requestAnimationFrame(this._loop);
    if (!this.gl) return;
    if (!this.queue.size) { if (!this.uploads.length) this._visMissing = 0; return; }
    // štítky po malých dávkách (při pohybu mapy menších, ať nebere čas snímkům mapy); nahrají se v příštím snímku.
    // Nejdřív vozidla v záběru (s okrajem), ať se po otevření mapy ukážou štítky hned tam, kam se člověk dívá.
    const t0 = performance.now(), budget = this.map.isMoving() ? 2 : 6;
    const target = this._target().rects;
    const b = this.map.getBounds();
    const padLat = (b.getNorth() - b.getSouth()) * 0.15, padLng = (b.getEast() - b.getWest()) * 0.15;
    const S = b.getSouth() - padLat, N = b.getNorth() + padLat, W = b.getWest() - padLng, E = b.getEast() + padLng;
    const first = [];
    let missing = 0;
    for (const it of this.items.values()) {
      const v = it.v;
      if (v.lat < S || v.lat > N || v.lng < W || v.lng > E) continue;
      if (this.filter && !this.filter.has(it.cat)) continue;
      if (!this.rects.has(it.key) && !(it.prevKey && this.rects.has(it.prevKey))) missing++;
      if (this.queue.has(it.key)) first.push(it.key);
    }
    this._visMissing = missing;
    const paint = (k) => {
      if (!this.queue.delete(k)) return false;
      if (!target.has(k)) this._paint(k);
      return performance.now() - t0 > budget;
    };
    let stop = false;
    for (const k of first) if ((stop = paint(k))) break;
    if (!stop) for (const k of this.queue) if (paint(k)) break;
    if (this.uploads.length) this.map.triggerRepaint();
  }

  // ───── vybrané vozidlo (canvas) ─────

  _drawSelected() {
    const g = this.g, dpr = this._dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    this._hl = null;
    if (!this.visible) return;
    const uid = this.flash || this.selected;
    const it = uid && this.items.get(uid);
    if (!it || (this.filter && !this.filter.has(it.cat))) return;
    const now = performance.now();
    const p = this.map.project(this.position(uid));
    const flash = uid === this.flash;
    const phase = flash ? (Math.floor(now / 400) % 2 === 0 ? 1 : 2) : 3;
    const k = `${it.line}|${it.style}|${phase}|${it.late ? 1 : 0}`;
    let b = this.selBmp.get(k);
    if (!b) { b = drawLabel(it.line, it.style, phase, it.late, dpr); this.selBmp.set(k, b); }
    g.globalAlpha = Math.max(this.fade.appear, 0.01);
    g.drawImage(b.img, Math.round(p.x - b.w / 2), Math.round(p.y - b.h / 2), b.w, b.h);
    g.globalAlpha = 1;
    this._hl = { x: p.x, y: p.y, hw: b.w / 2, hh: b.h / 2, v: it.v };
  }

  // ───── ťuknutí ─────

  /** Obrazovková poloha vozidla (CSS px) z poslední matice snímku; null mimo záběr. */
  _screen(it, now) {
    const M = this._M;
    if (!M) return null;
    const [x, y] = this._pos(it, now);
    const cx = M[0] * x + M[4] * y + M[12], cy = M[1] * x + M[5] * y + M[13], cw = M[3] * x + M[7] * y + M[15];
    return [(cx / cw * 0.5 + 0.5) * this.w, (1 - (cy / cw * 0.5 + 0.5)) * this.h];
  }

  /** Vozidla pod bodem (CSS px v mapě): víc přes sebe = všechna (výběr), jinak nejbližší s rezervou na prst. */
  hitTest(px, py) {
    const hl = this._hl;
    if (hl && Math.abs(hl.x - px) <= hl.hw + 4 && Math.abs(hl.y - py) <= hl.hh + 3) return [hl.v];
    if (!this.visible || !this._opa || !this.drawn) return [];
    const labels = this._opa[1] > 0.5;
    const now = performance.now();
    let best = null, bestD = Infinity;
    const covering = [];
    for (let i = this.drawn.length - 1; i >= 0; i--) {   // odshora (poslední kreslené je navrchu)
      const it = this.drawn[i];
      const s = this._screen(it, now);
      if (!s) continue;
      const r = labels ? this.rects.get(it.key) || (it.prevKey && this.rects.get(it.prevKey)) : null;
      const hw = r ? r.hw : 4.5, hh = r ? r.hh : 4.5;
      const dx = Math.abs(s[0] - px), dy = Math.abs(s[1] - py);
      const dotLike = !r;
      if (dx > hw + (dotLike ? 7 : 4) || dy > hh + (dotLike ? 7 : 3)) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = it.v; }
      if (dx <= hw && dy <= hh) covering.push(it.v);
    }
    if (covering.length >= 2) return covering;
    return best ? [best] : [];
  }

  _click(e) {
    const hits = this.hitTest(e.point.x, e.point.y);
    if (!hits.length) return;
    e.preventDefault?.();
    e.originalEvent?.stopPropagation?.();
    this.onTap?.(hits);
  }

  destroy() { this.canvas.remove(); this.items.clear(); try { this.map.removeLayer(GL_LAYER); } catch { /* ignore */ } }
}
