// Spoje UK: webová aplikace (vyhledávání spojení + živá mapa vozidel).
import { CONFIG } from './config.js';
import { loadTimetable } from './timetable.js';
import { Planner, describeJourney } from './planner.js';
import { suggest, nearestPlaces } from './suggest.js';
import { LiveTracker, fetchVehicles, sourceStatusParts, vehicleUid } from './live.js';
import { MapView } from './gl-map.js';
import { VehicleLayer, CATEGORIES, vehicleStyle, vehicleMode, lateMinutes, STYLES, LATE_COLOR, isDpmulTrolleybus } from './vehicle-layer.js';
import { ShapeStore, legRoute, osrmRoute, footRoute, footDistances, WALK_M_PER_MIN } from './shapes.js';
import { store } from './store.js';
import { StopIndex, STOP_DEPARTURE_HOURS } from './stops.js';
import { StopLayer } from './stop-layer.js';
import { rideIndices, activeLegIndex, transferStatus, arrivingBy, distanceToRouteM } from './journey-logic.js';
import {
  prettyName, splitStopName, stopLabel, hhmm, pragueNow, addDays, dayDiff, dayToIso, isoToDay, fmtMinutes, fmtDist,
  pluralStops, pluralTransfers, ageLabel, fmtDayShort, DAY_NAMES, weekday, NBSP, dedupeByUid, distanceM,
} from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="/assets/icons.svg#${n}"/></svg>`;

// ───────────── animace zobrazení / skrytí ─────────────
// Zobrazení animuje CSS (animace běží, když prvek přestane mít display: none), skrytí tady: prvek nejdřív
// plynule zmizí a teprve pak dostane hidden. Při „omezit pohyb“ v systému se nic neanimuje.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => matchMedia('(max-width: 640px)').matches;
const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)', EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';

function showEl(el) {
  if (!el) return;
  if (el._hiding) { el._hiding = false; el._hideAnim?.cancel(); }
  el.hidden = false;
}

function hideEl(el, { y = 8, scale = 1, duration = 170 } = {}) {
  if (!el || el.hidden || el._hiding) return;
  if (reduceMotion()) { el.hidden = true; return; }
  el._hiding = true;
  const a = (el._hideAnim = el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${y}px) scale(${scale})` }],
    { duration, easing: EASE_IN, fill: 'forwards' },
  ));
  a.finished.then(() => { if (el._hiding) { el._hiding = false; el.hidden = true; } a.cancel(); }).catch(() => {});
}

/** Krátké oznámení dole (nenalezené vozidlo, přibližná poloha…), samo zmizí. */
let toastTimer;
function toast(text, ms = 4500) {
  const t = $('#toast');
  t.textContent = text;
  if (!t.hidden && !t._hiding) t.animate([{ transform: 'scale(1.03)' }, { transform: 'none' }], { duration: 180, easing: EASE_OUT });
  showEl(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideEl(t, { y: 12 }), ms);
}

/** Stav aplikace. */
const S = {
  tt: null, planner: null, live: null, index: [], map: null,
  from: null, to: null, mode: null, when: 'now',   // mode: Set druhů dopravy, null = vše
  journeys: [], desc: new Map(), expanded: new Set(), query: null, loadingMore: false, noMoreEarlier: false,
  loc: null, vehicles: [], vlayer: null, selected: null, flashUid: null,
  stopIdx: null, slayer: null, stopSel: null, stopTimer: 0,   // zastávky na mapě a otevřený panel odjezdů
  overlay: { lines: [], markers: [] }, meMarker: null,
  arrive: false,             // zvolený čas je příjezd ("chci tam být do"), ne odjezd
  detail: null,              // spojení otevřené v detailu (popis z describeJourney)
  collapsed: new Set(),      // sbalené mezizastávky v detailu (index jízdy)
  nearby: null,              // odjezdy z nejbližší zastávky { place, distM, platforms, deps }
};

// ───────────── motiv ─────────────
const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };
const THEME_LABEL = { auto: 'automaticky', light: 'světlý', dark: 'tmavý' };
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() {
  const t = store.theme();
  return t === 'auto' ? (darkMq.matches ? 'dark' : 'light') : t;
}
function applyTheme() {
  const t = store.theme();
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $('#theme-btn');
  b.innerHTML = icon(THEME_ICON[t]);
  b.setAttribute('aria-label', `Vzhled: ${THEME_LABEL[t]}. Klepnutím změníš.`);
  S.map?.setTheme(resolvedTheme());
  applyHighlightColors();
  const m = $('meta[name="theme-color"]');
  if (m) m.content = resolvedTheme() === 'dark' ? '#05111f' : '#3d9de8';
}
/** Zvýraznění vozu po „Mapa“ v barvách motivu (hlavní barva, tmavší odstín, obrys v barvě plochy). */
function applyHighlightColors() {
  if (!S.vlayer) return;
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const dark = resolvedTheme() === 'dark';
  S.vlayer.setHighlightColors({
    bg: [v('--brand'), dark ? v('--brand-300') : v('--brand-700')],
    fg: [dark ? '#04243d' : '#fff', '#fff'],
    stroke: v('--surface') || '#fff',
  });
}

$('#theme-btn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  store.setTheme(order[(order.indexOf(store.theme()) + 1) % 3]);
  applyTheme();
});
darkMq.addEventListener('change', applyTheme);

// ───────────── záložky ─────────────
function setTab(tab) {
  const changed = $('#shell').dataset.tab !== tab;
  $('#shell').dataset.tab = tab;
  // mobil: přepnutí záložky krátce prolne (na širokém displeji jsou vidět obě části)
  if (changed && isMobile() && !reduceMotion()) {
    const el = tab === 'map' ? $('#mapwrap') : $('.panel');
    el?.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE_OUT });
  }
  $$('.tabbar button').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (tab === 'map') requestAnimationFrame(() => S.map?.invalidate());
  requestAnimationFrame(() => S.vlayer?.setVisible(mapShown()));
  // stav historie (otevřené podobrazovky) se zachová, mění se jen adresa
  try { history.replaceState(history.state, '', tab === 'map' ? '#map' : location.pathname + location.search); } catch { /* ignore */ }
}

// ───────────── podobrazovky a zpět ─────────────
// Výsledky, detail spojení a (na mobilu) mapa jsou záznamy v historii prohlížeče: tlačítko i gesto zpět vrací
// o krok (detail → výsledky → formulář, mapa → odkud se na ni šlo), stejně jako v Android appce.
let navStack = [];
const navTop = () => navStack[navStack.length - 1];

function showView(el, on) {
  if (on) {
    if (!el.hidden && !el._hiding) return;
    showEl(el);
    if (!reduceMotion()) el.animate([{ transform: 'translateX(24%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE_OUT });
  } else hideEl(el, { y: 0, duration: 180 });
}

function applyNav(stack) {
  navStack = stack;
  showView($('#results-view'), stack.includes('results'));
  showView($('#detail-view'), stack.includes('detail'));
  if (!stack.includes('detail')) S.detail = null;
  if (isMobile()) setTab(navTop() === 'map' ? 'map' : 'search');
}
function navPush(name) {
  const stack = [...navStack.filter((x) => x !== name), name];
  history.pushState({ nav: stack }, '', name === 'map' ? '#map' : location.pathname + location.search);
  applyNav(stack);
}
/** Zpět o krok (tlačítko šipky v podobrazovce): přes historii, ať sedí i tlačítko zpět prohlížeče. */
function navBack() { if (navStack.length) history.back(); }
window.addEventListener('popstate', (e) => applyNav(e.state?.nav || []));
$$('[data-back]').forEach((b) => b.addEventListener('click', navBack));

/** Přepnutí na mapu (Mapa u spojení, odjezd): na mobilu jako krok v historii, ať zpět vrátí, odkud se přišlo. */
function goMap() {
  if (isMobile()) { if (navTop() !== 'map') navPush('map'); } else setTab('map');
}

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'map') goMap();
  else if (navTop() === 'map') navBack();
  else setTab('search');
}));

// ───────────── mapa ─────────────
function initMap() {
  S.map = new MapView($('#map'), { center: CONFIG.MAP_CENTER, zoom: 12, configUrl: CONFIG.MAP_CONFIG_URL, theme: resolvedTheme() });
  S.map.on('tilesfailed', () => { const o = $('#outage'); o.querySelector('span').textContent = 'Podkladovou mapu se nepodařilo načíst (blokátor reklam nebo síť?). Vozidla se zobrazují i tak.'; o.hidden = false; });
  S.vlayer = new VehicleLayer(S.map.map, {
    onTap: (hits) => (hits.length > 1 ? chooseVehicle(hits) : selectVehicle(hits[0].uid)),
  });
  S.vlayer.setFilter(loadFilter());
  S.vlayer.setVisible(mapShown());
  // ťuknutí na vozidlo řeší vrstva vozidel; na zastávku = odjezdy; jinam do mapy = zavřít detail
  S.map.on('click', (e) => {
    if (S.vlayer.hitTest(e.point.x, e.point.y).length) return;
    const st = S.slayer?.hitTest(e.point.x, e.point.y);
    if (st) { openStop(st); return; }
    if (S.selected || S.stopSel) closeSheet();
  });
  setupFilter();
}

/** Je mapa vidět? (na mobilu jen na záložce Mapa, na širokém displeji pořád) */
function mapShown() {
  const el = $('#mapwrap');
  return !!el && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
}

// ───────────── filtr druhů dopravy na mapě ─────────────
const ALL_CATS = CATEGORIES.map((c) => c.id);
const CAT_COLOR = { bus: STYLES.BUS.color, tram: STYLES.TRAM.color, metro: STYLES.METRO_A.color, train: STYLES.TRAIN.color };
function loadFilter() {
  const f = store.get('mapCats', null);
  if (!Array.isArray(f)) return null;
  const set = new Set(f.filter((x) => ALL_CATS.includes(x)));
  return set.size === ALL_CATS.length ? null : set;
}
/**
 * Dialog druhů dopravy: pro mapu i pro hledání spojení stejný (jako v Android appce).
 * selected = Set druhů nebo null (vše); onChange dostane totéž při každé změně.
 */
function openCategoryDialog(title, selected, onChange, onClose, { allowEmpty = true } = {}) {
  const dlg = $('#filter-dlg'), list = $('#filter-list');
  $('#filter-title').textContent = title;
  list.innerHTML = CATEGORIES.map((c) => `<label class="filter-row">
      <input type="checkbox" value="${c.id}" ${!selected || selected.has(c.id) ? 'checked' : ''}>
      <span class="filter-dot" style="background:${CAT_COLOR[c.id]}"></span>
      <span><strong>${c.label}</strong>${c.note ? `<small>${c.note}</small>` : ''}</span></label>`).join('');
  // hledání spojení: poslední zaškrtnutý druh nejde odebrat (hledat „ničím“ nedává smysl)
  const lock = () => {
    const on = $$('input:checked', list);
    $$('input', list).forEach((i) => { i.disabled = !allowEmpty && on.length === 1 && i.checked; });
  };
  const apply = () => {
    const on = $$('input:checked', list).map((i) => i.value);
    lock();
    onChange(on.length === ALL_CATS.length ? null : new Set(on));
  };
  list.onchange = (e) => {
    if (!allowEmpty && !$$('input:checked', list).length) { e.target.checked = true; lock(); return; }
    apply();
  };
  lock();
  $('#filter-all').onclick = () => { $$('input', list).forEach((i) => { i.checked = true; }); apply(); };
  dlg.addEventListener('close', () => onClose?.(), { once: true });
  showDialog(dlg);
}

const catSummary = (set) => (!set ? 'Všechny druhy' : set.size ? CATEGORIES.filter((c) => set.has(c.id)).map((c) => c.label).join(', ') : 'Nic');

