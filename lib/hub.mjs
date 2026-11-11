// Spojuje všechny zdroje poloh do jedné odpovědi pro /api/vehicles.
import { fuse, baseVehicleId } from './fusion.mjs';
import { dedupeByUid } from '../public/js/util.js';

/** Stabilní klíč vozu napříč zdroji (ID se mezi DPMÚL a DÚK liší předponou 30). */
export function uidOf(v) {
  if (v.train && v.cis) return `t${String(v.cis).trim().replace(/^0+/, '')}`;
  if (v.id) return `v${baseVehicleId(v.id)}`;
  return `p${v.lat.toFixed(4)},${v.lng.toFixed(4)}`;
}

export class Hub {
  constructor(sources, { now = () => Date.now() } = {}) { this.sources = sources; this.now = now; }
  /** Smyčky na pozadí (lokální provoz). Na Cloud Run se místo nich volá [refresh] při požadavku. */
  start() { this.sources.forEach((s) => s.start()); }

  /**
   * Obnoví zdroje, které jsou starší než jejich interval (jeden dotaz na zdroj naráz) a počká nejvýš [maxWaitMs].
   * Díky tomu nic neběží na pozadí, dokud někdo mapu neotevře (hodí se pro serverless s omezeným CPU
   * a šetří to i zdroje, hlavně Správu železnic).
   */
  async refresh(maxWaitMs = 4000) {
    const t = this.now();
    for (const s of this.sources) {
      if (s._inflight || t - (s._lastPollAt || 0) < s.pollMs) continue;
      s._lastPollAt = t;
      s._inflight = Promise.resolve(s.pollOnce()).catch(() => {}).finally(() => { s._inflight = null; });
    }
    const pending = this.sources.map((s) => s._inflight).filter(Boolean);
    if (pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, maxWaitMs).unref?.())]);
  }

  stop() { this.sources.forEach((s) => s.stop()); }

  /** Zdroj, který se ještě nikdy nezapojil, se nepočítá do výpadku (např. SŽ bez odpovědi). */
  snapshot() {
    const t = this.now();
    const reports = this.sources.map((s) => s.snapshot());
    const vehicles = dedupeByUid(fuse(reports).map((v) => ({ ...v, uid: uidOf(v) })), (v) => v.uid);
    const live = reports.filter((r) => r.health === 'live' && r.vehicles.length).sort((a, b) => a.priority - b.priority);
    const duk = this.sources.find((s) => s.id === 'duk');
    const dukOutage = duk ? !!duk.outage : false;
    const anyOk = reports.some((r) => r.health !== 'down');
    return {
      time: t, vehicles,
      held: reports.reduce((n, r) => n + r.held, 0),
      outage: dukOutage || !anyOk,
      upstreamAgeSec: duk && duk.lastOk ? Math.floor((t - duk.lastOk) / 1000) : null,
      pollSec: 10,
      source: live.length ? live.map((r) => r.name).join(', ') : 'žádný',
      sources: reports.map((r) => ({ id: r.id, name: r.name, priority: r.priority, health: r.health, vehicles: r.vehicles.length, failures: r.failures, lastError: r.lastError })),
    };
  }
}
