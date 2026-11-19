// Spoje UK: webová aplikace (vyhledávání spojení + živá mapa vozidel).
import { CONFIG } from './config.js';
import { loadTimetable } from './timetable.js';
import { Planner, describeJourney } from './planner.js';
import { suggest, nearestPlaces } from './suggest.js';
import { LiveTracker, fetchVehicles, sourceStatusParts, vehicleUid } from './live.js';
import { MapView } from './gl-map.js';
import { VehicleLayer, CATEGORIES, vehicleStyle, vehicleMode, lateMinutes, STYLES, LATE_COLOR } from './vehicle-layer.js';
import { ShapeStore, legRoute, osrmRoute, footRoute, footDistances, WALK_M_PER_MIN } from './shapes.js';
import { store } from './store.js';
import {
  prettyName, splitStopName, stopLabel, hhmm, pragueNow, addDays, dayDiff, dayToIso, isoToDay, fmtMinutes, fmtDist,
  pluralStops, pluralTransfers, ageLabel, fmtDayShort, DAY_NAMES, weekday, NBSP, dedupeByUid,
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
  overlay: { lines: [], markers: [] }, meMarker: null,
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
  const m = $('meta[name="theme-color"]');
  if (m) m.content = resolvedTheme() === 'dark' ? '#05111f' : '#3d9de8';
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
  try { history.replaceState(null, '', tab === 'map' ? '#map' : location.pathname + location.search); } catch { /* ignore */ }
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ───────────── mapa ─────────────
function initMap() {
  S.map = new MapView($('#map'), { center: CONFIG.MAP_CENTER, zoom: 12, configUrl: CONFIG.MAP_CONFIG_URL, theme: resolvedTheme() });
  S.map.on('tilesfailed', () => { const o = $('#outage'); o.querySelector('span').textContent = 'Podkladovou mapu se nepodařilo načíst (blokátor reklam nebo síť?). Vozidla se zobrazují i tak.'; o.hidden = false; });
  S.vlayer = new VehicleLayer(S.map.map, {
    onTap: (hits) => (hits.length > 1 ? chooseVehicle(hits) : selectVehicle(hits[0].uid)),
  });
  S.vlayer.setFilter(loadFilter());
  S.vlayer.setVisible(mapShown());
  // ťuknutí na vozidlo řeší vrstva vozidel; jinam do mapy = zavřít detail
  S.map.on('click', (e) => { if (S.vlayer.hitTest(e.point.x, e.point.y).length) return; if (S.selected) closeSheet(); });
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
  dlg.showModal();
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

/** Druhy dopravy pro hledání spojení: stejný dialog jako na mapě; pamatuje se, změna hledá znovu. */
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
    const before = catSummary(S.mode);
    openCategoryDialog('Čím cestovat', S.mode, (set) => {
      S.mode = set;
      store.set('searchCats', set ? [...set] : ALL_CATS);
      sync();
    }, () => { if (catSummary(S.mode) !== before && S.query) runSearch(); }, { allowEmpty: false });
  });
  sync();
}