function setupFilter() {
  const btn = $('#filter-btn');
  const sync = () => {
    const f = S.vlayer.filter;
    btn.classList.toggle('on', !!f);
    btn.setAttribute('aria-label', f ? `Zobrazené druhy: ${CATEGORIES.filter((c) => f.has(c.id)).map((c) => c.label).join(', ') || 'nic'}` : 'Zobrazené druhy: vše');
    $('#filter-count').textContent = f ? String(f.size) : '';
    $('#filter-count').hidden = !f;
  };
  btn.addEventListener('click', () => openCategoryDialog('Co zobrazit na mapě', S.vlayer.filter, (set) => {
    S.vlayer.setFilter(set);
    store.set('mapCats', set ? [...set] : ALL_CATS);
    sync();
  }));
  sync();
}

/** Druhy dopravy pro hledání spojení: stejný dialog jako na mapě; pamatuje se, hledá se až tlačítkem. */
function setupModeFilter() {
  const saved = store.get('searchCats', null);
  if (Array.isArray(saved)) {
    const set = new Set(saved.filter((x) => ALL_CATS.includes(x)));
    S.mode = set.size === ALL_CATS.length || set.size === 0 ? null : set;
  }
  const sync = () => {
    $('#mode-label').textContent = catSummary(S.mode);
    $('#mode-btn').classList.toggle('on', !!S.mode);
    $('#mode-btn').setAttribute('aria-label', `Druhy dopravy: ${catSummary(S.mode)}`);
    $('#mode-dots').innerHTML = CATEGORIES.filter((c) => !S.mode || S.mode.has(c.id)).map((c) => `<span class="filter-dot" style="background:${CAT_COLOR[c.id]}"></span>`).join('');
  };
  $('#mode-btn').addEventListener('click', () => {
    openCategoryDialog('Čím cestovat', S.mode, (set) => {
      S.mode = set;
      store.set('searchCats', set ? [...set] : ALL_CATS);
      sync();
    }, null, { allowEmpty: false });
  });
  sync();
}

const MODE_LABEL = { bus: 'Bus', trolleybus: 'Trolejbus', tram: 'Tramvaj', metro: 'Metro', train: 'Vlak', ferry: 'Přívoz', funicular: 'Lanovka' };
const MODE_ICON = { bus: 'bus', trolleybus: 'bus', tram: 'tram', metro: 'metro', train: 'train', ferry: 'boat', funicular: 'tram' };
/**
 * Název zastávky u vozidla: autobus / MHD jen zastávka bez obce ("Divadlo"), vlak celý název (jezdí daleko).
 * Stejně jako vehicleStopName v Android appce.
 */
const vehStop = (name, train) => (train ? prettyName(name) : stopLabel(prettyName(name)));

/** Konečná vozidla: cíl ze zdroje, jinak (DPMÚL cíl neposílá) ze spoje v jízdním řádu nebo z dohledání na serveru. */
function vehicleTerminal(v) {
  if (v.dest) return v.dest;
  try { const d = S.live?.detail(v); if (d?.terminal) return d.terminal; } catch { /* bez jízdního řádu */ }
  const r = remoteTrips.get(v.uid)?.data;
  return r?.stops?.length ? r.stops[r.stops.length - 1][0] : null;
}

/** Druh vozidla v jednotném čísle; trolejbus podle `mode` ze serveru (na mapě patří k autobusům). */
const kindOf = (v) => (vehicleStyle(v).startsWith('TROLLEYBUS') ? 'trolleybus' : vehicleMode(v));

/** Víc vozidel pod prstem (třeba dva vlaky v jedné stanici): výběr ze seznamu. */
function chooseVehicle(hits) {
  const dlg = $('#choose-dlg');
  $('#choose-list').innerHTML = hits.slice(0, 12).map((v, i) => {
    const st = STYLES[vehicleStyle(v)];
    // stejně jako v Android appce: ikona druhu v barvě vozidla, „Autobus 9“, „směr Divadlo“ (zkrácený název)
    const kind = kindOf(v);
    const term = vehicleTerminal(v);
    const sub = term ? `směr ${vehStop(term, v.train)}` : (v.agency || sourceLabel(v));
    return `<li><button type="button" data-i="${i}"><span class="kind-ico" style="background:${st.color};color:${st.darkText ? '#000' : '#fff'}">${icon(MODE_ICON[kind] || 'bus')}</span>
      <span class="kind-txt"><strong>${esc(MODE_LABEL[kind] || 'Vozidlo')} ${esc(v.line)}</strong><small>${esc(sub)}</small></span></button></li>`;
  }).join('');
  $('#choose-list').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    animateDialogClose(dlg);
    selectVehicle(hits[+b.dataset.i].uid);
  };
  showDialog(dlg);
}

