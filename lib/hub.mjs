// Zdroj živých poloh pro /api/vehicles: vlastní server (spoje-feed, API v2).
// Server sám dotahuje DPMÚL, DÚK i Správu železnic a vrací už sloučená vozidla (nejčerstvější poloha, doplněné
// údaje, bez "duchů"), takže web nic dalšího nestahuje ani neslučuje a třetí strany nevolá.
export const SERVER_BASE = 'http://37.46.211.70:8787';

const STALE_AFTER_S = 30; // starší odpověď serveru: zdroje se hlásí jako zastaralé a je to výpadek
const DROP_AFTER_S = 180; // po 3 minutách bez odpovědi se polohy zahodí

/** Stáhne /api/vehicles ze serveru [base]. */
export function httpSnapshot(base = SERVER_BASE, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const url = `${String(base).replace(/\/$/, '')}/api/vehicles`;
  return async () => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.vehicles)) throw new Error('odpověď nemá pole vehicles');
    return data;
  };
}

const empty = (t) => ({ time: t, vehicles: [], held: 0, outage: true, upstreamAgeSec: null, pollSec: 10, source: 'žádný', sources: [] });

export class Hub {
  /** @param fetchSnapshot  async () => odpověď /api/vehicles (výchozí: HTTP dotaz na [base]) */
  constructor({ fetchSnapshot, base = SERVER_BASE, pollMs = 3000, now = () => Date.now() } = {}) {
    this.fetchSnapshot = fetchSnapshot || httpSnapshot(base);
    this.pollMs = pollMs;
    this.now = now;
    this.data = null; this.lastOk = 0; this.failures = 0; this.lastError = '';
    this._inflight = null; this._lastPollAt = 0; this._running = false; this._timer = null;
  }

  async pollOnce() {
    try {
      this.data = await this.fetchSnapshot();
      this.lastOk = this.now(); this.failures = 0; this.lastError = '';
    } catch (e) {
      this.failures++; this.lastError = String(e?.message || e);
    }
  }

  /** Smyčka na pozadí (lokální provoz). Na Cloud Run se místo ní volá [refresh] při požadavku. */
  start() {
    if (this._running) return;
    this._running = true;
    (async () => {
      while (this._running) {
        await this.pollOnce();
        await new Promise((r) => { this._timer = setTimeout(r, this.pollMs); this._timer.unref?.(); });
      }
    })();
  }

  stop() { this._running = false; clearTimeout(this._timer); }

  /** Obnoví data, když jsou starší než [pollMs] (jeden dotaz naráz), a počká nejvýš [maxWaitMs]. */
  async refresh(maxWaitMs = 4000) {
    const t = this.now();
    if (!this._inflight && t - this._lastPollAt >= this.pollMs) {
      this._lastPollAt = t;
      this._inflight = this.pollOnce().finally(() => { this._inflight = null; });
    }
    if (this._inflight) await Promise.race([this._inflight, new Promise((r) => setTimeout(r, maxWaitMs).unref?.())]);
  }

  /** Poslední odpověď serveru; stáří poloh roste o dobu, která uplynula od jejího stažení. */
  snapshot() {
    const t = this.now();
    if (!this.data) return empty(t);
    const d = this.data;
    const age = Math.max(0, Math.floor((t - this.lastOk) / 1000));
    if (age > DROP_AFTER_S) return { ...empty(t), error: this.lastError || null };
    const stale = age > STALE_AFTER_S;
    return {
      ...d,
      time: t,
      vehicles: age ? d.vehicles.map((v) => ({ ...v, ageSec: (v.ageSec || 0) + age })) : d.vehicles,
      outage: !!d.outage || stale,
      upstreamAgeSec: d.upstreamAgeSec == null ? null : d.upstreamAgeSec + age,
      sources: stale ? (d.sources || []).map((s) => (s.health === 'live' ? { ...s, health: 'stale' } : s)) : d.sources || [],
      ...(stale ? { error: this.lastError || null } : {}),
    };
  }
}
