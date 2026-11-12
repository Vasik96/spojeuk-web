// Omezení počtu požadavků na klienta (ochrana proti DoS). V paměti, bez závislostí.
//
// Každý klient (IP) má „kyblík“ žetonů: jeden požadavek = jeden žeton, žetony se průběžně doplňují.
// Krátká dávka požadavků projde hned (načtení stránky), trvalý nadlimitní provoz dostane 429.
import net from 'node:net';

export class RateLimiter {
  /**
   * @param perMin  kolik požadavků za minutu klient trvale smí
   * @param burst   kolik jich smí přijít naráz (velikost kyblíku)
   * @param maxKeys horní mez počtu sledovaných klientů, aby si útočník s mnoha adresami nevynutil neomezenou paměť
   */
  constructor({ perMin, burst = Math.max(5, Math.round(perMin / 2)), maxKeys = 50_000, now = Date.now }) {
    if (!(perMin > 0)) throw new Error('perMin musí být kladné číslo');
    this.rate = perMin / 60_000; // žetonů za milisekundu
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map(); // klíč → { tokens, t }; pořadí v Map je pořadí posledního použití
  }

  /** @returns {{ok: true} | {ok: false, retryAfterSec: number}} */
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // vložíme znovu na konec, ať nejstarší záznamy zůstanou na začátku
      b.tokens = Math.min(this.burst, b.tokens + (t - b.t) * this.rate);
      b.t = t;
    } else {
      b = { tokens: this.burst, t };
    }
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    return ok ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.rate / 1000)) };
  }
}

const stripV4Mapped = (ip) => ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
const normalize = (ip) => stripV4Mapped(String(ip).trim().replace(/^\[|\]$/g, '').replace(/%.*$/, ''));

/**
 * IP klienta. `trustProxy` je počet proxy před aplikací (Caddy = 1). Při 0 se hlavičky X-Forwarded-For
 * ignorují, takže je klient nemůže podvrhnout. Při N > 0 se bere N-tá položka zprava, tedy ta, kterou
 * připsala nejbližší důvěryhodná proxy; to, co poslal klient, je v seznamu vlevo a nikdy se nepoužije.
 */
export function clientIp(req, trustProxy = 0) {
  const peer = normalize(req.socket?.remoteAddress || '');
  if (trustProxy > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cand = hops[hops.length - trustProxy];
    if (cand && net.isIP(normalize(cand))) return normalize(cand);
  }
  return peer;
}

function expandV6(ip) {
  let s = ip;
  const m = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/); // IPv4 na konci (např. 64:ff9b::1.2.3.4)
  if (m) s = `${m[1]}${((m[2] << 8) | m[3]).toString(16)}:${((m[4] << 8) | m[5]).toString(16)}`;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : Math.max(0, 8 - h.length - t.length);
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Klíč klienta. IPv6 se sdružuje po /64 (jedno připojení dostává celou /64, jinak by útočník střídal adresy). */
export function ipKey(ip) {
  if (net.isIPv6(ip)) return `${expandV6(ip).slice(0, 4).join(':')}::/64`;
  return ip || 'unknown';
}

/** Třída cesty: každá má vlastní limit, protože stojí server různě moc. */
export function routeClass(pathname) {
  if (pathname.startsWith('/api/')) return 'api';
  if (pathname.startsWith('/data/')) return 'data'; // velké soubory (jízdní řády, trasy): hlavně šířka pásma
  return 'static';
}

/**
 * Limity z prostředí (požadavků za minutu na klienta). RATE_LIMIT=0 vypne všechno.
 *   RATE_API=120     /api/*   (mapa se ptá každých 8 s, tedy ~8/min na záložku)
 *   RATE_DATA=30     /data/*  (timetable.json a shapes.bin se při každém načtení stránky stahují znovu)
 *   RATE_STATIC=240  zbytek (HTML, JS, CSS, obrázky; studená načtení má kolem 25 souborů)
 */
export function createLimits(env = process.env, now = Date.now) {
  if (env.RATE_LIMIT === '0') return null;
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    api: new RateLimiter({ perMin: num(env.RATE_API, 120), now }),
    data: new RateLimiter({ perMin: num(env.RATE_DATA, 30), now }),
    static: new RateLimiter({ perMin: num(env.RATE_STATIC, 240), now }),
  };
}