// ───────────── napovídání zastávek ─────────────
function setupField(key) {
  const field = $(`[data-field="${key}"]`);
  const input = $('input', field), list = $('.suggest', field), clearBtn = $('[data-action="clear"]', field);
  let items = [], active = -1, typed = false;

  const setValue = (place) => {
    S[key] = place;
    input.value = place ? prettyName(place) : '';
    clearBtn.hidden = !place;
  };
  field.setValue = setValue;

  const close = () => { hideEl(list, { y: -4, duration: 130 }); input.setAttribute('aria-expanded', 'false'); active = -1; input.removeAttribute('aria-activedescendant'); };
  const choose = (place) => { setValue(place); close(); typed = false; if (key === 'from' && !S.to) $('#to-input').focus(); };

  const render = () => {
    const q = typed ? input.value : '';
    items = suggest(S.index, q, { usage: store.usage(), loc: S.loc, limit: 8 });
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = `<li class="hint" role="option" aria-disabled="true">${q ? 'Nic jsme nenašli. Zkus jiný název.' : 'Začni psát název zastávky.'}</li>`;
    }
    items.forEach((it, i) => {
      const { stop, city } = splitStopName(prettyName(it.place));
      const li = document.createElement('li');
      li.id = `${key}-opt-${i}`; li.setAttribute('role', 'option'); li.dataset.i = i;
      const meta = it.used && !q ? '' : Number.isFinite(it.dist) ? fmtDist(it.dist) : '';
      li.innerHTML = `<span class="ico">${icon(it.used ? 'clock' : 'pin')}</span>
        <span class="txt"><span class="name">${esc(stop || it.place)}</span><span class="sub">${esc(city)}</span></span>
        ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
        ${it.used && !q ? `<button type="button" class="forget" aria-label="Odebrat z často používaných" data-forget="${i}">${icon('x')}</button>` : ''}`;
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };
  const highlight = (i) => {
    active = i;
    $$('li[role="option"]', list).forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${key}-opt-${i}`); $$('li', list)[i]?.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('focus', () => { typed = false; input.select(); render(); });
  input.addEventListener('input', () => { typed = true; S[key] = null; clearBtn.hidden = !input.value; render(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); highlight(Math.min(items.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && !list.hidden && items.length) { e.preventDefault(); choose(items[active >= 0 ? active : 0].place); if (key === 'to') $('#search-form').requestSubmit(); }
  });
  // mousedown místo click, aby se výběr stihl před blur
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const f = e.target.closest('[data-forget]');
    if (f) { store.forgetUsage(items[+f.dataset.forget].place); render(); return; }
    const li = e.target.closest('li[data-i]');
    if (li) choose(items[+li.dataset.i].place);
  });
  clearBtn.addEventListener('click', () => { setValue(null); input.focus(); });
  $('[data-action="locate"]', field)?.addEventListener('click', useMyLocation);
}

/**
 * Poloha zařízení. Prohlížeč první odpověď často vezme z IP adresy / Wi-Fi s nepřesností kilometrů
 * (na počítači typicky střed Prahy => "nejbližší zastávka Praha hlavní nádraží"). Proto se chvíli sleduje
 * a bere se nejpřesnější odpověď; když je pořád jen přibližná, vrátí se s příznakem [coarse].
 */
const GOOD_ACCURACY_M = 150;
const COARSE_ACCURACY_M = 2000;
async function getLocation({ waitMs = 7000 } = {}) {
  if (!navigator.geolocation) throw new Error('Prohlížeč nepodporuje určení polohy.');
  return new Promise((res, rej) => {
    let best = null, done = false, id = null;
    const stop = () => { done = true; clearTimeout(timer); if (id != null) navigator.geolocation.clearWatch(id); };
    const finish = () => {
      if (done) return;
      stop();
      if (best) res({ ...best, coarse: best.acc > COARSE_ACCURACY_M });
      else rej(new Error('Polohu se nepodařilo zjistit.'));
    };
    const timer = setTimeout(finish, waitMs);
    id = navigator.geolocation.watchPosition(
      (p) => {
        const c = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy ?? 99999 };
        if (!best || c.acc <= best.acc) best = c;
        if (best.acc <= GOOD_ACCURACY_M) finish();
      },
      (e) => {
        if (done) return;
        if (e.code === 1) { stop(); rej(new Error('Přístup k poloze je zakázaný. Povol ho v nastavení prohlížeče.')); }
        else if (best) finish();
      },
      // čerstvá poloha (ne z cache), s GPS když je
      { enableHighAccuracy: true, timeout: waitMs, maximumAge: 0 });
  });
}

const accText = (m) => (m >= 1000 ? `${Math.round(m / 1000)} km` : `${Math.round(m)} m`);

function formMessage(text, kind = 'warn') {
  const m = $('#form-msg');
  if (!text) { hideEl(m, { y: -4, duration: 140 }); return; }
  m.textContent = text;
  m.style.background = kind === 'info' ? 'var(--brand-100)' : ''; m.style.color = kind === 'info' ? 'var(--brand-700)' : '';
  showEl(m);
}

async function useMyLocation() {
  formMessage('');
  try {
    formMessage('Zjišťuji polohu…', 'info');
    const loc = await getLocation();
    if (loc.coarse) {
      // přibližná poloha (podle IP adresy) by vybrala úplně jinou zastávku, třeba Praha hl. n.
      return formMessage(`Poloha je jen přibližná (± ${accText(loc.acc)}), nejspíš podle IP adresy. Zapni určování polohy (GPS) nebo zastávku vyber ručně.`);
    }
    S.loc = loc;
    const cands = nearestPlaces(S.index, loc.lat, loc.lng, 6).filter((c) => c.dist <= 5000);
    if (!cands.length) return formMessage('V okolí jsme nenašli žádnou zastávku.');
    // nejbližší PĚŠKY (jako v appce): zastávka za řekou nebo kolejištěm bývá vzdušnou čarou blízko, ale cesta dlouhá
    formMessage('Hledám nejbližší zastávku pěšky…', 'info');
    const walk = await footDistances([loc.lat, loc.lng], cands.map((c) => [c.lat, c.lng]));
    let best = cands[0], walkM = null;
    if (walk) cands.forEach((c, i) => { if (walk[i] != null && (walkM == null || walk[i] < walkM)) { walkM = walk[i]; best = c; } });
    $('[data-field="from"]').setValue(best.place);
    refreshNearby({ relocate: true });
    const how = walkM != null
      ? `${fmtDist(walkM)} pěšky, asi ${Math.max(1, Math.round(walkM / WALK_M_PER_MIN))}${NBSP}min`
      : `${fmtDist(best.dist)} vzdušnou čarou`;
    formMessage(`Nejbližší zastávka: ${stopLabel(prettyName(best.place))} (${how}).`, 'info');
  } catch (e) { formMessage(e.message); }
}

// ───────────── formulář ─────────────
function setupForm() {
  setupField('from'); setupField('to');
  $('#swap').addEventListener('click', () => {
    const [a, b] = [S.from, S.to];
    $('[data-field="from"]').setValue(b); $('[data-field="to"]').setValue(a);
  });
  $$('[data-when]').forEach((b) => b.addEventListener('click', () => {
    S.when = b.dataset.when;
    $$('[data-when]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#when').hidden = S.when === 'now';
    if (S.when === 'custom' && !$('#date-input').value) {
      const n = pragueNow();
      $('#date-input').value = dayToIso(n.day);
      $('#time-input').value = hhmm(n.sec);
    }
  }));
  // zvolený čas = odjezd, nebo příjezd ("chci tam být do"); hledá se až tlačítkem
  $$('[data-arrive]').forEach((b) => b.addEventListener('click', () => {
    S.arrive = b.dataset.arrive === '1';
    $$('[data-arrive]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#time-label').textContent = S.arrive ? 'Čas příjezdu' : 'Čas odjezdu';
  }));
  setupModeFilter();
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
  $('#earlier').addEventListener('click', loadEarlier);
  $('#later').addEventListener('click', loadLater);
  new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && S.journeys.length && !S.query?.arrive) loadLater(true); }, { root: $('#res-scroll'), rootMargin: '0px 0px 200px 0px' }).observe($('#more'));
  renderTrips();

  // předvyplnění z minulé cesty
  const last = store.lastTrip();
  if (last && S.tt.places.has(last.from) && S.tt.places.has(last.to)) {
    $('[data-field="from"]').setValue(last.from); $('[data-field="to"]').setValue(last.to);
  }
}

function startTime() {
  const now = pragueNow();
  if (S.when === 'now') return now;
  const d = $('#date-input').value, t = $('#time-input').value;
  if (!d) return now;
  const [h, m] = (t || '00:00').split(':').map(Number);
  return { day: isoToDay(d), sec: h * 3600 + m * 60 };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function runSearch() {
  formMessage('');
  // nedokončený zápis: zkus první návrh
  for (const key of ['from', 'to']) {
    const v = $(`#${key}-input`).value.trim();
    if (!S[key] && v) { const [first] = suggest(S.index, v, { usage: store.usage(), loc: S.loc, limit: 1 }); if (first) $(`[data-field="${key}"]`).setValue(first.place); }
  }
  if (!S.from || !S.to) return formMessage('Vyber zastávku odkud i kam.');
  if (S.from === S.to) return formMessage('Odkud a kam jsou stejné. Vyber dvě různé zastávky.');

  const btn = $('.go');
  btn.disabled = true; btn.lastChild.textContent = 'Hledám…';
  await tick();
  try {
    store.recordUsage(S.from); store.recordUsage(S.to); store.saveTrip(S.from, S.to);
    renderTrips();
    const start = startTime();
    const arrive = S.arrive && S.when === 'custom';
    const t0 = performance.now();
    const js = arrive ? findArrivingBy(S.from, S.to, start) : S.planner.find(S.from, S.to, start, { count: 8, mode: S.mode });
    S.query = { from: S.from, to: S.to, mode: S.mode, start, arrive, label: whenLabel(start, arrive) };
    S.journeys = js; S.desc.clear(); S.expanded.clear(); S.noMoreEarlier = false;
    console.debug(`[hledání] ${js.length} spojení za ${Math.round(performance.now() - t0)} ms`);
    renderResults(true);
    if (navTop() !== 'results') { if (navStack.includes('results')) navBack(); else navPush('results'); }
    // podle příjezdu: nejlepší (nejpozdější odjezd, který ještě stihne) je poslední => ukázat ho
    requestAnimationFrame(() => {
      const sc = $('#res-scroll');
      sc.scrollTo({ top: arrive ? sc.scrollHeight : 0 });
    });
  } catch (e) {
    console.error(e);
    formMessage('Hledání selhalo. Zkus to prosím znovu.');
  } finally {
    btn.disabled = false; btn.lastChild.textContent = 'Najít spojení';
  }
}

/**
 * Spojení s příjezdem nejpozději v deadline. Plánovač hledá jen dopředu: hledá se od okamžiku před cílovým časem
 * (okno 1,5 → 3 → 6 → 12 h, dokud nejsou aspoň 3 vyhovující) a vezmou se ta s nejpozdějším odjezdem.
 */
function findArrivingBy(from, to, deadline) {
  const now = pragueNow();
  const today = dayDiff(now.day, deadline.day) === 0;
  let best = [];
  for (const win of [90, 180, 360, 720]) {
    let sec = deadline.sec - win * 60;
    const clamped = today && deadline.sec > now.sec && sec < now.sec;   // do minulosti se nehledá
    if (clamped) sec = now.sec;
    const js = S.planner.find(from, to, { day: deadline.day, sec: Math.max(0, sec) }, { count: 16, mode: S.mode });
    const ok = arrivingBy(js, deadline.day, deadline.sec, dayDiff);
    if (ok.length > best.length) best = ok;
    if (ok.length >= 3 || clamped || sec <= 0) break;
  }
  return best.slice(-8);
}

/** Popisek zvoleného času: "dnes 18:30", u příjezdu "Příjezd do dnes 18:30". */
function whenLabel(start, arrive) {
  if (S.when === 'now') return 'Teď';
  const diff = dayDiff(pragueNow().day, start.day);
  const day = diff === 0 ? 'dnes' : diff === 1 ? 'zítra' : fmtDayShort(start.day);
  return `${arrive ? 'Příjezd do ' : ''}${day} ${hhmm(start.sec)}`;
}

async function loadMore(fn) {
  if (S.loadingMore || !S.query) return;
  S.loadingMore = true;
  await tick();
  try {
    const before = S.journeys.length;
    const next = fn();
    S.journeys = next;
    return next.length - before;
  } finally { S.loadingMore = false; }
}

async function loadLater(auto = false) {
  if (!S.query || S.loadingMore || S.query.arrive) return;   // podle příjezdu: pozdější by nedorazily včas
  const { from, to, mode } = S.query;
  const n = await loadMore(() => S.planner.moreLater(from, to, S.journeys, { mode }));
  if (n === 0 && !auto) $('#later').textContent = 'Další spoje už nejedou';
  if (n === 0) $('#more').hidden = true;
  renderResults();
}

async function loadEarlier() {
  if (!S.query) return;
  const { from, to, mode } = S.query;
  const n = await loadMore(() => S.planner.moreEarlier(from, to, S.journeys, { mode }));
  if (!n) { S.noMoreEarlier = true; $('#earlier').disabled = true; }
  renderResults();
}

// ───────────── výsledky ─────────────
function descOf(j) {
  let d = S.desc.get(j.key);
  if (!d) { d = describeJourney(S.tt, j); S.desc.set(j.key, d); }
  return d;
}

function relative(j) {
  const now = pragueNow();
  const secs = j.dep + dayDiff(now.day, j.day) * 86400 - now.sec;
  if (secs > 0) return `za ${fmtMinutes(Math.ceil(secs / 60))}`;
  if (secs > -60) return 'právě odjíždí';
  return `odjel před ${fmtMinutes(Math.floor(-secs / 60))}`;
}

function dayLabel(j) {
  const now = pragueNow();
  const diff = dayDiff(now.day, j.day);
  if (diff === 0) return '';
  const name = diff === 1 ? 'zítra' : DAY_NAMES[weekday(j.day)];
  return `${name} ${fmtDayShort(j.day)}`;
}

/**
 * Barva odjezdu podle druhu dopravy jako v appce (TripTable.category + barvy vozidel): autobus zelený, vlak modrý,
 * tramvaj fialová, metro v barvě linky. Jízdní řád druh nemá: vlak podle čísla, metro / tramvaj = DP hl. m. Prahy.
 */
function tripStyle(t) {
  if (t.isTrain) return { st: STYLES.TRAIN, ic: 'train' };
  if (/Prahy/.test(t.agency || '')) {
    const l = String(t.line).trim().toUpperCase();
    if (l === 'A' || l === 'B' || l === 'C') return { st: STYLES[`METRO_${l}`], ic: 'metro' };
    if ((parseInt(l, 10) || 999) < 100) return { st: STYLES.TRAM, ic: 'tram' };
  }
  if (isDpmulTrolleybus(t.line, t.agency)) return { st: STYLES.TROLLEYBUS, ic: 'bus' };
  return { st: STYLES.BUS, ic: 'bus' };
}

/** Odstín barvy vozu pro trasu: ve světlém motivu tmavší, v tmavém světlejší (autobus zelená, vlak modrá…). */
const routeOf = (st) => (resolvedTheme() === 'dark' ? st.routeDark : st.route);
const routeColor = (t) => routeOf(tripStyle(t).st);

function depBadgeHtml(t, big = false) {
  const { st, ic } = tripStyle(t);
  return `<span class="badge${big ? ' big' : ''}" style="background:${st.color};color:${st.darkText ? '#000' : '#fff'}">${icon(ic)}${esc(t.line)}</span>`;
}

function badgeHtml(line, isTrain) {
  return `<span class="badge${isTrain ? ' train' : ''}">${isTrain ? icon('train') : ''}${esc(line)}</span>`;
}

/** Je spojení dnešní (živá data mají smysl)? */
const isToday = (d) => dayDiff(pragueNow().day, d.day) === 0;
/** Teď v sekundách od půlnoci dne spojení (spoj zítra: záporné). */
const nowRel = (d) => { const n = pragueNow(); return n.sec - dayDiff(n.day, d.day) * 86400; };

/** Živé vozy jízd spojení: index úseku → vůz (jen dnes; jinak by se párovaly se včerejšími / zítřejšími). */
function liveByLeg(d) {
  const out = new Map();
  if (!isToday(d) || !S.live) return out;
  d.legs.forEach((l, i) => {
    if (l.kind === 'walk') return;
    const v = S.live.forTrip(l.tid);
    if (v && v.state !== 255) out.set(i, v);
  });
  return out;
}
const delaysOf = (live) => new Map([...live].map(([i, v]) => [i, v.delay || 0]));

const MODE_OF_TRIP = (t) => tripStyle(t).ic;
const KIND_LABEL = { bus: 'Bus', tram: 'Tramvaj', metro: 'Metro', train: 'Vlak' };

function delayTag(delay, { live = true } = {}) {
  if (delay == null) return '';
  const cls = delay > CONFIG.LATE_MIN ? ' late' : delay >= 1 ? ' warn' : ' ok';
  const txt = delay >= 1 ? `Zpoždění ${delay}${NBSP}min` : delay < 0 ? `Napřed ${-delay}${NBSP}min` : 'Včas';
  return `<span class="tag nowrap${cls}">${live ? icon('live') : ''}${live && delay < 1 && delay >= 0 ? 'Živě · včas' : txt}</span>`;
}

/** Přestup "A → B": šipka jako ikona (textová šipka v různých písmech vypadá špatně). */
const atHtml = (at) => esc(at).replace(' → ', ` ${icon('arrow-right', 'inline')} `);

function riskChip(s) {
  if (!s || s.risk === 'none') return '';
  return s.risk === 'risk'
    ? `<span class="tag late nowrap">${icon('alert')}Přestup ohrožen · zpoždění ${s.delayMin}${NBSP}min</span>`
    : `<span class="tag warn nowrap">${icon('alert')}Těsný přestup · rezerva ${Math.max(0, s.marginMin)}${NBSP}min</span>`;
}

function journeyHtml(j, i) {
  const d = descOf(j);
  const dl = dayLabel(d);
  const live = liveByLeg(d);
  const delays = delaysOf(live);
  const now = nowRel(d);
  const rides = rideIndices(d.legs);
  // linky: ťuknutí = detail té jízdy
  const lines = rides.map((li) => {
    const t = S.tt.trips[d.legs[li].tid];
    return `<button type="button" class="badge-btn" data-act="leg" data-leg="${li}" aria-label="Linka ${esc(t.line)}, podrobnosti jízdy">${badgeHtml(t.line, t.isTrain)}</button>`;
  }).join(`<span class="sep">${icon('arrow-right')}</span>`);
  const firstDelay = live.get(rides[0])?.delay;
  // přestupy zůstávají; směr, dopravce a počet zastávek jsou v detailu, "přímý spoj" je zřejmý z jedné linky
  const trans = d.transferList.map((tr, k) => {
    const st = transferStatus(d.legs, k, delays, now);
    return `<div class="transfer">Přestup: <strong>${atHtml(tr.at)}</strong> · čekání ${tr.waitMin}${NBSP}min${tr.walkMin ? ` · pěšky ${tr.walkMin}${NBSP}min` : ''}${riskChip(st) ? `<div class="risk">${riskChip(st)}</div>` : ''}</div>`;
  }).join('');
  return `<li class="journey" data-i="${i}" data-key="${esc(j.key)}">
    <div class="j-top">
      <div class="j-main">
        <div class="j-times">${hhmm(d.dep)} ${icon('arrow-right')} ${hhmm(d.arr)}</div>
        <div class="j-rel"><span>${esc(dl ? `${dl} · ` : '')}${esc(relative(d))}</span>${firstDelay != null && firstDelay >= 1 ? delayTag(firstDelay, { live: false }) : ''}</div>
        <div class="j-dur">${fmtMinutes(d.durationMin)} ${d.transfers ? 'celkem' : 'jízdy'}</div>
      </div>
      <div class="j-actions">
        <button type="button" class="plain-icon" data-act="detail" aria-label="Zastávky a podrobnosti" title="Zastávky a podrobnosti">${icon('info')}</button>
        <button type="button" class="pill-btn" data-act="map">${icon('map')}Mapa</button>
      </div>
    </div>
    <div class="j-lines">${d.boardWalkMin ? `<span class="tag">${icon('walk')} pěšky ${d.boardWalkMin}${NBSP}min</span>` : ''}${lines}</div>
    ${trans}
  </li>`;
}

function renderResults(fresh = false) {
  const res = $('#results'), empty = $('#empty');
  if (!S.query) { res.hidden = true; empty.hidden = true; return; }
  const q = S.query;
  $('#res-title').innerHTML = `${esc(stopLabel(prettyName(q.from)))} ${icon('arrow-right', 'inline')} ${esc(stopLabel(prettyName(q.to)))}`;
  $('#res-sub').textContent = `${q.label}${S.journeys.length ? ` · ${S.journeys.length} nalezeno` : ''}`;
  $('#earlier').disabled = S.noMoreEarlier;
  if (!S.journeys.length) {
    res.hidden = true; empty.hidden = false;
    empty.innerHTML = q.arrive
      ? '<strong>Do zvoleného času žádné spojení nepřijede</strong>Zkus pozdější čas příjezdu.'
      : `<strong>Spojení jsme nenašli</strong>${q.mode && q.mode.size ? 'Zkus zvolit všechny druhy dopravy, nebo ' : 'Zkus '}posunout čas odjezdu${q.start.sec > 3600 * 20 ? ' (nebo vybrat zítřejší den)' : ''}.`;
    return;
  }
  empty.hidden = true; res.hidden = false;
  const list = $('#journeys');
  const html = S.journeys.map(journeyHtml).join('');
  if (html !== S.lastHtml) {   // při obnovení poloh se DOM nepřekresluje, pokud se nic nezměnilo
    S.lastHtml = html;
    list.classList.toggle('fresh', fresh);
    list.innerHTML = html;
  }
  if (fresh) { $('#more').hidden = !!q.arrive; $('#later').textContent = 'Zobrazit další spoje'; }
}

$('#journeys').addEventListener('click', (e) => {
  const li = e.target.closest('.journey');
  if (!li) return;
  const d = descOf(S.journeys[+li.dataset.i]);
  const btn = e.target.closest('[data-act]');
  const act = btn?.dataset.act || 'detail';   // ťuknutí kamkoliv na kartu = detail spojení
  if (btn) btn.animate([{ transform: 'scale(.92)' }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
  if (act === 'map') showJourneyOnMapSmart(d);
  else if (act === 'leg') openLeg(d, +btn.dataset.leg);
  else openDetail(d);
});

// ───────────── detail spojení ─────────────
/** Zastávka jízdy: název (vlak celý, jinak bez obce), obec, čas; projetá ztlumená, se zpožděním i očekávaný čas. */
function stopRowHtml(stopId, time, { terminal, passed, delaySec, train, color }) {
  const name = prettyName(S.tt.stops[stopId].name);
  const { stop, city } = splitStopName(name);
  const shown = train ? name : stop || name;
  const delayed = delaySec && !passed;
  const timeHtml = delayed
    ? `<s>${hhmm(time)}</s><b class="${delaySec > 180 ? 'late' : 'warn'}">${hhmm(time + delaySec)}</b>`
    : `<span>${hhmm(time)}</span>`;
  const a11y = delayed ? `${shown}, podle jízdního řádu ${hhmm(time)}, očekávaně ${hhmm(time + delaySec)}` : `${shown}, ${hhmm(time)}`;
  return `<li class="tl-stop${terminal ? ' term' : ''}${passed ? ' passed' : ''}" style="--c:${color}" aria-label="${esc(a11y)}${passed ? ', projeto' : ''}">
    <span class="tl-time" aria-hidden="true">${timeHtml}</span><span class="tl-name" aria-hidden="true">${esc(shown)}${terminal && !train && city ? `<small>${esc(city)}</small>` : ''}</span></li>`;
}

function rideCardHtml(d, li, v, now) {
  const l = d.legs[li], t = S.tt.trips[l.tid];
  const { st, ic } = tripStyle(t);
  const color = routeOf(st);
  const delaySec = (v?.delay || 0) * 60;
  const passed = (x) => now > x + delaySec;
  const first = l.stops[0], last = l.stops[l.stops.length - 1], mids = l.stops.slice(1, -1);
  const rideMin = Math.round((last.arr - first.dep) / 60);
  const train = !!t.isTrain;
  const open = !S.collapsed.has(li);
  const chips = [
    v ? delayTag(v.delay || 0) : '',
    v?.id ? `<span class="tag soft">Vůz ${esc(v.id)}</span>` : '',
    t.wheel > 0 || v?.low ? `<span class="tag soft">${icon('access')}Bezbariérový</span>` : '',
    v?.ac ? `<span class="tag soft">${icon('snow')}Klimatizace</span>` : '',
  ].join('');
  const sub = [train && t.num ? `Vlak č. ${esc(t.num)}` : '', esc(t.agency || '')].filter(Boolean).join(' · ');
  return `<article class="ride card">
    <header class="ride-head">
      <button type="button" class="badge-btn" data-act="leg" data-leg="${li}" aria-label="${KIND_LABEL[ic] || 'Linka'} ${esc(t.line)}, podrobnosti jízdy">${depBadgeHtml(t, true)}</button>
      <div><strong>Směr ${esc(train ? prettyName(t.head) : stopLabel(prettyName(t.head)))}</strong>${sub ? `<small>${sub}</small>` : ''}</div>
    </header>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    <ol class="tl">
      ${stopRowHtml(first.stop, first.dep, { terminal: true, passed: passed(first.dep), delaySec, train, color })}
      ${mids.length ? `<li class="tl-toggle" style="--c:${color}"><button type="button" data-act="mids" data-leg="${li}" aria-expanded="${open}">${pluralStops(mids.length).replace(/zastáv/, 'mezizastáv')} · ${rideMin}${NBSP}min ${icon('chevron')}</button></li>` : ''}
      ${open ? mids.map((m) => stopRowHtml(m.stop, m.arr ?? m.dep, { passed: passed(m.dep ?? m.arr), delaySec, train, color })).join('') : ''}
      ${stopRowHtml(last.stop, last.arr, { terminal: true, passed: passed(last.arr), delaySec, train, color })}
    </ol>
  </article>`;
}

function detailHtml(d) {
  const live = liveByLeg(d);
  const delays = delaysOf(live);
  const now = nowRel(d);
  const rides = rideIndices(d.legs);
  const dl = dayLabel(d);
  const worst = live.size ? Math.max(...[...live.values()].map((v) => v.delay || 0)) : null;
  const badges = rides.map((li) => {
    const t = S.tt.trips[d.legs[li].tid];
    return `<button type="button" class="badge-btn" data-act="leg" data-leg="${li}" aria-label="${KIND_LABEL[tripStyle(t).ic] || 'Linka'} ${esc(t.line)}, podrobnosti jízdy">${depBadgeHtml(t)}</button>`;
  }).join(`<span class="sep">${icon('arrow-right')}</span>`);
  const parts = [`<section class="card det-sum">
    <div class="j-times big">${hhmm(d.dep)} ${icon('arrow-right')} ${hhmm(d.arr)}</div>
    <div class="j-rel"><span>${esc(dl ? `${dl} · ` : '')}${esc(relative(d))}</span></div>
    <div class="j-dur">${fmtMinutes(d.durationMin)} jízdy · ${pluralStops(d.stopsCount)} · ${d.transfers ? pluralTransfers(d.transfers) : 'bez přestupu'}</div>
    <div class="j-lines">${badges}</div>
    ${worst != null ? `<div class="chips">${delayTag(worst)}</div>` : ''}
    <button type="button" class="btn btn-primary wide" data-act="map">${icon('map')}Zobrazit na mapě</button>
  </section>`];
  let k = 0;
  d.legs.forEach((l, li) => {
    if (l.kind === 'walk') {
      const m = Math.max(1, Math.ceil((l.arr - l.dep) / 60));
      const a = S.tt.stops[l.from], b = S.tt.stops[l.to];
      const dist = a?.hasCoords && b?.hasCoords ? ` · ${fmtDist(distanceM(a.lat, a.lng, b.lat, b.lng))}` : '';
      parts.push(`<div class="walk-row"><span class="walk-ico">${icon('walk')}</span><span><strong>${m}${NBSP}min pěšky${dist}</strong><small>na zastávku ${esc(stopLabel(prettyName(b?.name || '')))}</small></span></div>`);
      return;
    }
    if (k > 0) {
      const tr = d.transferList[k - 1];
      const st = transferStatus(d.legs, k - 1, delays, now);
      parts.push(`<div class="transfer-row"><span class="tag">${icon('swap')}Přestup · čekání ${tr.waitMin}${NBSP}min</span>${riskChip(st)}</div>`);
    }
    parts.push(rideCardHtml(d, li, live.get(li), now));
    k++;
  });
  return parts.join('');
}

function openDetail(d) {
  S.detail = d;
  S.collapsed.clear();
  renderDetail();
  $('#det-scroll').scrollTop = 0;
  navPush('detail');
}

function renderDetail() {
  const d = S.detail;
  if (!d) return;
  const first = S.tt.stops[d.rides[0].from], last = S.tt.stops[d.rides[d.rides.length - 1].to];
  $('#det-sub').innerHTML = `${esc(stopLabel(prettyName(first.name)))} ${icon('arrow-right', 'inline')} ${esc(stopLabel(prettyName(last.name)))}`;
  const sc = $('#det-scroll'), top = sc.scrollTop;
  const html = detailHtml(d);
  if (html !== S.detailHtml) { S.detailHtml = html; sc.innerHTML = html; sc.scrollTop = top; }
}

$('#det-scroll').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !S.detail) return;
  const act = btn.dataset.act;
  if (act === 'map') showJourneyOnMapSmart(S.detail);
  else if (act === 'leg') openLeg(S.detail, +btn.dataset.leg);
  else if (act === 'mids') {
    const li = +btn.dataset.leg;
    if (S.collapsed.has(li)) S.collapsed.delete(li); else S.collapsed.add(li);
    renderDetail();
  }
});

