import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { gatewayOperation, type GatewayMaintenance } from "../src/gateway/operations.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { SessionStore } from "../src/state/session-store.js";

it("requires an explicit owning supervisor for restart and sanitizes session titles", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "gateway-ops-"));
  try {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "en" }));
    const options = { stateDir, url: "ws://127.0.0.1:1/instance", botId: "fixture", secret: "unused", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }), listExternalSessions: async () => [{ sessionId: "session_example", cwd: "/workspace", title: "Named\\u0000 session\\nfirst question".replaceAll("\\u0000", "\0").replaceAll("\\n", "\n"), updatedAt: "2026-10-01T00:00:00.000Z" }] } };
    await expect(gatewayOperation("restart", options)).rejects.toThrow("gateway_restart_requires_owning_supervisor");
    const restartWhenIdle = vi.fn(async () => ({ deferred: true, text: "Restart deferred until idle" }));
    const maintenance: GatewayMaintenance = { restartWhenIdle, status: async () => ({ running: true }) };
    expect(await gatewayOperation("restart", options, maintenance)).toEqual({ deferred: true, text: "Restart deferred until idle" }); expect(restartWhenIdle).toHaveBeenCalledTimes(1);
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    for (const [i, key] of ["lark:original", "lark:gw_bound"].entries()) await sessions.upsert({ telegramChatId: i + 1, conversationKey: key, codexSessionId: "session_example", updatedAt: "2026-10-01T00:00:00.000Z", status: "idle" });
    expect(await gatewayOperation("sessions", options)).toEqual([{ id: "session_example", title: "Named  session first question", updatedAt: "2026-10-01T00:00:00.000Z", status: "idle" }]);
    expect(await gatewayOperation("status", options)).toMatchObject({ engine: "claude", activeTurns: 0, queued: 0, approvals: 0 });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
