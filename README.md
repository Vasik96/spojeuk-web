# Spoje UK web

Webová verze Spoje UK pro všechna zařízení mimo Android: **aplikace** (`/`) s hledáním spojení a živou mapou vozidel; při prvním otevření ukáže uvítací dialog. Funguje i jako PWA (přidání na plochu, hledání offline).

Bez závislostí: stačí **Node 22.5+**, žádné `npm install`, žádný build krok.

```bash
cd web
npm run data     # stáhne jízdní řády z release Vasik96/spojeuk-data → public/data/timetable.json
npm start        # http://localhost:8080
npm run dev      # totéž, ale polohy vozidel se počítají z jízdního řádu (když není dostupný živý zdroj)
npm test
```

Při prvním startu bez dat se jízdní řády a trasy stáhnou samy. Server kontroluje aktualizace každých 12 h při požadavku na stránku nebo API (`DATA_REFRESH_H=0` vypne).

## Jak je to postavené

| Část | Soubor | Co dělá |
|---|---|---|
| Data | `lib/build-timetable.mjs` | GTFS (autobusy + vlaky) → kompaktní JSON (~4 MB, ~0,4 MB po kompresi). Stejná logika jako `GtfsImporter` v appce, včetně párování nádraží |
| Hledání | `public/js/planner.js` | RAPTOR, přestupy ≥ 120 s, pěšky do 250 m. Běží v prohlížeči, tedy offline |
| Napovídání | `public/js/suggest.js` | používání → vzdálenost → zbytek |
| Živá vozidla | `lib/feed.mjs`, `public/js/live.js` | server stahuje feed, drží zmizelá vozidla (MHD 5 min, ostatní 3 min), klient je páruje se spoji |
| Mapa | `public/js/map.js` | vlastní engine (dlaždice, značky, čáry, pinch/drag), bez knihoven |
| Server | `server.mjs` | statické soubory (brotli/gzip, CSP) + `GET /api/vehicles`, `GET /api/health` |

## Konfigurace (proměnné prostředí)

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | kde poslouchat |
| `FEED_URL` | – | vlastní `spoje-feed` server (`…/duk/traffic`), zkouší se jako první; jinak veřejný zdroj |
| `MOCK` | – | `1` = polohy z jízdního řádu (vývoj) |
| `POLL_S` | `10` | jak často stahovat zdroj |
| `HOLD_MHD_S`, `HOLD_OTHER_S` | `300`, `180` | jak dlouho držet zmizelé vozidlo |
| `DATA_REFRESH_H` | `12` | interval kontroly jízdních řádů a tras v hodinách |
| `GTFS_BASE_URL` | release `gtfs` | odkud brát GTFS |

Mapa běží na MapLibre GL JS (stejný engine jako Android appka, v `public/vendor/`). Styl je CARTO Voyager (světlý) a Dark Matter (tmavý, zesvětlený jako `softenDark()` v appce). API klíč CARTO dej serveru do `CARTO_API_KEY` (stejná hodnota jako v Androidu v `local.properties`); do kódu ani do gitu se nedává. Klíč se prohlížeči posílá v adrese stylu, proto ho v CARTO omez na svou doménu. Bez klíče, nebo když CARTO styl selže, použije se OpenFreeMap (Positron, v tmavém režimu přebarvený). API adresa se mění v `public/js/config.js` (`API_BASE`).

## Nasazení

Nasazení přes Docker včetně aktualizace dat: viz [DEPLOY.md](DEPLOY.md). Lokálně stačí `npm run data && npm start`.