// ───────────── detail jedné jízdy (ťuknutí na číslo linky) ─────────────
function openLeg(d, li) {
  const l = d.legs[li], t = S.tt.trips[l.tid];
  const rides = rideIndices(d.legs);
  const v = liveByLeg(d).get(li);
  const { st, ic } = tripStyle(t);
  const train = !!t.isTrain;
  const first = l.stops[0], last = l.stops[l.stops.length - 1];
  const delaySec = (v?.delay || 0) * 60, now = nowRel(d);
  const chips = [
    v ? delayTag(v.delay || 0) : '',
    v?.id ? `<span class="tag soft">Vůz ${esc(v.id)}</span>` : '',
    t.wheel > 0 || v?.low ? `<span class="tag soft">${icon('access')}Bezbariérový</span>` : '',
    v?.ac ? `<span class="tag soft">${icon('snow')}Klimatizace</span>` : '',
  ].join('');
  const sub = [train && t.num ? `Vlak č. ${esc(t.num)}` : '', esc(t.agency || '')].filter(Boolean).join(' · ');
  const color = routeOf(st);
  $('#leg-body').innerHTML = `
    <p class="leg-kicker" id="leg-title">${rides.length > 1 ? `${rides.indexOf(li) + 1}. spoj z ${rides.length}` : 'Informace o spoji'}</p>
    <div class="ride-head">${depBadgeHtml(t, true)}<div><strong>Směr ${esc(train ? prettyName(t.head) : stopLabel(prettyName(t.head)))}</strong>${sub ? `<small>${sub}</small>` : ''}</div></div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    <ol class="tl compact">
      ${stopRowHtml(first.stop, first.dep, { terminal: true, passed: now > first.dep + delaySec, delaySec, train, color })}
      <li class="tl-toggle" style="--c:${color}"><span>${pluralStops(Math.max(0, l.stops.length - 2)).replace(/zastáv/, 'mezizastáv')} · ${Math.round((last.arr - first.dep) / 60)}${NBSP}min</span></li>
      ${stopRowHtml(last.stop, last.arr, { terminal: true, passed: now > last.arr + delaySec, delaySec, train, color })}
    </ol>
    <button type="button" class="btn btn-primary wide" id="leg-map">${icon('map')}${rides.length > 1 ? `Zobrazit linku ${esc(t.line)} na mapě` : 'Zobrazit na mapě'}</button>`;
  $('#leg-map').onclick = () => { animateDialogClose($('#leg-dlg')); showLegOnMap(d, li); };
  showDialog($('#leg-dlg'));
}

