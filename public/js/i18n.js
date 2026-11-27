// Jazyk webu (čeština / angličtina). Výchozí je čeština; volba angličtiny se ukládá do localStorage a změna
// jazyka stránku načte znovu, takže se všechno vykreslí v novém jazyce. Mimo prohlížeč (Node: server, testy) je vždy čeština.

const NS = 'spojeuk:';
const LANGS = ['cs', 'en'];

function readPref() {
  try { const v = JSON.parse(localStorage.getItem(NS + 'lang')); return LANGS.includes(v) ? v : 'cs'; } catch { return 'cs'; }
}

function detect() {
  if (typeof document === 'undefined') return 'cs';
  return readPref();
}

export const LANG = detect();
/** Locale pro toLocaleString / Intl. */
export const LOCALE = LANG === 'en' ? 'en-GB' : 'cs-CZ';

/** Uložená volba ('cs' | 'en'). */
export const langPref = readPref;
export function setLangPref(v) {
  try { localStorage.setItem(NS + 'lang', JSON.stringify(v)); } catch { /* ignore */ }
}

const csPlural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

const DICT = {
  cs: {
    // hlavička, stránka
    'page.title': 'Spoje UK – vyhledávání spojení a živá mapa',
    'brand.home': 'Spoje UK – úvodní stránka',
    'brand.sub': 'Doprava Ústeckého kraje',
    'about': 'O aplikaci',
    'theme': 'Vzhled',
    'theme.aria': 'Vzhled: {name}. Klepnutím změníš.',
    'theme.auto': 'automaticky', 'theme.light': 'světlý', 'theme.dark': 'tmavý',
    'lang': 'Jazyk',
    'lang.aria': 'Jazyk: {name}. Klepnutím změníš.',
    'lang.cs': 'čeština', 'lang.en': 'angličtina',
    'loading.tt': 'Načítám jízdní řády…',
    'loading.download': 'Stahuji jízdní řády…',
    'loading.prepare': 'Připravuji vyhledávání…',
    'loading.failed': 'Jízdní řády se nepodařilo načíst.',
    'loading.failedHttp': 'Jízdní řády se nepodařilo načíst (HTTP {status})',
    'retry': 'Zkusit znovu',
    'noscript': 'Spoje UK potřebuje JavaScript.',

    // formulář
    'from': 'Odkud', 'to': 'Kam',
    'stop.placeholder': 'Zastávka nebo stanice',
    'locate.aria': 'Použít moji polohu', 'locate': 'Moje poloha',
    'clear': 'Vymazat',
    'swap': 'Prohodit odkud a kam',
    'when': 'Kdy', 'when.now': 'Teď', 'when.custom': 'Jindy',
    'when.is': 'Zvolený čas je', 'departure': 'Odjezd', 'arrival': 'Příjezd',
    'date': 'Datum', 'time.dep': 'Čas odjezdu', 'time.arr': 'Čas příjezdu',
    'search': 'Najít spojení', 'searching': 'Hledám…',
    'modes.all': 'Všechny druhy', 'modes.none': 'Nic', 'modes.aria': 'Druhy dopravy: {list}',
    'modes.title': 'Čím cestovat',
    'suggest.none': 'Nic jsme nenašli. Zkus jiný název.',
    'suggest.start': 'Začni psát název zastávky.',
    'suggest.forget': 'Odebrat z často používaných',
    'err.pick': 'Vyber zastávku odkud i kam.',
    'err.same': 'Odkud a kam jsou stejné. Vyber dvě různé zastávky.',
    'err.search': 'Hledání selhalo. Zkus to prosím znovu.',

    // poloha
    'loc.unsupported': 'Prohlížeč nepodporuje určení polohy.',
    'loc.failed': 'Polohu se nepodařilo zjistit.',
    'loc.denied': 'Přístup k poloze je zakázaný. Povol ho v nastavení prohlížeče.',
    'loc.finding': 'Zjišťuji polohu…',
    'loc.coarse': 'Poloha je jen přibližná (± {acc}), nejspíš podle IP adresy. Zapni určování polohy (GPS) nebo zastávku vyber ručně.',
    'loc.coarseMap': 'Poloha je jen přibližná (± {acc}), nejspíš podle IP adresy. Zapni určování polohy (GPS).',
    'loc.noStop': 'V okolí jsme nenašli žádnou zastávku.',
    'loc.walking': 'Hledám nejbližší zastávku pěšky…',
    'loc.walkHow': '{dist} pěšky, asi {min} min',
    'loc.airHow': '{dist} vzdušnou čarou',
    'loc.nearest': 'Nejbližší zastávka: {stop} ({how}).',

    // výsledky
    'results': 'Výsledky hledání',
    'back': 'Zpět',
    'earlier': 'Dřívější',
    'later': 'Zobrazit další spoje',
    'later.none': 'Další spoje už nejedou',
    'found': '{n} nalezeno',
    'today': 'dnes', 'tomorrow': 'zítra',
    'arriveBy': 'Příjezd do {when}',
    'rel.in': 'za {t}', 'rel.now': 'právě odjíždí', 'rel.ago': 'odjel před {t}',
    'dur.total': '{t} celkem', 'dur.ride': '{t} jízdy',
    'details': 'Zastávky a podrobnosti',
    'map': 'Mapa',
    'walk.min': 'pěšky {n} min',
    'line.aria': 'Linka {line}, podrobnosti jízdy',
    'kind.line.aria': '{kind} {line}, podrobnosti jízdy',
    'transfer': 'Přestup:',
    'transfer.wait': 'čekání {n} min',
    'transfer.walk': 'pěšky {n} min',
    'transfer.row': 'Přestup · čekání {n} min',
    'risk.risk': 'Přestup ohrožen · zpoždění {n} min',
    'risk.tight': 'Těsný přestup · rezerva {n} min',
    'empty.arrive': '<strong>Do zvoleného času žádné spojení nepřijede</strong>Zkus pozdější čas příjezdu.',
    'empty.title': 'Spojení jsme nenašli',
    'empty.tryModes': 'Zkus zvolit všechny druhy dopravy, nebo posunout čas odjezdu',
    'empty.try': 'Zkus posunout čas odjezdu',
    'empty.tomorrow': ' (nebo vybrat zítřejší den)',

    // zpoždění a vlastnosti
    'delay': 'Zpoždění {n} min', 'ahead': 'Napřed {n} min', 'onTime': 'Včas', 'live.onTime': 'Živě · včas',
    'onTime0': 'Včas (0 min)',
    'vehicle.no': 'Vůz {id}', 'accessible': 'Bezbariérový', 'ac': 'Klimatizace',
    'train.no': 'Vlak č. {n}',
    'direction': 'Směr {head}', 'direction.lc': 'směr {head}',

    // detail spojení
    'detail': 'Detail spojení',
    'summary': '{dur} jízdy · {stops} · {transfers}',
    'noTransfer': 'bez přestupu',
    'showOnMap': 'Zobrazit na mapě',
    'showLineOnMap': 'Zobrazit linku {line} na mapě',
    'walk.toStop': 'na zastávku {stop}',
    'walk.row': '{n} min pěšky',
    'stop.a11y.delayed': '{stop}, podle jízdního řádu {plan}, očekávaně {real}',
    'stop.passed': ', projeto',
    'leg.nth': '{i}. spoj z {n}',
    'leg.info': 'Informace o spoji',
    'close': 'Zavřít',

    // oblíbená a historie
    'trips.aria': 'Oblíbená a nedávná spojení',
    'trips.fav': 'Oblíbená spojení', 'trips.recent': 'Nedávná hledání',
    'trip.search': 'Hledat {from} – {to}',
    'trip.reverse.aria': 'Hledat opačným směrem', 'trip.reverse': 'Opačný směr',
    'fav.add': 'Přidat do oblíbených', 'fav.remove': 'Odebrat z oblíbených',
    'history.remove': 'Odebrat z historie',
    'history.gone': 'Zastávka z historie už v jízdním řádu není.',
    'removed': 'Odebráno: {from} – {to}',

    // odjezdy
    'nearby.title': 'Odjezdy z nejbližší zastávky · {dist}',
    'onMap': 'Na mapě',
    'dep.now': 'teď', 'dep.in': 'za {n} min',
    'dep.none2': 'V příštích 2 hodinách odsud nic nejede.',
    'dep.noneH': 'V příštích {n} hodinách odsud nic nejede.',
    'deps': 'Odjezdy', 'deps.loading': 'Načítám odjezdy…', 'deps.failed': 'Odjezdy se nepodařilo načíst.',
    'deps.note': 'Podle jízdního řádu, nejbližší {n} hodiny',
    'stop': 'Zastávka',

    // mapa
    'map.aria': 'Mapa vozidel', 'map.title': 'Mapa vozidel',
    'map.loading': 'Načítám polohy…', 'map.count': '{n} poloh', 'map.failed': 'Polohy se nepodařilo načíst',
    'map.source': 'Zdroj: ',
    'map.tiles': 'Podkladovou mapu se nepodařilo načíst (blokátor reklam nebo síť?). Vozidla se zobrazují i tak.',
    'route.clear': 'Zrušit zobrazení trasy',
    'locate.map': 'Moje poloha na mapě',
    'filter.title': 'Co zobrazit na mapě',
    'filter.aria': 'Zobrazené druhy: {list}', 'filter.all': 'vše', 'filter.nothing': 'nic',
    'selectAll': 'Vybrat vše', 'done': 'Hotovo', 'cancel': 'Zrušit',
    'choose.title': 'Které vozidlo?',
    'sheet.aria': 'Informace o spoji',
    'nav.aria': 'Hlavní navigace', 'tab.search': 'Spoje', 'tab.map': 'Mapa',
    'zoomIn': 'Přiblížit', 'zoomOut': 'Oddálit',
    'veh.notSeen': 'Vůz tohoto spoje teď na mapě nevidíme, ukazuji jen trasu.',
    'route.failed': 'Trasu spoje se nepodařilo načíst.',

    // vozidlo
    'vehicle': 'Vozidlo', 'vehicle.gone': 'Vozidlo už zdroj nedodává.',
    'vehicle.id': 'ID vozidla: {id}', 'vehicle.idNa': 'ID vozidla: není dostupné', 'vehicle.trip': 'Spoj: {id}',
    'vehicle.metro': 'Metro nehlásí číslo soupravy, vůz se sleduje podle spoje.',
    'vehicle.source': 'Zdroj polohy: {src}',
    'vehicle.delay': 'Zpoždění:', 'vehicle.next': 'Příští zastávka:', 'vehicle.final': 'Konečná zastávka:',
    'vehicle.dir': 'Směr:', 'vehicle.agency': 'Dopravce:',
    'vehicle.looking': 'Dohledávám spoj…', 'vehicle.route': 'Zobrazit trasu spoje',
    'vehicle.xmas': 'Vánoční vůz',
    'source.none': 'žádný',
    'age.now': 'Aktuální poloha', 'age.ago': 'Poloha před {t}', 'age.old': 'Poloha stará {t}. Zdroj teď vozidlo nedodává.',

    // druhy
    'mode.bus': 'Bus', 'mode.trolleybus': 'Trolejbus', 'mode.tram': 'Tramvaj', 'mode.metro': 'Metro',
    'mode.train': 'Vlak', 'mode.ferry': 'Přívoz', 'mode.funicular': 'Lanovka', 'mode.vehicle': 'Vozidlo', 'mode.line': 'Linka',
    'cat.bus': 'Autobusy', 'cat.bus.note': 'včetně trolejbusů', 'cat.tram': 'Tramvaje', 'cat.metro': 'Metro', 'cat.train': 'Vlaky',

    // uvítání a patička
    'legal': 'Svobodný open-source projekt (licence MIT), není spojený s žádným dopravcem, organizátorem dopravy ani jinou organizací. Data mohou být neúplná nebo zpožděná, na kritické cesty se spoléhej na oficiální zdroje.',
    'legal.short': 'Svobodný open-source projekt (licence MIT), není spojený s žádným dopravcem, organizátorem dopravy ani jinou organizací. Na kritické cesty se spoléhej na oficiální zdroje.',
    'aboutProject': 'O projektu',
    'dataInfo': 'Jízdní řády z {date} · {n} spojů',
    'welcome.title': 'Vítej ve Spoje UK',
    'welcome.lead': 'Spojení a živá mapa vozidel po Ústeckém kraji, ve webovém prohlížeči a na každém zařízení.',
    'welcome.search': '<strong>Hledání spojení</strong> s přestupy, funguje i offline.',
    'welcome.map': '<strong>Živá mapa</strong> autobusů, tramvají a vlaků se zpožděním.',
    'welcome.install': '<strong>Přidej si na plochu</strong> z nabídky prohlížeče a otevírá se jako aplikace.',
    'welcome.start': 'Začít',

    // formáty
    days: ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'],
    'n.transfers': (n) => (n === 0 ? 'přímý spoj' : `${n} ${csPlural(n, 'přestup', 'přestupy', 'přestupů')}`),
    'n.stops': (n) => `${n} ${csPlural(n, 'zastávka', 'zastávky', 'zastávek')}`,
    'n.midStops': (n) => `${n} ${csPlural(n, 'mezizastávka', 'mezizastávky', 'mezizastávek')}`,
    decimal: ',',
  },

  en: {
    'page.title': 'Spoje UK – journey planner and live map',
    'brand.home': 'Spoje UK – home',
    'brand.sub': 'Ústí Region public transport',
    'about': 'About',
    'theme': 'Appearance',
    'theme.aria': 'Appearance: {name}. Tap to change.',
    'theme.auto': 'automatic', 'theme.light': 'light', 'theme.dark': 'dark',
    'lang': 'Language',
    'lang.aria': 'Language: {name}. Tap to change.',
    'lang.cs': 'Czech', 'lang.en': 'English',
    'loading.tt': 'Loading timetables…',
    'loading.download': 'Downloading timetables…',
    'loading.prepare': 'Preparing search…',
    'loading.failed': 'Timetables could not be loaded.',
    'loading.failedHttp': 'Timetables could not be loaded (HTTP {status})',
    'retry': 'Try again',
    'noscript': 'Spoje UK needs JavaScript.',

    'from': 'From', 'to': 'To',
    'stop.placeholder': 'Stop or station',
    'locate.aria': 'Use my location', 'locate': 'My location',
    'clear': 'Clear',
    'swap': 'Swap from and to',
    'when': 'When', 'when.now': 'Now', 'when.custom': 'Later',
    'when.is': 'The chosen time is', 'departure': 'Departure', 'arrival': 'Arrival',
    'date': 'Date', 'time.dep': 'Departure time', 'time.arr': 'Arrival time',
    'search': 'Find connections', 'searching': 'Searching…',
    'modes.all': 'All modes', 'modes.none': 'None', 'modes.aria': 'Modes of transport: {list}',
    'modes.title': 'Travel by',
    'suggest.none': 'Nothing found. Try a different name.',
    'suggest.start': 'Start typing a stop name.',
    'suggest.forget': 'Remove from frequently used',
    'err.pick': 'Choose both a from and a to stop.',
    'err.same': 'From and to are the same. Choose two different stops.',
    'err.search': 'Search failed. Please try again.',

    'loc.unsupported': 'This browser cannot determine your location.',
    'loc.failed': 'Your location could not be determined.',
    'loc.denied': 'Location access is blocked. Allow it in your browser settings.',
    'loc.finding': 'Finding your location…',
    'loc.coarse': 'Your location is only approximate (± {acc}), probably based on your IP address. Turn on location (GPS) or pick the stop yourself.',
    'loc.coarseMap': 'Your location is only approximate (± {acc}), probably based on your IP address. Turn on location (GPS).',
    'loc.noStop': 'No stop found nearby.',
    'loc.walking': 'Finding the nearest stop on foot…',
    'loc.walkHow': '{dist} on foot, about {min} min',
    'loc.airHow': '{dist} as the crow flies',
    'loc.nearest': 'Nearest stop: {stop} ({how}).',

    'results': 'Search results',
    'back': 'Back',
    'earlier': 'Earlier',
    'later': 'Show more connections',
    'later.none': 'No more connections today',
    'found': '{n} found',
    'today': 'today', 'tomorrow': 'tomorrow',
    'arriveBy': 'Arrive by {when}',
    'rel.in': 'in {t}', 'rel.now': 'departing now', 'rel.ago': 'left {t} ago',
    'dur.total': '{t} in total', 'dur.ride': '{t} ride',
    'details': 'Stops and details',
    'map': 'Map',
    'walk.min': 'walk {n} min',
    'line.aria': 'Line {line}, ride details',
    'kind.line.aria': '{kind} {line}, ride details',
    'transfer': 'Change:',
    'transfer.wait': 'wait {n} min',
    'transfer.walk': 'walk {n} min',
    'transfer.row': 'Change · wait {n} min',
    'risk.risk': 'Connection at risk · {n} min late',
    'risk.tight': 'Tight connection · {n} min to spare',
    'empty.arrive': '<strong>No connection arrives by the chosen time</strong>Try a later arrival time.',
    'empty.title': 'No connections found',
    'empty.tryModes': 'Try choosing all modes of transport, or shifting the departure time',
    'empty.try': 'Try shifting the departure time',
    'empty.tomorrow': ' (or choosing tomorrow)',

    'delay': '{n} min late', 'ahead': '{n} min early', 'onTime': 'On time', 'live.onTime': 'Live · on time',
    'onTime0': 'On time (0 min)',
    'vehicle.no': 'Vehicle {id}', 'accessible': 'Step-free', 'ac': 'Air conditioning',
    'train.no': 'Train no. {n}',
    'direction': 'To {head}', 'direction.lc': 'to {head}',

    'detail': 'Connection details',
    'summary': '{dur} ride · {stops} · {transfers}',
    'noTransfer': 'no changes',
    'showOnMap': 'Show on map',
    'showLineOnMap': 'Show line {line} on map',
    'walk.toStop': 'to stop {stop}',
    'walk.row': '{n} min walk',
    'stop.a11y.delayed': '{stop}, scheduled {plan}, expected {real}',
    'stop.passed': ', passed',
    'leg.nth': 'Ride {i} of {n}',
    'leg.info': 'Ride information',
    'close': 'Close',

    'trips.aria': 'Favourite and recent connections',
    'trips.fav': 'Favourite connections', 'trips.recent': 'Recent searches',
    'trip.search': 'Search {from} – {to}',
    'trip.reverse.aria': 'Search the opposite direction', 'trip.reverse': 'Opposite direction',
    'fav.add': 'Add to favourites', 'fav.remove': 'Remove from favourites',
    'history.remove': 'Remove from history',
    'history.gone': 'This stop is no longer in the timetable.',
    'removed': 'Removed: {from} – {to}',

    'nearby.title': 'Departures from the nearest stop · {dist}',
    'onMap': 'On map',
    'dep.now': 'now', 'dep.in': 'in {n} min',
    'dep.none2': 'Nothing leaves from here in the next 2 hours.',
    'dep.noneH': 'Nothing leaves from here in the next {n} hours.',
    'deps': 'Departures', 'deps.loading': 'Loading departures…', 'deps.failed': 'Departures could not be loaded.',
    'deps.note': 'Timetabled, next {n} hours',
    'stop': 'Stop',

    'map.aria': 'Vehicle map', 'map.title': 'Vehicle map',
    'map.loading': 'Loading positions…', 'map.count': '{n} positions', 'map.failed': 'Positions could not be loaded',
    'map.source': 'Source: ',
    'map.tiles': 'The base map could not be loaded (ad blocker or network?). Vehicles are still shown.',
    'route.clear': 'Hide route',
    'locate.map': 'My location on the map',
    'filter.title': 'What to show on the map',
    'filter.aria': 'Shown modes: {list}', 'filter.all': 'all', 'filter.nothing': 'none',
    'selectAll': 'Select all', 'done': 'Done', 'cancel': 'Cancel',
    'choose.title': 'Which vehicle?',
    'sheet.aria': 'Ride information',
    'nav.aria': 'Main navigation', 'tab.search': 'Journeys', 'tab.map': 'Map',
    'zoomIn': 'Zoom in', 'zoomOut': 'Zoom out',
    'veh.notSeen': 'The vehicle for this ride is not on the map right now, showing just the route.',
    'route.failed': 'The route could not be loaded.',

    'vehicle': 'Vehicle', 'vehicle.gone': 'The source no longer reports this vehicle.',
    'vehicle.id': 'Vehicle ID: {id}', 'vehicle.idNa': 'Vehicle ID: not available', 'vehicle.trip': 'Trip: {id}',
    'vehicle.metro': 'The metro does not report train set numbers, the vehicle is tracked by its trip.',
    'vehicle.source': 'Position source: {src}',
    'vehicle.delay': 'Delay:', 'vehicle.next': 'Next stop:', 'vehicle.final': 'Final stop:',
    'vehicle.dir': 'Direction:', 'vehicle.agency': 'Operator:',
    'vehicle.looking': 'Looking up the trip…', 'vehicle.route': 'Show route',
    'vehicle.xmas': 'Christmas vehicle',
    'source.none': 'none',
    'age.now': 'Current position', 'age.ago': 'Position from {t} ago', 'age.old': 'Position is {t} old. The source no longer reports this vehicle.',

    'mode.bus': 'Bus', 'mode.trolleybus': 'Trolleybus', 'mode.tram': 'Tram', 'mode.metro': 'Metro',
    'mode.train': 'Train', 'mode.ferry': 'Ferry', 'mode.funicular': 'Funicular', 'mode.vehicle': 'Vehicle', 'mode.line': 'Line',
    'cat.bus': 'Buses', 'cat.bus.note': 'including trolleybuses', 'cat.tram': 'Trams', 'cat.metro': 'Metro', 'cat.train': 'Trains',

    'legal': 'A free open-source project (MIT licence), not affiliated with any operator, transport authority or other organisation. Data may be incomplete or delayed; for critical journeys rely on official sources.',
    'legal.short': 'A free open-source project (MIT licence), not affiliated with any operator, transport authority or other organisation. For critical journeys rely on official sources.',
    'aboutProject': 'About the project',
    'dataInfo': 'Timetables from {date} · {n} trips',
    'welcome.title': 'Welcome to Spoje UK',
    'welcome.lead': 'Journeys and a live vehicle map for the Ústí Region, in your web browser on any device.',
    'welcome.search': '<strong>Journey planner</strong> with changes, works offline too.',
    'welcome.map': '<strong>Live map</strong> of buses, trams and trains with delays.',
    'welcome.install': '<strong>Add it to your home screen</strong> from the browser menu and it opens like an app.',
    'welcome.start': 'Get started',

    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    'n.transfers': (n) => (n === 0 ? 'direct' : `${n} ${n === 1 ? 'change' : 'changes'}`),
    'n.stops': (n) => `${n} ${n === 1 ? 'stop' : 'stops'}`,
    'n.midStops': (n) => `${n} ${n === 1 ? 'intermediate stop' : 'intermediate stops'}`,
    decimal: '.',
  },
};

/** Text podle klíče; {název} v textu se nahradí hodnotou z p. Funkce (množná čísla) dostane p.n. */
export function t(key, p = {}) {
  const s = DICT[LANG][key] ?? DICT.cs[key] ?? key;
  if (typeof s === 'function') return s(p.n ?? 0);
  if (typeof s !== 'string') return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ''));
}

/** Pole / hodnota bez nahrazování (názvy dnů). */
export const tv = (key) => DICT[LANG][key] ?? DICT.cs[key];

/**
 * Statické texty v HTML: data-i18n="klíč" (textContent), data-i18n-html="klíč" (innerHTML, jen vlastní texty
 * ze slovníku), data-i18n-attr="aria-label:klíč;title:klíč".
 */
export function applyStatic(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}
