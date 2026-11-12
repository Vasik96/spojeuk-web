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

## Ochrana proti DoS/DDoS

Dvě vrstvy omezení počtu požadavků na IP klienta:

1. **Caddy** (`deploy/Caddyfile`, plugin `caddy-ratelimit` se sestavuje v `Dockerfile.caddy`): `/api/*` 120 požadavků za minutu, `/data/*` 30, ostatní 240. Součástí jsou i časové limity proti pomalým klientům (slowloris) a strop velikosti hlaviček a těla požadavku.
2. **Aplikace** (`lib/ratelimit.mjs`): stejné třídy cest, token bucket v paměti. Chrání i nasazení bez Caddy. IPv6 klienti se sdružují po /64. `/api/vehicles` se navíc sestavuje nejvýš jednou za sekundu bez ohledu na počet požadavků.

Odmítnutý požadavek dostane `429 Too Many Requests` s hlavičkou `Retry-After`. Limity v aplikaci jdou změnit přes `RATE_API`, `RATE_DATA`, `RATE_STATIC` (za minutu na IP), `RATE_LIMIT=0` je vypne. V Caddyfile se mění přímo hodnoty `events`.

`TRUST_PROXY` říká, kolik proxy stojí před aplikací (v docker-compose `1`). Bez toho by se všichni klienti počítali pod IP Caddy a sdíleli jeden limit; naopak při hodnotě vyšší, než odpovídá skutečnosti, by šla IP podvrhnout hlavičkou `X-Forwarded-For`. Pokud před Caddy přidáš CDN (např. Cloudflare), nastav v Caddy `trusted_proxies` a `TRUST_PROXY` zvyš o jedna.

Omezení na úrovni aplikace zvládne jednu IP nebo malý počet IP. Skutečný objemový DDoS (zahlcení linky serveru) se na serveru zastavit nedá, to řeší poskytovatel nebo CDN/anti-DDoS před serverem.

Kontrola konfigurace po změně: `docker compose build caddy && docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile`

## Poznámky

- `CARTO_API_KEY` zůstává na serveru; v CARTO ho omez na svou doménu. Bez klíče se použije OpenFreeMap.
- `SERVER_BASE` určuje zdroj `/duk/traffic` a `/dpmul/traffic`.
- Správa železnic může serveru vracet 403; v takovém případě udělá pauzu a ostatní zdroje pokračují.