// ───────────── mapa u spojení: aktuální jízda ─────────────
/** Jízda li spojení na mapě; první jízda = celé spojení (s chůzí k zastávce). */
function showLegOnMap(d, li) {
  const rides = rideIndices(d.legs);
  if (li === rides[0]) return showJourneyOnMap(d);
  const l = d.legs[li];
  showJourneyOnMap(describeJourney(S.tt, { ...d, key: `${d.key}#${li}`, legs: [l], dep: l.dep, arr: l.arr }));
}

/** Tlačítka Mapa u spojení: ukáže jízdu, která je právě aktuální (po odjezdu první před 3 min + zpoždění už další). */
function showJourneyOnMapSmart(d) {
  const delays = delaysOf(liveByLeg(d));
  showLegOnMap(d, activeLegIndex(d.legs, nowRel(d), (i) => delays.get(i) || 0));
}

// ───────────── oblíbená a nedávná spojení ─────────────
function tripRowHtml(x, pinned) {
  const from = stopLabel(prettyName(x.from)), to = stopLabel(prettyName(x.to));
  return `<li class="trip-row" data-from="${esc(x.from)}" data-to="${esc(x.to)}" data-pin="${pinned ? 1 : 0}">
    <div class="trip-bg" aria-hidden="true">${icon('trash')}</div>
    <div class="trip-fg">
      <button type="button" class="trip-main" data-act="go" aria-label="Hledat ${esc(from)} – ${esc(to)}">
        <span class="trip-ico">${icon(pinned ? 'star-fill' : 'history')}</span>
        <span class="trip-txt"><strong>${esc(from)}</strong><small>${icon('arrow-right', 'inline')}${esc(to)}</small></span>
      </button>
      <button type="button" class="mini" data-act="rev" aria-label="Hledat opačným směrem" title="Opačný směr">${icon('swap')}</button>
      <button type="button" class="mini" data-act="pin" aria-label="${pinned ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}" title="${pinned ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}">${icon(pinned ? 'star-fill' : 'star')}</button>
      <button type="button" class="mini del" data-act="del" aria-label="Odebrat z historie" title="Odebrat z historie">${icon('x')}</button>
    </div>
  </li>`;
}

function renderTrips() {
  const ok = (x) => S.tt?.places.has(x.from) && S.tt.places.has(x.to);
  const fav = store.pinnedTrips().filter(ok), rec = store.recentTrips(15).filter(ok);
  const sec = (title, list, pinned) => (list.length
    ? `<h2 class="sec-title">${title}</h2><ul class="trip-list">${list.map((x) => tripRowHtml(x, pinned)).join('')}</ul>` : '');
  $('#trips').innerHTML = sec('Oblíbená spojení', fav, true) + sec('Nedávná hledání', rec, false);
}

function searchTrip(from, to) {
  if (!S.tt.places.has(from) || !S.tt.places.has(to)) return toast('Zastávka z historie už v jízdním řádu není.');
  $('[data-field="from"]').setValue(from); $('[data-field="to"]').setValue(to);
  runSearch();
}

/** Odebrání (křížek nebo přejetí): hned zmizí, dole jde vrátit "Zpět". */
function removeTrip(from, to) {
  const removed = store.removeTrip(from, to);
  if (!removed) return;
  renderTrips();
  snack(`Odebráno: ${stopLabel(prettyName(from))} – ${stopLabel(prettyName(to))}`, 'Zpět', () => { store.restoreTrip(removed); renderTrips(); });
}

$('#trips').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]'), row = e.target.closest('.trip-row');
  if (!btn || !row || row._swiped) return;
  const { from, to } = row.dataset, pinned = row.dataset.pin === '1';
  const act = btn.dataset.act;
  if (act === 'go') searchTrip(from, to);
  else if (act === 'rev') searchTrip(to, from);
  else if (act === 'pin') { store.setPinned(from, to, !pinned); renderTrips(); }
  else if (act === 'del') removeTrip(from, to);
});

// přejetí řádku do strany = odebrat; až po přetažení přes polovinu šířky (ne omylem při posouvání seznamu)
(function setupTripSwipe() {
  const root = $('#trips');
  let row = null, fg = null, x0 = 0, y0 = 0, dx = 0, dragging = false;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;   // myší je křížek
    row = e.target.closest('.trip-row'); if (!row) return;
    fg = row.querySelector('.trip-fg'); x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false; row._swiped = false;
  });
  root.addEventListener('pointermove', (e) => {
    if (!row) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.5) { dragging = true; row.classList.add('swiping'); try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      else if (Math.abs(ddy) > 10) { row = null; return; } else return;
    }
    dx = ddx;
    fg.style.transform = `translateX(${dx}px)`;
    row.classList.toggle('armed', Math.abs(dx) > row.offsetWidth * 0.5);
  });
  const end = () => {
    if (!row) return;
    const r = row, f = fg;
    row = null;
    if (!dragging) return;
    r._swiped = true; setTimeout(() => { r._swiped = false; }, 60);
    r.classList.remove('swiping', 'armed');
    if (Math.abs(dx) > r.offsetWidth * 0.5) {
      f.animate([{ transform: `translateX(${dx}px)` }, { transform: `translateX(${Math.sign(dx) * r.offsetWidth}px)` }], { duration: reduceMotion() ? 0 : 160, easing: EASE_IN, fill: 'forwards' })
        .finished.then(() => removeTrip(r.dataset.from, r.dataset.to)).catch(() => {});
    } else {
      f.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: reduceMotion() ? 0 : 200, easing: EASE_OUT });
      f.style.transform = '';
    }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
})();

/** Oznámení s akcí ("Odebráno · Zpět"); samo zmizí. */
let snackTimer;
function snack(text, action, onAction, ms = 6000) {
  const el = $('#snack');
  el.querySelector('span').textContent = text;
  const b = el.querySelector('button');
  b.textContent = action;
  b.onclick = () => { clearTimeout(snackTimer); hideEl(el, { y: 12 }); onAction(); };
  showEl(el);
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => hideEl(el, { y: 12 }), ms);
}

