import { routeNameSchema, routeSchema, routesSchema, type Route } from "../client-protocol/routes.js";
import { createHash } from "node:crypto";
import { request } from "node:https";
import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import type { HubStore } from "./store.js";
import { certificateAuthority } from "./network-peer.js";

export const monitoredRouteSchema = routeSchema;
export const routeMonitorSchema = z.object({ routes: routesSchema, botId: idSchema, conversationId: idSchema }).strict();
export const routeAlertSchema = z.object({ id: idSchema, route: routeNameSchema, label: z.string().max(40).optional(), url: z.string().url().optional(), since: z.number().int().nonnegative(), text: z.string().max(1000) }).strict();
export type RouteAlert = z.infer<typeof routeAlertSchema>;
export type RouteMonitorConfig = z.infer<typeof routeMonitorSchema>;
const stateSchema = z.record(z.string(), z.object({ since: z.number(), hub: z.boolean(), feishu: z.boolean() }));
const FAILURE_THRESHOLD_MS = 5 * 60_000;
/** Trust only this route's explicit CA, retaining hostname verification. This
 * is an availability probe, not the signed identity proof used for pairing. */
function privateRouteHealth(route: Route): Promise<unknown> {
  const ca = certificateAuthority(route);
  return new Promise((resolve, reject) => {
    const req = request(`${route.url.replace(/\/$/, "")}/health`, { ca, signal: AbortSignal.timeout(2000), agent: false }, res => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy(); reject(new Error("route_health_status")); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) req.destroy(new Error("route_health_too_large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("route_health_aborted")));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end();
  });
}
export class RouteMonitor {
  private timer?: ReturnType<typeof setInterval>; private pending?: Promise<void>; private stopped = false;
  constructor(private store: HubStore, private config: RouteMonitorConfig, private hubPublicKey: string, private notifyFeishu: (botId: string, alert: RouteAlert) => Promise<void>, private probe: (url: string, route: Route) => Promise<boolean> = async (url, route) => {
    if (route.certificateAuthority && new URL(route.url).protocol === "https:") {
      const result = z.object({ ok: z.literal(true), publicKey: z.string() }).parse(await privateRouteHealth(route));
      return result.publicKey === this.hubPublicKey;
    }
    const response = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2000), redirect: "error", cache: "no-store" });
    const result = z.object({ ok: z.literal(true), publicKey: z.string() }).parse(await response.json()); return response.ok && result.publicKey === this.hubPublicKey;
  }, private now: () => number = Date.now, private warning: (code: string) => void = () => undefined) {}
  start(): void { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => this.warning("route_monitor_failed")); }, 15_000); this.timer.unref(); void this.tick().catch(() => this.warning("route_monitor_failed")); }
  tick(): Promise<void> { if (this.pending) return this.pending; this.pending = this.check().finally(() => { this.pending = undefined; }); return this.pending; }
  private async check(): Promise<void> {
    const key = "route_monitor"; const previous = await this.store.db.serial(() => this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]));
    const state = stateSchema.parse(previous ? JSON.parse(previous.value) : {});
    const persist = () => this.store.db.serial(() => this.store.db.run("INSERT OR REPLACE INTO meta VALUES(?,?)", [key, JSON.stringify(state)]));
    const results = await Promise.all(this.config.routes.map(async (route) => ({ route, online: await this.probe(route.url, route).catch(() => false) })));
    if (this.stopped) return;
    for (const { route, online } of results) {
      const routeKey = `${route.name}:${route.url}`;
      if (online) { delete state[routeKey]; continue; }
      const outage = state[routeKey] ??= { since: this.now(), hub: false, feishu: false };
      if (this.now() - outage.since < FAILURE_THRESHOLD_MS) continue;
      const id = `route_${createHash("sha256").update(`${routeKey}:${outage.since}`).digest("hex")}`;
      const alert: RouteAlert = { id, route: route.name, ...(route.label ? { label: route.label } : {}), url: route.url, since: outage.since, text: `TaroBird：${route.label ?? route.name}（${route.url.slice(0, 300)}） 线路已连续故障超过 5 分钟。请检查网络、证书和中转服务；可用线路上的会话仍会自动同步。` };
      if (!outage.hub) {
        await this.store.publishBotMessage(this.config.botId, { id, conversationId: this.config.conversationId, blocks: [{ type: "text", text: alert.text }], status: "error", version: 1 });
        outage.hub = true; await persist(); await this.store.audit("route.failed", "hub", { route: route.name, url: route.url, since: outage.since });
      }
      if (!outage.feishu) {
        try { await this.notifyFeishu(this.config.botId, alert); outage.feishu = true; await persist(); }
        catch { this.warning("route_alert_delivery_pending"); }
      }
    }
    for (const stored of Object.keys(state)) if (!this.config.routes.some((route) => stored === `${route.name}:${route.url}`)) delete state[stored];
    await persist();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.pending; }
}
