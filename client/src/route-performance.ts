import type { RouteHealth } from "../../src/client-protocol/routes.js";

export const ROUTE_OBSERVATION_MS = 60_000;
export const ROUTE_DWELL_MS = 300_000;
export const ROUTE_STABLE_PROBE_MS = 120_000;
export const ROUTE_CANDIDATE_PROBE_MS = 30_000;
type Measurement = { latency?: number; successes: number; failures: number; at: number; failedAt?: number; handshake?: number; handshakes?: number; throughput?: number };

/** Ephemeral, per-origin measurements. No route names or IP ranges encode
 * quality; a LAN can be slower than a VPN or relay. Cold samples can select a
 * connection, but cannot alone justify interrupting a working connection. */
export class RoutePerformance {
  private readonly values = new Map<string, Measurement>();
  observe(health: RouteHealth, now: number): void {
    let value = this.values.get(health.url);
    if (!value || now - value.at > 900_000) { value = { successes: 0, failures: 0, at: now }; this.values.set(health.url, value); }
    value.at = now;
    if (health.status === "reachable" || health.status === "cooldown") {
      value.successes++;
      // The first sample includes cold TLS / WireGuard setup; exclude it from
      // the EWMA used for proactive decisions.
      if (value.successes > 1 && health.latency !== undefined) value.latency = value.latency === undefined ? health.latency : value.latency * .7 + health.latency * .3;
    } else { value.failures++; value.successes = 0; value.failedAt = now; }
  }
  failed(url: string, now: number): void { this.observe({ url, status: "unreachable" }, now); }
  connected(url: string, elapsed: number): void {
    const value = this.values.get(url);
    if (value) {
      value.handshakes = (value.handshakes ?? 0) + 1;
      if (value.handshakes > 1) value.handshake = value.handshake === undefined ? elapsed : .7 * value.handshake + .3 * elapsed;
    }
  }
  transferred(url: string, bytes: number, elapsed: number): void {
    const value = this.values.get(url);
    if (value && bytes >= 65536 && elapsed > 0) {
      const speed = bytes * 1000 / elapsed;
      value.throughput = value.throughput === undefined ? speed : .7 * value.throughput + .3 * speed;
    }
  }
  retain(urls: readonly string[]): void { for (const url of this.values.keys()) if (!urls.includes(url)) this.values.delete(url); }
  private penalty(url: string, now: number): number {
    const value = this.values.get(url);
    // A healthy /health does not erase a failed WebSocket or failed transfer.
    return value?.failedAt !== undefined && now - value.failedAt < ROUTE_DWELL_MS ? 1 : 0;
  }
  rank(probes: RouteHealth[], now: number): RouteHealth[] {
    return [...probes].sort((a, b) => this.penalty(a.url, now) - this.penalty(b.url, now)
      || (this.values.get(a.url)?.latency ?? a.latency ?? Infinity) - (this.values.get(b.url)?.latency ?? b.latency ?? Infinity));
  }
  promising(candidate: RouteHealth, current: RouteHealth | undefined, now: number): boolean {
    if (!current || current.status !== "reachable" || candidate.status !== "reachable") return false;
    const a = this.values.get(candidate.url), b = this.values.get(current.url);
    const next = a?.latency ?? candidate.latency, active = b?.latency ?? current.latency;
    if (next === undefined || active === undefined || this.penalty(candidate.url, now) > this.penalty(current.url, now)) return false;
    if (active - next < Math.max(50, active * .3)) return false;
    if (a?.throughput && b?.throughput && a.throughput < b.throughput * .7) return false;
    if (a?.handshake && b?.handshake && a.handshake > b.handshake + 2000) return false;
    return true;
  }
  worthwhile(candidate: RouteHealth, current: RouteHealth | undefined, now: number): boolean {
    if (!this.promising(candidate, current, now)) return false;
    const a = this.values.get(candidate.url), b = this.values.get(current!.url);
    return !!a && !!b && a.successes >= 3 && b.successes >= 3 && a.latency !== undefined && b.latency !== undefined;
  }
}