// ───────────── odjezdy z nejbližší zastávky (hlavní obrazovka) ─────────────
/** Nejbližší zastávka pěšky (jako "Moje poloha") a její nejbližší odjezdy ze všech nástupišť. */
async function refreshNearby({ relocate = false } = {}) {
  if (!S.loc || !S.stopIdx) return;
  let nb = S.nearby;
  if (!nb || relocate || nb.loc !== S.loc) {
    const cands = nearestPlaces(S.index, S.loc.lat, S.loc.lng, 6).filter((c) => c.dist <= 1500);
    if (!cands.length) { S.nearby = null; renderNearby(); return; }
    const walk = await footDistances([S.loc.lat, S.loc.lng], cands.map((c) => [c.lat, c.lng]));
    // pěšky (zastávka za řekou bývá vzdušnou čarou blízko, ale cesta dlouhá); bez pěší trasy vzdušnou čarou
    let best = cands[0], distM = cands[0].dist;
    if (walk?.some((w) => w != null)) {
      distM = Infinity;
      cands.forEach((c, i) => { if (walk[i] != null && walk[i] < distM) { distM = walk[i]; best = c; } });
    }
    if (distM > 900) { S.nearby = null; renderNearby(); return; }
    const ids = new Set(S.tt.places.get(best.place) || []);
    const platforms = S.stopIdx.stops.filter((p) => p.ttStops.some((id) => ids.has(id)));
    nb = { loc: S.loc, place: best.place, distM, platforms };
  }
  const now = pragueNow(), seen = new Set();
  nb.deps = nb.platforms.flatMap((p) => S.stopIdx.departures(p, now, 2).map((d) => ({ ...d, platform: p })))
    .filter((d) => { const k = `${d.tid}|${d.dep}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.dep - b.dep).slice(0, 4);
  S.nearby = nb;
  renderNearby();
}

function renderNearby() {
  const el = $('#nearby'), nb = S.nearby;
  if (!nb) { el.hidden = true; return; }
  const now = pragueNow();
  const rows = nb.deps.map((d, i) => {
    const min = Math.round((d.dep - now.sec) / 60);
    return `<li><button type="button" class="dep-row" data-i="${i}">${depBadgeHtml(S.tt.trips[d.tid])}<span class="dep-head">směr ${esc(d.isTrain ? d.head : stopLabel(d.head))}</span><span class="dep-time"><strong>${hhmm(d.dep % 86400)}</strong><small>${min <= 0 ? 'teď' : `za ${min}${NBSP}min`}</small></span></button></li>`;
  }).join('');
  el.innerHTML = `<header class="nearby-head">${icon('pin')}<div><small id="nearby-title">Odjezdy z nejbližší zastávky · ${esc(fmtDist(nb.distM))}</small><strong>${esc(stopLabel(prettyName(nb.place)))}</strong></div>
      <button type="button" class="link-btn" data-act="stop">Na mapě</button></header>
    ${rows ? `<ol class="stop-deps">${rows}</ol>` : '<p class="age">V příštích 2 hodinách odsud nic nejede.</p>'}`;
  el.hidden = false;
}

$('#nearby').addEventListener('click', (e) => {
  const nb = S.nearby;
  if (!nb) return;
  if (e.target.closest('[data-act="stop"]')) {
    // panel zastávky + mapa na zastávce (v pruhu mezi kartou nahoře a panelem)
    const p = nb.platforms[0];
    if (!p) return;
    goMap();
    openStop(p);
    // až je panel vykreslený (jeho výška rozhoduje, kam zastávku posunout)
    requestAnimationFrame(() => requestAnimationFrame(() => S.map.setView([p.lat, p.lng], 17, { animate: true, offset: [0, -stopSheetShift()] })));
    return;
  }
  const row = e.target.closest('.dep-row');
  if (row) showDeparture(nb.deps[+row.dataset.i]);
});

/** O kolik px nad střed mapy dát zastávku, aby byla v pruhu mezi stavovou kartou a panelem odjezdů dole. */
function stopSheetShift() {
  const h = $('#mapwrap').clientHeight;
  if (matchMedia('(min-width: 960px)').matches) return 0;   // široký displej: panel je vlevo, střed zůstává volný
  // skutečný horní okraj panelu (offsetTop nebere animaci vyjetí v potaz), jinak odhad
  const sh = $('#sheet');
  const sheetTop = !sh.hidden && sh.offsetHeight ? sh.offsetTop : h * 0.4;
  return Math.max(0, h / 2 - (bannerBottom() + sheetTop) / 2);
}

// spodní okraj stavové karty pro CSS (panel vozidla / odjezdů pod ni nezajede); karta mění výšku podle zdrojů
new ResizeObserver(() => $('#mapwrap').style.setProperty('--banner-bottom', `${Math.round(bannerBottom())}px`)).observe($('#status'));

/** Spodní okraj stavové karty "Mapa vozidel" nahoře (px v mapě): co je pod ní, není vidět. */
function bannerBottom() {
  const s = $('#status'), w = $('#mapwrap');
  if (!s || s.hidden) return 0;
  return Math.max(0, s.getBoundingClientRect().bottom - w.getBoundingClientRect().top);
}

// ───────────── trasy na mapě ─────────────
let overlayGen = 0; // zahodí pozdě doražené trasy, když mezitím došlo ke změně na mapě
let flashTimer;
let activeLiveRoute = null;
function clearOverlay() {
  overlayGen++;
  activeLiveRoute = null;
  S.overlay.lines.forEach((l) => l.remove()); S.overlay.markers.forEach((m) => m.remove());
  S.overlay = { lines: [], markers: [] };
  hideEl($('#clear-route'), { y: -8 });
  hideEl($('#clear-route-icon'), { y: 8, scale: .8 });
}

function showRouteControls() {
  showEl($('#clear-route'));
  showEl($('#clear-route-icon'));
}

function dot(lat, lng, cls, label, color = null) {
  const el = document.createElement('div');
  el.className = cls;
  if (color) el.style.borderColor = color;   // zastávky na trase v barvě druhu dopravy
  const m = S.map.addMarker({ lat, lng, el, z: 5 });
  S.overlay.markers.push(m);
  if (label) {
    const l = document.createElement('div'); l.className = 'stop-label'; l.textContent = label;
    S.overlay.markers.push(S.map.addMarker({ lat, lng, el: l, z: 6 }));
  }
}

function pin(lat, lng, to, label) {
  const el = document.createElement('div');
  el.className = `endpoint${to ? ' to' : ''}`;
  el.innerHTML = icon(to ? 'map' : 'pin');
  S.overlay.markers.push(S.map.addMarker({ lat, lng, el, z: 8 }));
  const l = document.createElement('div'); l.className = 'stop-label'; l.textContent = label;
  S.overlay.markers.push(S.map.addMarker({ lat, lng, el: l, z: 7 }));
}

function showJourneyOnMap(d) {
  clearOverlay(); closeSheet();
  const tt = S.tt;
  const allPts = [];
  const sp = (id) => tt.stops[id];
  d.legs.forEach((l) => {
    if (l.kind === 'walk') {
      const a = sp(l.from), b = sp(l.to);
      if (a.hasCoords && b.hasCoords) {
        const wl = S.map.addPolyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#6a829b', width: 4, dash: '2 8', casing: null });
        S.overlay.lines.push(wl);
        // pěší přesun po chodnících místo rovné čáry, jakmile ho pěší OSRM vrátí
        const gen = overlayGen;
        footRoute([a.lat, a.lng], [b.lat, b.lng]).then((r) => { if (r && gen === overlayGen) wl.setPoints(r.pts); });
      }
      return;
    }
    const t = tt.trips[l.tid];
    // zastávky na nástupištích (strana silnice podle směru jízdy), stejně jako ikony zastávek na mapě
    const lp = legPoints(l);
    const line = lp.filter(Boolean).map((p) => [p.lat, p.lng]);
    const pl = S.map.addPolyline(line, { color: routeColor(t), width: 10, arrows: true });
    S.overlay.lines.push(pl);
    // přesná trasa po silnici/trati nahradí rovnou čáru, jakmile se načte
    const gen = overlayGen;
    legRoute(S.shapes, tt, l.tid, l.stops.map((x) => x.stop))
      .then((r) => r || (t.isTrain ? null : osrmRoute(line)))
      .then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
    lp.slice(1, -1).forEach((p) => { if (p) dot(p.lat, p.lng, 'stopdot mid', null, routeColor(t)); });
    allPts.push(...line);
  });
  // přestupy, začátek a konec (na nástupišti své jízdy)
  const rideLegs = d.legs.filter((l) => l.kind !== 'walk');
  const at = (l, idx) => legPoints(l).at(idx);
  rideLegs.slice(0, -1).forEach((l) => { const p = at(l, -1), s = sp(l.stops.at(-1).stop); if (p) dot(p.lat, p.lng, 'stopdot', stopLabel(prettyName(s.name)), routeColor(tt.trips[l.tid])); });
  const first = sp(d.rides[0].from), last = sp(d.rides[d.rides.length - 1].to);
  const fp = rideLegs.length ? at(rideLegs[0], 0) : null, lpEnd = rideLegs.length ? at(rideLegs.at(-1), -1) : null;
  if (fp) pin(fp.lat, fp.lng, false, stopLabel(prettyName(first.name)));
  if (lpEnd) pin(lpEnd.lat, lpEnd.lng, true, stopLabel(prettyName(last.name)));
  showRouteControls();
  goMap();
  activeLiveRoute = { d, routePts: allPts, key: null };
  focusLive(d, allPts);
}

/** Polohy zastávek jízdy na nástupištích (pole zarovnané s l.stops, null = bez souřadnic). */
function legPoints(l) {
  const ids = l.stops.map((x) => x.stop);
  if (S.stopIdx) return S.stopIdx.platformPoints(ids);
  return ids.map((id) => { const s = S.tt.stops[id]; return s.hasCoords ? { id, lat: s.lat, lng: s.lng } : null; });
}

/**
 * Jede-li spoj (první jízda d) právě živě, zvýrazní se. Vůz na trase => přiblížení na něj; vůz k trase teprve
 * přijíždí (spoj nevyjel) => výřez s trasou i vozem; bez vozu celá trasa. Vše pod stavovou kartou nahoře.
 */
const VEHICLE_ON_ROUTE_M = 350;
function focusLive(d, routePts = []) {
  // vůz spoje stejně jako v appce: spárovaný se spojem (i DPMÚL podle polohy), jinak nejbližší vůz linky před nástupem
  const live = S.live.vehicleForJourney?.(d)?.v;
  const liveUid = live && S.vehicles.some((x) => vehicleUid(x) === vehicleUid(live)) ? vehicleUid(live) : null;
  if (activeLiveRoute?.d === d) activeLiveRoute.key = liveUid ? `${liveUid}|${live?.heading ?? 'none'}` : 'none';
  if (!liveUid) {
    // dřív tlačítko „nic neudělalo“: když vůz spoje teď nevidíme, aspoň to řekneme
    setTimeout(() => toast('Vůz tohoto spoje teď na mapě nevidíme, ukazuji jen trasu.'), 250);
    if (routePts.length >= 2) fitUnderBanner(routePts);
    return;
  }
  const p = S.vlayer.position(liveUid) || live;
  if (routePts.length >= 2 && distanceToRouteM(p.lat, p.lng, routePts) > VEHICLE_ON_ROUTE_M) {
    fitUnderBanner([...routePts, [p.lat, p.lng]]);
    focusUid(liveUid, { move: false });
  } else focusUid(liveUid);
}

function refreshActiveLiveRoute() {
  if (!activeLiveRoute) return;
  const live = S.live.vehicleForJourney?.(activeLiveRoute.d)?.v;
  const liveUid = live && S.vehicles.some((x) => vehicleUid(x) === vehicleUid(live)) ? vehicleUid(live) : null;
  const key = liveUid ? `${liveUid}|${live?.heading ?? 'none'}` : 'none';
  if (key !== activeLiveRoute.key) {
    focusLive(activeLiveRoute.d, activeLiveRoute.routePts);
  }
}

/** Výřez se všemi body ve viditelné části mapy (pod stavovou kartou nahoře). */
function fitUnderBanner(points) {
  requestAnimationFrame(() => S.map.fitBounds(points, { padding: { top: bannerBottom() + 32, bottom: 60 } }));
}

/** Zvýrazní vůz a přiblíží na něj (mobil: bliknutí, počítač: detail); move = false jen zvýrazní. */
function focusUid(liveUid, { move = true } = {}) {
  {
    setTimeout(() => {
      const mobile = matchMedia('(max-width: 640px)').matches;
      S.selected = mobile ? null : liveUid;
      S.flashUid = mobile ? liveUid : null;
      S.vlayer.setSelected(S.selected);
      S.vlayer.setFlash(S.flashUid);
      clearTimeout(flashTimer);
      if (mobile) {
        flashTimer = setTimeout(() => { S.flashUid = null; S.vlayer.setFlash(null); }, 2400);
      }
      if (mobile) hideEl($('#sheet'), { y: 60 });
      else renderSheet();
      const p = move && S.vlayer.position(liveUid);
      // vůz doprostřed viditelné části pod stavovou kartou (ne doprostřed celé mapy, kde by byl napůl schovaný)
      if (p) S.map.setView([p.lat, p.lng], Math.max(S.map.zoom, mobile ? 16 : 15), { animate: true, offset: [0, bannerBottom() / 2] });
    }, 60);
  }
}
$('#clear-route').addEventListener('click', clearOverlay);
$('#clear-route-icon').addEventListener('click', clearOverlay);

// ───────────── vozidla ─────────────
function updateVehicleMarkers() {
  S.vlayer?.setVehicles(S.vehicles);
}

async function pollVehicles() {
  try {
    const snap = await fetchVehicles();
    S.vehicles = dedupeByUid(snap.vehicles, vehicleUid);
    for (const v of S.vehicles) v.uid = vehicleUid(v);
    S.sourceNames = Object.fromEntries((snap.sources || []).map((s) => [s.id, s.name]));
    S.live.update(S.vehicles);
    updateVehicleMarkers();
    refreshActiveLiveRoute();
    $('#status-sub').textContent = `${S.vehicles.length} poloh`;
    const sourceStatus = $('#source-status');
    sourceStatus.replaceChildren(document.createTextNode('Zdroj: '));
    for (const [i, source] of sourceStatusParts(snap.sources).entries()) {
      if (i) sourceStatus.append(document.createTextNode(', '));
      const label = document.createElement('span');
      label.textContent = source.name;   // zastaralý zdroj jen červeně, bez textu
      if (source.stale) label.className = 'source-stale';
      sourceStatus.append(label);
    }
    sourceStatus.hidden = false;
    if (S.journeys.length) renderResults();
    if (S.detail) renderDetail();
    if (S.selected) renderSheet();
  } catch (e) {
    $('#status-sub').textContent = 'Polohy se nepodařilo načíst';
  } finally {
    setTimeout(pollVehicles, CONFIG.POLL_MS);
  }
}

function selectVehicle(uid) {
  S.stopSel = null;
  clearInterval(S.stopTimer);
  S.selected = uid;
  S.vlayer.setSelected(uid);
  renderSheet();
  const p = S.vlayer.position(uid);
  if (p) S.map.setView([p.lat, p.lng], Math.max(S.map.zoom, 14), { animate: true });
}

function closeSheet() {
  S.selected = null;
  S.stopSel = null;
  clearInterval(S.stopTimer);
  // detail zajede dolů (na mobilu přes celou výšku, na počítači jen kousek)
  const sh = $('#sheet');
  hideEl(sh, isMobile() ? { y: Math.max(120, sh.offsetHeight), duration: 220 } : { y: 16, duration: 170 });
  S.vlayer?.setSelected(null);
}
$('#sheet-close').addEventListener('click', () => closeSheet());

// ───────────── panel: stažení dolů prstem (jako bottom sheet v appce) ─────────────
// Panel jde za prstem; dost daleko nebo rychle dolů = plynule odjede a zavře se, jinak se vrátí. Táhne se,
// jen když je obsah panelu nahoře (jinak se normálně posouvá). Na širokém displeji je panel boční, netáhne se.
(function setupSheetDrag() {
  const sh = $('#sheet');
  const bottomSheet = () => !matchMedia('(min-width: 960px)').matches;
  let y0 = 0, x0 = 0, dy = 0, dragging = false, tracking = false, lastY = 0, lastT = 0, vel = 0, suppressClick = false;

  const start = (x, y) => {
    if (!bottomSheet() || sh.hidden || sh._hiding) return;
    tracking = true; dragging = false; y0 = lastY = y; x0 = x; dy = 0; vel = 0; lastT = performance.now();
  };
  const move = (x, y, e) => {
    if (!tracking) return;
    const d = y - y0;
    if (!dragging) {
      // začít táhnout jen směrem dolů, z horního okraje obsahu, a víc svisle než vodorovně
      if (d > 6 && sh.scrollTop <= 0 && Math.abs(d) > Math.abs(x - x0)) {
        dragging = true; y0 = y; sh.style.animation = 'none';
      } else if (Math.abs(d) > 6) { tracking = false; return; } else return;
    }
    e?.preventDefault();
    dy = Math.max(0, y - y0);
    const now = performance.now();
    if (now > lastT) vel = 0.7 * vel + 0.3 * ((y - lastY) / (now - lastT));
    lastY = y; lastT = now;
    sh.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
    const h = sh.offsetHeight;
    const out = dy > Math.max(90, h * 0.28) || vel > 0.55;
    const from = `translateY(${dy}px)`;
    if (out) {
      // dojezd rychlostí prstu (nejméně ~ plynulých 140 ms, nejvýš 260 ms)
      const dur = Math.min(260, Math.max(140, (h - dy) / Math.max(vel, 1.2)));
      const a = sh.animate([{ transform: from }, { transform: `translateY(${h + 24}px)` }], { duration: reduceMotion() ? 0 : dur, easing: 'cubic-bezier(.3, .7, .4, 1)', fill: 'forwards' });
      a.finished.then(() => {
        sh.hidden = true; sh.style.transform = ''; sh.style.animation = ''; a.cancel();
        closeSheet();
      }).catch(() => {});
    } else {
      const a = sh.animate([{ transform: from }, { transform: 'translateY(0)' }], { duration: reduceMotion() ? 0 : 220, easing: EASE_OUT });
      sh.style.transform = '';
      a.finished.then(() => { sh.style.animation = ''; }).catch(() => {});
    }
  };

  sh.addEventListener('touchstart', (e) => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  sh.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
  sh.addEventListener('touchend', end);
  sh.addEventListener('touchcancel', end);
  // myš (tablet s myší, vývoj): stejné chování
  sh.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    // myší se táhne panel, ne označuje text (výběr by obsah posunul a tažení by nezačalo)
    if (bottomSheet() && !e.target.closest('input, textarea, select')) e.preventDefault();
    start(e.clientX, e.clientY);
  });
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') move(e.clientX, e.clientY, e); });
  window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') end(); });
  // po stažení neklikat na řádek / tlačítko, nad kterým prst skončil
  sh.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
})();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.selected) closeSheet(); });

/** Název zdroje, ze kterého se právě používá poloha vozidla (např. "DPMÚL"). */
const vehicleSource = (v) => v.source || (v.train ? 'train' : 'duk');
function sourceLabel(v) {
  const id = vehicleSource(v); // zdroj, ze kterého se právě bere poloha (ne všechny sloučené)
  return S.sourceNames?.[id] || id;
}

function renderSheet() {
  const v = S.vehicles.find((x) => vehicleUid(x) === S.selected);
  const sheet = $('#sheet');
  if (!v) { showEl(sheet); $('#sheet-body').innerHTML = '<h3>Vozidlo</h3><p>Vozidlo už zdroj nedodává.</p>'; return; }
  let d = S.live.detail(v);
  // spoj mimo jízdní řád webu (Praha, celá ČR): dohledá ho server v celostátním jízdním řádu
  if (!d.trip) d = remoteDetail(v) || d;
  const late = v.delay > CONFIG.LATE_MIN;
  const delayText = v.delay >= 1 ? `Zpoždění ${v.delay}${NBSP}min` : 'Včas (0 min)';
  const st = STYLES[vehicleStyle(v)], mode = vehicleMode(v);
  const ring = lateMinutes(v) > 0 ? `box-shadow:0 0 0 4px ${LATE_COLOR};` : '';
  // bez čísla vozu (metro PID ho nehlásí): server vůz sleduje podle spoje, uid "gtrip:<GTFS spoj>"
  const tripRef = !v.id && String(v.uid).startsWith('gtrip:') ? String(v.uid).slice(6) : null;
  const idLine = v.id ? `ID vozidla: ${esc(vehicleSource(v) + ':' + v.id)}` : tripRef ? `Spoj: ${esc(tripRef)}` : 'ID vozidla: není dostupné';
  $('#sheet-body').innerHTML = `
    <h3>Informace o spoji</h3>
    <span class="big-badge" style="background:${st.color};color:${st.darkText ? '#000' : '#fff'};${ring}">${icon(MODE_ICON[kindOf(v)] || 'bus')}${esc(v.line)}</span>
    <p class="age" style="margin-top:.7rem">${idLine}</p>
    ${!v.id && mode === 'metro' ? '<p class="age">Metro nehlásí číslo soupravy, vůz se sleduje podle spoje.</p>' : ''}
    <p class="age">Zdroj polohy: ${esc(sourceLabel(v))}</p>
    <p class="age">${esc(ageLabel(v.ageSec))}</p>
    <dl>
      <div><dt>Zpoždění:</dt><dd><span class="tag${v.delay >= 1 ? (late ? ' late' : '') : ' ok'}">${delayText}</span></dd></div>
      ${d.next ? `<div><dt>Příští zastávka:</dt><dd>${esc(vehStop(d.next, v.train))}</dd></div>` : ''}
      ${d.terminal ? `<div><dt>Konečná zastávka:</dt><dd>${esc(vehStop(d.terminal, v.train))}</dd></div>` : v.dest ? `<div><dt>Směr:</dt><dd>${esc(vehStop(v.dest, v.train))}</dd></div>` : ''}
      ${v.agency || d.trip?.agency ? `<div><dt>Dopravce:</dt><dd>${esc(v.agency || d.trip.agency)}</dd></div>` : ''}
    </dl>
    <div class="chips">${v.ac ? `<span class="tag">${icon('snow')}Klimatizace</span>` : ''}${v.low ? `<span class="tag">${icon('access')}Bezbariérový</span>` : ''}</div>
    ${d.pending ? '<p class="age">Dohledávám spoj…</p>' : ''}
    ${d.trip ? '<button class="btn btn-primary" id="route-btn" type="button">Zobrazit trasu spoje</button>' : ''}`;
  showEl(sheet);
  $('#route-btn')?.addEventListener('click', () => {
    drawVehicleRoute(d);
    if (matchMedia('(max-width: 640px)').matches) closeSheet();
  });
}

/** Spoje vozidel mimo oblast ze serveru (uid → { at, data, pending }); dohledání se opakuje nejdřív po minutě. */
const remoteTrips = new Map();
// Plzeň: spoj se pozná podle čísla spoje PMDP (trip), při změně spoje se dohledá hned znovu
const remoteKey = (v) => (v.source === 'pmdp' && v.trip ? `${v.uid}|${v.trip}` : v.uid);
function remoteDetail(v) {
  const c = remoteTrips.get(remoteKey(v));
  if ((!c || Date.now() - c.at > 60_000) && !c?.pending) fetchRemoteTrip(v);
  if (c?.data) return S.live.detailFromRemote(v, c.data);
  return c?.pending && !c.at ? { trip: null, pending: true } : null;
}
async function fetchRemoteTrip(v) {
  const uid = remoteKey(v), prev = remoteTrips.get(uid);
  remoteTrips.set(uid, { at: prev?.at || 0, data: prev?.data || null, pending: true });
  const q = new URLSearchParams({
    line: v.line ?? '', lat: v.lat, lng: v.lng, delay: v.delay || 0, dest: v.dest || '', mode: vehicleMode(v),
    train: v.train ? '1' : '0', num: v.train ? v.cis || '' : '',
  });
  if (v.heading != null) q.set('heading', v.heading);
  if (v.source === 'pmdp' && v.trip) q.set('pmdp', v.trip);
  let data = prev?.data || null;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/vehicle-trip?${q}`, { cache: 'no-store' });
    if (res.ok) data = (await res.json()).trip || null;
  } catch { /* offline: zůstane poslední známý */ }
  if (remoteTrips.size > 300) remoteTrips.clear();
  remoteTrips.set(uid, { at: Date.now(), data, pending: false });
  if (S.selected === v.uid) renderSheet();
}

