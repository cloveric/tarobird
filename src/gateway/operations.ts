import { readBotCapabilities } from "../runtime/bot-capabilities.js";
import path from "node:path";
import { z } from "zod";
import { readBotDashboard, readDashboardUsage } from "../runtime/bot-dashboard.js";
import type { Json } from "../client-protocol/index.js";
import { redactSecrets } from "../runtime/secret-redaction.js";
import { SessionStore } from "../state/session-store.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import type { GatewayServiceOptions } from "./service.js";

export interface GatewayMaintenance { restartWhenIdle(): Promise<Json>; status(): Promise<Json> }
export async function gatewayOperation(method: string, options: GatewayServiceOptions, maintenance?: GatewayMaintenance): Promise<Json> {
  const clean = (text: string) => redactSecrets(text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")).slice(0, 200);
  if (method === "capabilities") return z.json().parse(await readBotCapabilities(options.stateDir));
  if (method === "dashboard") {
    const runtime = options.runtime;
    return z.json().parse(await readBotDashboard(options.stateDir, {
      sampledAt: new Date().toISOString(), activeCount: runtime.activeRuns.size,
      active: [...runtime.activeRuns].map(([conversation, run]) => ({ conversation: clean(conversation), startedAt: run.startedAt && Number.isFinite(new Date(run.startedAt).getTime()) ? new Date(run.startedAt).toISOString() : null })),
      queued: runtime.queueCards.size, approvals: runtime.pendingApprovals.size, batches: runtime.pendingBatches.size,
      choices: [...runtime.choiceCards.values()].filter((card) => card.status === "active").length,
      schedulerAvailable: !!runtime.cronRuntime,
    }));
  }
  if (method === "sessions") {
    const records = (await new SessionStore(path.join(options.stateDir, "session.json")).load()).chats;
    const external = await options.bridge.listExternalSessions?.({ limit: 100 }).catch(() => []) ?? [];
    const named = new Map(external.map((s) => [s.sessionId, s])); const seen = new Set<string>();
    return records.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter((s) => { if (seen.has(s.codexSessionId)) return false; seen.add(s.codexSessionId); return true; }).slice(0, 100).map((s) => ({ id: s.codexSessionId, title: clean(named.get(s.codexSessionId)?.title || s.conversationKey || s.codexSessionId), updatedAt: s.updatedAt, status: s.status }));
  }
  if (method === "status") {
    const config = await loadInstanceConfig(options.stateDir); const usage = await readDashboardUsage(options.stateDir);
    return z.json().parse({ engine: config.engine, model: config.model ?? "", effort: config.effort ?? "", activeTurns: options.runtime.activeRuns.size, queued: options.runtime.queueCards.size, approvals: options.runtime.pendingApprovals.size, uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage().rss, usage: usage?.total ?? null, usageSource: usage?.source ?? null });
  }
  if (method === "service.status") return maintenance ? maintenance.status() : { running: true, managed: false, pid: process.pid, text: "Connected Gateway; lifecycle is owned by its supervisor." };
  if (method === "restart") {
    if (!maintenance) throw new Error("gateway_restart_requires_owning_supervisor");
    return maintenance.restartWhenIdle();
  }
  throw new Error("unknown_gateway_operation");
}