const MODE_LABEL = { bus: 'Bus', trolleybus: 'Bus', tram: 'Tramvaj', metro: 'Metro', train: 'Vlak', ferry: 'Přívoz', funicular: 'Lanovka' };
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
const kindOf = (v) => (v.mode === 'trolleybus' ? 'trolleybus' : vehicleMode(v));

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
  dlg.showModal();
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
  setupModeFilter();
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
  $('#earlier').addEventListener('click', loadEarlier);
  $('#later').addEventListener('click', loadLater);
  new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && S.journeys.length) loadLater(true); }, { root: $('#scroll'), rootMargin: '0px 0px 200px 0px' }).observe($('#more'));

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
    const start = startTime();
    const t0 = performance.now();
    const js = S.planner.find(S.from, S.to, start, { count: 8, mode: S.mode });
    S.query = { from: S.from, to: S.to, mode: S.mode, start };
    S.journeys = js; S.desc.clear(); S.expanded.clear(); S.noMoreEarlier = false;
    console.debug(`[hledání] ${js.length} spojení za ${Math.round(performance.now() - t0)} ms`);
    renderResults(true);
    $('#scroll').scrollTo({ top: $('#results').offsetTop - 80, behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    formMessage('Hledání selhalo. Zkus to prosím znovu.');
  } finally {
    btn.disabled = false; btn.lastChild.textContent = 'Najít spojení';
  }
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
  if (!S.query || S.loadingMore) return;
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

function badgeHtml(line, isTrain) {
  return `<span class="badge${isTrain ? ' train' : ''}">${isTrain ? icon('train') : ''}${esc(line)}</span>`;
}

function delayTag(d) {
  const v = S.live?.forTrip(d.rides[0].tid);
  if (!v || dayDiff(pragueNow().day, d.day) !== 0) return '';
  if (v.delay >= 1) return `<span class="tag${v.delay > CONFIG.LATE_MIN ? ' late' : ''}">Zpoždění ${v.delay}${NBSP}min</span>`;
  return '<span class="tag ok">Včas</span>';
}

function timelineHtml(d) {
  const tt = S.tt;
  const pts = [];
  const push = (p) => {
    const last = pts[pts.length - 1];
    if (last && last.stop === p.stop && !last.walk && !p.walk && last.dep == null) { last.dep = p.dep; last.info = p.info ?? last.info; last.mid = p.mid; }
    else pts.push(p);
  };
  for (const l of d.legs) {
    if (l.kind === 'walk') {
      const m = Math.max(1, Math.ceil((l.arr - l.dep) / 60));
      pts.push({ walk: true, text: `Pěšky ${m}${NBSP}min` });
      continue;
    }
    const t = tt.trips[l.tid];
    const info = `${badgeHtml(t.line, t.isTrain)} směr ${esc(prettyName(t.head))}`;
    const first = l.stops[0], lastS = l.stops[l.stops.length - 1];
    push({ stop: first.stop, arr: null, dep: first.dep, info, boarding: true });
    const mids = l.stops.slice(1, -1);
    if (mids.length) pts.push({ mids, stop: -1 });
    push({ stop: lastS.stop, arr: lastS.arr, dep: null });
  }
  return `<ol class="timeline">${pts.map((p) => {
    if (p.walk) return `<li class="leg">${icon('walk')} ${p.text}</li>`;
    if (p.mids) {
      return `<li class="mid"><details><summary>${pluralStops(p.mids.length)} mezi</summary><ul>${p.mids.map((m) => `<li><span class="t">${hhmm(m.dep)}</span>${esc(stopLabel(prettyName(tt.stops[m.stop].name)))}</li>`).join('')}</ul></details></li>`;
    }
    const name = prettyName(tt.stops[p.stop].name);
    const time = p.arr != null && p.dep != null ? `${hhmm(p.arr)} → ${hhmm(p.dep)}` : hhmm(p.arr ?? p.dep);
    return `<li><span class="t">${time}</span><strong>${esc(stopLabel(name))}</strong> <span class="sj-city" style="color:var(--muted);font-size:.85rem">${esc(splitStopName(name).city)}</span>${p.info ? `<div class="leg">${p.info}</div>` : ''}</li>`;
  }).join('')}</ol>`;
}

function journeyHtml(j, i) {
  const d = descOf(j);
  const open = S.expanded.has(j.key);
  const dl = dayLabel(d);
  const trans = d.transferList.map((t) => `<div class="transfer">Přestup: <strong>${esc(t.at)}</strong> · čekání ${t.waitMin}${NBSP}min${t.walkMin ? ` · pěšky ${t.walkMin}${NBSP}min` : ''}</div>`).join('');
  const lines = d.rides.map((r) => badgeHtml(S.tt.trips[r.tid].line, S.tt.trips[r.tid].isTrain)).join('<span class="sep">+</span>');
  return `<li class="journey" data-i="${i}" data-key="${esc(j.key)}">
    <div class="j-top">
      <div>
        <div class="j-times">${hhmm(d.dep)} ${icon('arrow-right')} ${hhmm(d.arr)}</div>
        <div class="j-rel">${esc(dl ? `${dl} · ` : '')}${esc(relative(d))}</div>
        <div class="j-dur">${fmtMinutes(d.durationMin)} ${d.transfers ? 'celkem' : 'jízdy'}</div>
      </div>
      <div class="j-actions"><button type="button" class="pill-btn" data-act="map">${icon('map')}Mapa</button></div>
    </div>
    <div class="j-lines">${d.boardWalkMin ? `<span class="tag">${icon('walk')} pěšky ${d.boardWalkMin}${NBSP}min</span>` : ''}${lines}${delayTag(d)}</div>
    <div class="j-meta">${pluralStops(d.stopsCount)} · ${pluralTransfers(d.transfers)}</div>
    ${trans}
    <div class="j-sub">Směr ${esc(d.destination)}</div>
    <div class="j-sub">${esc(d.agency)}</div>
    <button type="button" class="toggle" data-act="toggle" aria-expanded="${open}">Podrobnosti ${icon('chevron')}</button>
    ${open ? `<div class="tl-wrap">${timelineHtml(d)}</div>` : ''}
  </li>`;
}

function renderResults(fresh = false) {
  const res = $('#results'), empty = $('#empty');
  if (!S.query) { res.hidden = true; empty.hidden = true; return; }
  if (!S.journeys.length) {
    res.hidden = true; empty.hidden = false;
    const q = S.query;
    empty.innerHTML = `<strong>Spojení jsme nenašli</strong>${q.mode && q.mode.size ? 'Zkus zvolit všechny druhy dopravy, nebo ' : 'Zkus '}posunout čas odjezdu${q.start.sec > 3600 * 20 ? ' (nebo vybrat zítřejší den)' : ''}.`;
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
  $('#count').textContent = `${S.journeys.length} nalezeno`;
  $('#earlier').disabled = S.noMoreEarlier;
  if (fresh) { $('#more').hidden = false; $('#later').textContent = 'Zobrazit další spoje'; }
}

$('#journeys').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('.journey');
  const j = S.journeys[+li.dataset.i];
  if (btn.dataset.act === 'toggle') {
    // podrobnosti se rozbalí / sbalí výškovou animací, karta se nepřekresluje celá
    const k = j.key, open = !S.expanded.has(k);
    if (open) S.expanded.add(k); else S.expanded.delete(k);
    btn.setAttribute('aria-expanded', String(open));
    const old = li.querySelector('.tl-wrap');
    if (open && !old) {
      const wrap = document.createElement('div');
      wrap.className = 'tl-wrap';
      wrap.innerHTML = timelineHtml(descOf(j));
      li.append(wrap);
      if (!reduceMotion()) wrap.animate([{ height: '0px', opacity: 0 }, { height: `${wrap.scrollHeight}px`, opacity: 1 }], { duration: 280, easing: EASE_OUT });
    } else if (!open && old) {
      if (reduceMotion()) old.remove();
      else old.animate([{ height: `${old.scrollHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 200, easing: EASE_IN, fill: 'forwards' }).finished.then(() => old.remove()).catch(() => old.remove());
    }
    // seznam se při příštím obnovení nepřekreslí, pokud se nic jiného nezměnilo
    S.lastHtml = S.journeys.map(journeyHtml).join('');
  } else if (btn.dataset.act === 'map') {
    btn.animate([{ transform: 'scale(.92)' }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
    showJourneyOnMap(descOf(j));
  }
});

// ───────────── trasy na mapě ─────────────
let overlayGen = 0; // zahodí pozdě doražené trasy, když mezitím došlo ke změně na mapě
let flashTimer;
function clearOverlay() {
  overlayGen++;
  S.overlay.lines.forEach((l) => l.remove()); S.overlay.markers.forEach((m) => m.remove());
  S.overlay = { lines: [], markers: [] };
  hideEl($('#clear-route'), { y: -8 });
  hideEl($('#clear-route-icon'), { y: 8, scale: .8 });
}

function showRouteControls() {
  showEl($('#clear-route'));
  showEl($('#clear-route-icon'));
}

function dot(lat, lng, cls, label) {
  const el = document.createElement('div');
  el.className = cls;
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
    const line = l.stops.map((x) => sp(x.stop)).filter((s) => s.hasCoords).map((s) => [s.lat, s.lng]);
    const pl = S.map.addPolyline(line, { color: t.isTrain ? '#6a5bd8' : '#2786d6', width: 10, arrows: true });
    S.overlay.lines.push(pl);
    // přesná trasa po silnici/trati nahradí rovnou čáru, jakmile se načte
    const gen = overlayGen;
    legRoute(S.shapes, tt, l.tid, l.stops.map((x) => x.stop))
      .then((r) => r || (t.isTrain ? null : osrmRoute(line)))
      .then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
    l.stops.slice(1, -1).forEach((x) => { const s = sp(x.stop); if (s.hasCoords) dot(s.lat, s.lng, 'stopdot mid'); });
  });
  // přestupy
  d.rides.slice(0, -1).forEach((r) => { const s = sp(r.to); if (s.hasCoords) dot(s.lat, s.lng, 'stopdot', stopLabel(prettyName(s.name))); });
  const first = sp(d.rides[0].from), last = sp(d.rides[d.rides.length - 1].to);
  if (first.hasCoords) pin(first.lat, first.lng, false, stopLabel(prettyName(first.name)));
  if (last.hasCoords) pin(last.lat, last.lng, true, stopLabel(prettyName(last.name)));
  showRouteControls();
  setTab('map');
  // jede-li některý spoj z cesty právě živě, zvýrazní se a přiblíží se na něj (jako v aplikaci)
  // vůz spoje stejně jako v appce: spárovaný se spojem (i DPMÚL podle polohy), jinak nejbližší vůz linky před nástupem
  const live = S.live.vehicleForJourney?.(d)?.v;
  const liveUid = live && S.vehicles.some((x) => vehicleUid(x) === vehicleUid(live)) ? vehicleUid(live) : null;
  // dřív tlačítko „nic neudělalo“: když vůz spoje teď nevidíme, aspoň to řekneme
  if (!liveUid) setTimeout(() => toast('Vůz tohoto spoje teď na mapě nevidíme, ukazuji jen trasu.'), 250);
  if (liveUid) {
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
      const p = S.vlayer.position(liveUid);
      if (p) S.map.setView([p.lat, p.lng], Math.max(S.map.zoom, mobile ? 16 : 15), { animate: true });
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
    $('#status-sub').textContent = `${S.vehicles.length} poloh`;
    const sourceStatus = $('#source-status');
    sourceStatus.replaceChildren(document.createTextNode('Zdroj: '));
    for (const [i, source] of sourceStatusParts(snap.sources).entries()) {
      if (i) sourceStatus.append(document.createTextNode(', '));
      const label = document.createElement('span');
      label.textContent = `${source.name}${source.stale ? ' (zastaralé)' : ''}`;
      if (source.stale) label.className = 'source-stale';
      sourceStatus.append(label);
    }
    sourceStatus.hidden = false;
    if (S.journeys.length) renderResults();
    if (S.selected) renderSheet();
  } catch (e) {
    $('#status-sub').textContent = 'Polohy se nepodařilo načíst';
  } finally {
    setTimeout(pollVehicles, CONFIG.POLL_MS);
  }
}

function selectVehicle(uid) {
  S.selected = uid;
  S.vlayer.setSelected(uid);
  renderSheet();
  const p = S.vlayer.position(uid);
  if (p) S.map.setView([p.lat, p.lng], Math.max(S.map.zoom, 14), { animate: true });
}

function closeSheet() {
  S.selected = null;
  // detail zajede dolů (na mobilu přes celou výšku, na počítači jen kousek)
  const sh = $('#sheet');
  hideEl(sh, isMobile() ? { y: Math.max(120, sh.offsetHeight), duration: 220 } : { y: 16, duration: 170 });
  S.vlayer?.setSelected(null);
}
$('#sheet-close').addEventListener('click', () => closeSheet());
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
function remoteDetail(v) {
  const c = remoteTrips.get(v.uid);
  if ((!c || Date.now() - c.at > 60_000) && !c?.pending) fetchRemoteTrip(v);
  if (c?.data) return S.live.detailFromRemote(v, c.data);
  return c?.pending && !c.at ? { trip: null, pending: true } : null;
}
async function fetchRemoteTrip(v) {
  const uid = v.uid, prev = remoteTrips.get(uid);
  remoteTrips.set(uid, { at: prev?.at || 0, data: prev?.data || null, pending: true });
  const q = new URLSearchParams({
    line: v.line ?? '', lat: v.lat, lng: v.lng, delay: v.delay || 0, dest: v.dest || '', mode: vehicleMode(v),
    train: v.train ? '1' : '0', num: v.train ? v.cis || '' : '',
  });
  if (v.heading != null) q.set('heading', v.heading);
  let data = prev?.data || null;
  try {
    const res = await fetch(`${CONFIG.API_BASE}/api/vehicle-trip?${q}`, { cache: 'no-store' });
    if (res.ok) data = (await res.json()).trip || null;
  } catch { /* offline: zůstane poslední známý */ }
  if (remoteTrips.size > 300) remoteTrips.clear();
  remoteTrips.set(uid, { at: Date.now(), data, pending: false });
  if (S.selected === uid) renderSheet();
}

function drawVehicleRoute(d) {
  clearOverlay();
  const pl = S.map.addPolyline(d.shape || d.route, { color: d.trip.isTrain ? '#6a5bd8' : '#2786d6', width: 10, arrows: true });
  S.overlay.lines.push(pl);
  const gen = overlayGen;
  // tvar ze serveru už je nakreslený; jinak z shapes.bin, u autobusu bez tvaru po silnici přes OSRM
  (d.shape ? Promise.resolve(null) : S.shapes.points(d.trip.shp))
    .then((r) => r || (d.shape || d.trip.isTrain ? null : osrmRoute(d.route)))
    .then((r) => { if (r && gen === overlayGen) pl.setPoints(r); });
  d.stops.forEach((s, i) => {
    if (!s.has) return;
    const isNext = i === d.nextIdx, isEnd = i === d.stops.length - 1;
    if (i === 0 || isEnd) pin(s.lat, s.lng, isEnd, stopLabel(s.name));
    else dot(s.lat, s.lng, `stopdot${isNext ? ' next' : ' mid'}`, isNext ? stopLabel(s.name) : null);
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
  if (dlg._closing) return;
  if (reduceMotion()) { dlg.close(value); return; }
  dlg._closing = true;
  dlg.classList.add('closing');
  const done = () => { dlg._closing = false; dlg.classList.remove('closing'); dlg.close(value); };
  dlg.addEventListener('animationend', done, { once: true });
  setTimeout(() => { if (dlg._closing) done(); }, 260);   // pojistka, kdyby animace neproběhla
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
  $('#about-btn')?.addEventListener('click', () => dlg.showModal());
  if (!store.welcomed()) dlg.showModal();
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
  $('#loading').hidden = true;
  $('#search-form').hidden = false;
  setupForm();
  const built = S.tt.meta.built ? new Date(S.tt.meta.built).toLocaleDateString('cs-CZ') : '';
  $('#data-info').textContent = built ? `Jízdní řády z ${built} · ${S.tt.meta.trips.toLocaleString('cs-CZ')} spojů` : '';
  pollVehicles();
  setInterval(() => { if (S.journeys.length && !S.loadingMore) renderResults(); }, 30000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
}
function pollVehiclesSafe() { S.live = { update() {}, forTrip() {}, detail: () => ({ trip: null }) }; pollVehicles(); }

// ?debug: stav appky v konzoli (měření, testy)
if (new URLSearchParams(location.search).has('debug')) window.__spoje = S;

boot();