// ───────────── zastávky: odjezdy ─────────────
function openStop(st) {
  S.selected = null;
  S.vlayer?.setSelected(null);
  S.stopSel = st;
  renderStopSheet();
  clearInterval(S.stopTimer);
  S.stopTimer = setInterval(() => { if (S.stopSel) renderStopSheet(); }, 30_000);   // odjeté zmizí
}

function renderStopSheet() {
  const st = S.stopSel;
  if (!st) return;
  if (!st.remote) return drawStopSheet(st.name, S.stopIdx.departures(st, pragueNow()));
  // zastávka mimo kraj: odjezdy z celostátního jízdního řádu na serveru
  if (!S.stopDeps || S.stopDepsKey !== st.key) drawStopSheet(st.name || 'Zastávka', null);
  fetch(`${CONFIG.API_BASE}/api/stop-departures?key=${encodeURIComponent(st.key)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((j) => { if (S.stopSel === st) { st.name = j.name; drawStopSheet(j.name, j.deps); } })
    .catch(() => { if (S.stopSel === st && !S.stopDeps) $('#stop-deps-msg').textContent = 'Odjezdy se nepodařilo načíst.'; });
}

/** Panel odjezdů (deps = null: načítá se). */
function drawStopSheet(name, deps) {
  const now = pragueNow();
  S.stopDeps = deps;
  S.stopDepsKey = S.stopSel?.key;
  const rows = (deps || []).map((d, i) => {
    const t = S.tt?.trips[d.tid];
    const min = Math.round((d.dep - now.sec) / 60);
    const when = min <= 0 ? 'teď' : `za ${min}${NBSP}min`;
    const head = d.isTrain ? d.head : stopLabel(d.head);
    const style = d.agency != null ? { isTrain: d.isTrain, agency: d.agency, line: d.line } : t;
    return `<li><button type="button" class="dep-row" data-i="${i}">${depBadgeHtml(style)}<span class="dep-head">směr ${esc(head)}</span><span class="dep-time"><strong>${hhmm(d.dep % 86400)}</strong><small>${when}</small></span></button></li>`;
  }).join('');
  const body = deps == null ? '<p class="age" id="stop-deps-msg">Načítám odjezdy…</p>'
    : deps.length ? `<ol class="stop-deps">${rows}</ol>`
      : `<p class="age">V příštích ${STOP_DEPARTURE_HOURS}${NBSP}hodinách odsud nic nejede.</p>`;
  $('#sheet-body').innerHTML = `
    <h3>Odjezdy</h3>
    <p class="stop-name">${esc(name)}</p>
    <p class="age">Podle jízdního řádu, nejbližší ${STOP_DEPARTURE_HOURS}${NBSP}hodiny</p>
    ${body}`;
  showEl($('#sheet'));
}

// ťuknutí na odjezd: vlnka, panel sjede dolů, na mapě celá trasa spoje a jeho vůz
$('#sheet-body').addEventListener('click', (e) => {
  const btn = e.target.closest('.dep-row');
  if (!btn || !S.stopSel) return;
  const d = S.stopDeps?.[+btn.dataset.i];
  if (!d) return;
  const r = btn.getBoundingClientRect();
  const wave = document.createElement('span');
  wave.className = 'ripple';
  const size = Math.max(r.width, r.height) * 2;
  wave.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.append(wave);
  const remote = !!S.stopSel.remote;
  setTimeout(() => { closeSheet(); (remote ? showRemoteDeparture : showDeparture)(d); }, 170);
});

function showDeparture(dep) {
  clearOverlay();
  const tt = S.tt, t = tt.trips[dep.tid];
  const ids = Array.from(t.stops);
  const pts = S.stopIdx.platformPoints(ids);
  const line = pts.filter(Boolean).map((p) => [p.lat, p.lng]);
  const pl = S.map.addPolyline(line, { color: routeColor(t), width: 10, arrows: true });
  S.overlay.lines.push(pl);
  const gen = overlayGen;
  legRoute(S.shapes, tt, dep.tid, ids)
    .then((r) => r || (t.isTrain ? null : osrmRoute(line)))
    .then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
  const real = pts.map((p, i) => [p, i]).filter(([p]) => p);
  real.forEach(([p, i], k) => {
    const name = prettyName(tt.stops[ids[i]].name);
    if (k === 0 || k === real.length - 1) pin(p.lat, p.lng, k === real.length - 1, stopLabel(name));
    else dot(p.lat, p.lng, `stopdot${ids[i] === dep.from ? '' : ' mid'}`, ids[i] === dep.from ? stopLabel(name) : null, routeColor(t));
  });
  showRouteControls();
  goMap();
  // celá trasa do záběru (pod stavovou kartou), pak případně přiblížení na vůz
  fitUnderBanner(line);
  const d = { rides: [{ tid: dep.tid, from: dep.from, to: ids.at(-1), dep: dep.dep }], day: dep.day };
  activeLiveRoute = { d, routePts: line, key: null };
  focusLive(d, line);
}

/** Odjezd ze zastávky mimo kraj: spoj ze serveru (zastávky na nástupištích, tvar trasy) a jeho vůz na mapě. */
async function showRemoteDeparture(dep) {
  clearOverlay();
  const gen = overlayGen;
  let trip = null;
  try {
    const r = await fetch(`${CONFIG.API_BASE}/api/trip?tid=${dep.tid}`);
    if (r.ok) trip = (await r.json()).trip;
  } catch { /* offline */ }
  if (gen !== overlayGen) return;
  if (!trip) { toast('Trasu spoje se nepodařilo načíst.'); return; }
  const pts = trip.stops.map((s, i) => trip.platforms?.[i] || (s[1] || s[2] ? [s[1], s[2]] : null));
  const line = pts.filter(Boolean);
  const pl = S.map.addPolyline(trip.route && trip.route.length >= 2 ? trip.route : line, { color: routeColor(trip), width: 10, arrows: true });
  S.overlay.lines.push(pl);
  if (!trip.route && !trip.isTrain) osrmRoute(line).then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
  const real = pts.map((p, i) => [p, i]).filter(([p]) => p);
  const boardI = real.findIndex(([, i]) => trip.stops[i] && trip.stops[i][4] % 86400 === dep.dep % 86400);
  real.forEach(([p, i], k) => {
    const name = stopLabel(prettyName(trip.stops[i][0]));
    if (k === 0 || k === real.length - 1) pin(p[0], p[1], k === real.length - 1, name);
    else dot(p[0], p[1], `stopdot${k === boardI ? '' : ' mid'}`, k === boardI ? name : null, routeColor(trip));
  });
  showRouteControls();
  goMap();
  fitUnderBanner(line);
  // vůz spoje: vlak podle čísla, jinak stejná linka nejblíž trase před nástupní zastávkou
  const board = boardI >= 0 ? real[boardI][0] : line[0];
  const routePts = trip.route && trip.route.length >= 2 ? trip.route : line;
  const offRoute = (v) => {
    let best = Infinity;
    for (let i = 0; i < routePts.length; i += Math.max(1, Math.floor(routePts.length / 400))) best = Math.min(best, distanceM(v.lat, v.lng, routePts[i][0], routePts[i][1]));
    return best;
  };
  const norm = (x) => String(x ?? '').trim().replace(/^0+(?=\d)/, '').toLowerCase();
  const cands = S.vehicles.filter((v) => v.state !== 255 && (trip.isTrain
    ? v.train && norm(v.cis) === norm(trip.num)
    : !v.train && norm(v.line) === norm(trip.line) && offRoute(v) < 250));
  cands.sort((a, b) => distanceM(a.lat, a.lng, board[0], board[1]) - distanceM(b.lat, b.lng, board[0], board[1]));
  const live = cands[0];
  if (!live) setTimeout(() => toast('Vůz tohoto spoje teď na mapě nevidíme, ukazuji jen trasu.'), 250);
  else focusUid(vehicleUid(live));
}

function drawVehicleRoute(d) {
  clearOverlay();
  // barva podle vybraného vozu (tramvaj, metro, vlak, autobus), jinak podle spoje
  const sel = S.vehicles.find((x) => vehicleUid(x) === S.selected);
  const vs = sel ? STYLES[vehicleStyle(sel)] : null;
  const pl = S.map.addPolyline(d.shape || d.route, { color: vs ? routeOf(vs) : routeColor(d.trip), width: 10, arrows: true });
  S.overlay.lines.push(pl);
  const gen = overlayGen;
  // tvar ze serveru už je nakreslený; jinak z shapes.bin, u autobusu bez tvaru po silnici přes OSRM
  (d.shape ? Promise.resolve(null) : S.shapes.points(d.trip.shp))
    .then((r) => r || (d.shape || d.trip.isTrain ? null : osrmRoute(d.route)))
    .then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
  // spoj z jízdního řádu webu: zastávky na nástupištích (jako ikony zastávek na mapě)
  const plat = d.tid && S.stopIdx ? S.stopIdx.platformPoints(d.stops.map((s) => s.id)) : null;
  d.stops.forEach((s, i) => {
    if (!s.has) return;
    const p = plat?.[i] || s;
    const isNext = i === d.nextIdx, isEnd = i === d.stops.length - 1;
    if (i === 0 || isEnd) pin(p.lat, p.lng, isEnd, stopLabel(s.name));
    else dot(p.lat, p.lng, `stopdot${isNext ? ' next' : ' mid'}`, isNext ? stopLabel(s.name) : null, isNext ? null : (vs ? routeOf(vs) : routeColor(d.trip)));
  });
  showRouteControls();
}

// moje poloha na mapě
$('#fab-locate').addEventListener('click', async () => {
  const fab = $('#fab-locate');
  if (fab.classList.contains('busy')) return;
  fab.classList.add('busy');
  try {
    const loc = await getLocation();
    if (!S.meMarker) { const el = document.createElement('div'); el.className = 'me'; S.meMarker = S.map.addMarker({ lat: loc.lat, lng: loc.lng, el, z: 1 }); }
    else S.meMarker.setLatLng(loc.lat, loc.lng);
    S.meMarker.el.classList.toggle('coarse', loc.coarse);
    if (loc.coarse) {
      // přibližná poloha z IP adresy: nepřibližovat na "střed Prahy", jen ukázat a upozornit
      toast(`Poloha je jen přibližná (± ${accText(loc.acc)}), nejspíš podle IP adresy. Zapni určování polohy (GPS).`);
      S.map.setView([loc.lat, loc.lng], Math.min(S.map.zoom, 11), { animate: true });
    } else {
      S.loc = loc;
      S.map.setView([loc.lat, loc.lng], 15, { animate: true });
    }
  } catch (e) { toast(e.message); }
  finally { fab.classList.remove('busy'); }
});


// ───────────── dialogy: plynulé zavření ─────────────
// Formulář s method="dialog" i Escape by dialog zavřely okamžitě; nejdřív krátká animace, pak close().
function animateDialogClose(dlg, value) {
  if (dlg._closing || !dlg.open) return;
  if (reduceMotion()) { dlg.close(value); return; }
  dlg._closing = true;
  dlg.classList.add('closing');
  // Dokončí se buď koncem animace zavírání, nebo pojistkou, a posluchač se pokaždé odebere. Dřív po pojistce zůstal
  // viset a při dalším otevření ho spustil konec animace OTEVŘENÍ: dialog se hned po otevření sám zavřel.
  let timer = 0;
  const onEnd = (e) => { if (e.target === dlg && e.animationName === 'dlg-out') done(); };
  const done = () => {
    if (!dlg._closing) return;
    dlg._closing = false;
    dlg.removeEventListener('animationend', onEnd);
    clearTimeout(timer);
    dlg.classList.remove('closing');
    if (dlg.open) dlg.close(value);
  };
  dlg._finishClose = done;
  dlg.addEventListener('animationend', onEnd);
  timer = setTimeout(done, 300);   // pojistka, kdyby animace neproběhla (pozadí, zatížený telefon)
}

/** Otevře dialog; rozběhnuté zavírání nejdřív dokončí (showModal na otevřený dialog by vyhodil chybu). */
function showDialog(dlg) {
  if (dlg._closing) dlg._finishClose?.();
  if (!dlg.open) dlg.showModal();
}
for (const dlg of $$('dialog')) {
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); animateDialogClose(dlg, 'cancel'); });
  dlg.querySelector('form[method="dialog"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    animateDialogClose(dlg, e.submitter?.value ?? '');
  });
}

// ───────────── uvítací dialog ─────────────
function setupWelcome() {
  const dlg = $('#welcome');
  if (!dlg || typeof dlg.showModal !== 'function') return;
  dlg.addEventListener('close', () => store.setWelcomed());
  $('#about-btn')?.addEventListener('click', () => showDialog(dlg));
  if (!store.welcomed()) showDialog(dlg);
}

// ───────────── start ─────────────
async function boot() {
  applyTheme();
  setupWelcome();
  initMap();
  if (location.hash === '#map') setTab('map');
  try {
    S.tt = await loadTimetable(CONFIG.TIMETABLE_URL, { onProgress: (p) => { $('#loading-text').textContent = p < 0.6 ? 'Stahuji jízdní řády…' : 'Připravuji vyhledávání…'; } });
  } catch (e) {
    $('#loading').innerHTML = `<p><strong>Jízdní řády se nepodařilo načíst.</strong><br>${esc(e.message)}</p><button class="btn btn-primary" onclick="location.reload()">Zkusit znovu</button>`;
    pollVehiclesSafe();
    return;
  }
  S.shapes = new ShapeStore(CONFIG.SHAPES_URL);
  S.planner = new Planner(S.tt);
  S.live = new LiveTracker(S.tt);
  S.index = S.tt.placeIndex();
  // zastávky na mapě (nástupiště podle míst a směru jízdy, jako v appce)
  try {
    S.stopIdx = new StopIndex(S.tt);
    S.slayer = new StopLayer(S.map.map, S.stopIdx);
  } catch (e) { console.warn('zastávky na mapě', e); }
  $('#loading').hidden = true;
  $('#search-form').hidden = false;
  setupForm();
  const built = S.tt.meta.built ? new Date(S.tt.meta.built).toLocaleDateString('cs-CZ') : '';
  $('#data-info').textContent = built ? `Jízdní řády z ${built} · ${S.tt.meta.trips.toLocaleString('cs-CZ')} spojů` : '';
  pollVehicles();
  setInterval(() => {
    if (S.journeys.length && !S.loadingMore) renderResults();
    if (S.detail) renderDetail();
  }, 30000);
  setInterval(() => refreshNearby(), 60000);
  autoLocate();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
}
function pollVehiclesSafe() { S.live = { update() {}, forTrip() {}, detail: () => ({ trip: null }) }; pollVehicles(); }

/**
 * Poloha pro odjezdy z nejbližší zastávky: jen když ji uživatel už dřív povolil (bez vyskakovacího dotazu
 * při otevření stránky). Přibližná poloha z IP adresy se nebere.
 */
async function autoLocate() {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p?.state !== 'granted') return;
    const loc = await getLocation({ waitMs: 5000 });
    if (loc.coarse) return;
    S.loc = loc;
    refreshNearby({ relocate: true });
  } catch { /* bez polohy jen nejsou odjezdy z blízké zastávky */ }
}

$('#info-btn').addEventListener('click', () => showDialog($('#welcome')));

// ?debug: stav appky v konzoli (měření, testy)
if (new URLSearchParams(location.search).has('debug')) { window.__spoje = S; S.openStop = openStop; }

boot();
