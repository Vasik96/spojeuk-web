# Nasazení Dockerem

Webový frontend, API, jízdní řády i trasy běží v jednom kontejneru. Caddy před ním zajišťuje HTTPS.

## První spuštění

Potřebuješ Docker s `docker compose`, doménu nasměrovanou na IP serveru a volné porty 80 a 443.

```bash
cp .env.example .env
nano .env                      # DOMAIN, CARTO_API_KEY, případně SERVER_BASE
docker compose up -d --build
curl https://TVOJE-DOMENA/api/health
```

Jízdní řády a trasy se stáhnou během sestavení Docker image. Pokud image nemá data, server se je pokusí stáhnout i při prvním spuštění.

## Aktualizace

- **Aplikace nebo server:** `docker compose up -d --build`
- **Jízdní řády a trasy:** server je kontroluje každých 12 hodin při požadavku na stránku nebo API. Interval lze upravit přes `DATA_REFRESH_H`; hodnota `0` automatickou kontrolu vypne.
- **Vynucená aktualizace dat hned:** spusť příkaz uvnitř běžícího kontejneru, potom server restartuj:

  ```bash
  docker compose exec web node scripts/build-data.mjs
  docker compose restart web
  ```

`npm run data` na hostiteli není potřeba. Příkaz uvnitř kontejneru stáhne aktuální jízdní řády i soubory tras z release `spojeuk-data`.

Bez Dockeru lze server spustit na Node.js 22.5+: `npm run data && npm start`.

## Poznámky

- `CARTO_API_KEY` zůstává na serveru; v CARTO ho omez na svou doménu. Bez klíče se použije OpenFreeMap.
- `SERVER_BASE` určuje zdroj `/duk/traffic` a `/dpmul/traffic`.
- Správa železnic může serveru vracet 403; v takovém případě udělá pauzu a ostatní zdroje pokračují.
