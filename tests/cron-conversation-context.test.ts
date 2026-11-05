import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { deliverCoreResponse } from "../src/core/delivery.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { Bridge } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { CronStore } from "../src/state/cron-store.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

it.each([
  ["feishu", "reuse"], ["feishu", "new_per_run"], ["gateway", "reuse"], ["gateway", "new_per_run"],
] as const)("keeps %s scheduled %s turns and file delivery in their resumed conversation workspace", async (profile, sessionMode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-conversation-context-"));
  try {
    const stateDir = path.join(root, "bot"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    const sessions = new SessionStore(path.join(stateDir, "session.json")), store = new CronStore(stateDir);
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(async (_sessionId, input) => ({ text: `[send-file:${path.join(input.workspaceOverride ?? stateDir, "report.txt")}]` })),
    };
    const bridge = new Bridge({} as never, new SessionManager(sessions, adapter), adapter).createAuthenticatedSurface();
    const send = vi.fn(async (_chatId: string, _content: unknown) => ({ messageId: "cron_result" }));
    const executor = buildCoreCronExecutor({ stateDir, channel: { profile, send, stream: vi.fn(), downloadResource: vi.fn() }, bridge, runtime: createCoreServiceRuntime(), deliverResponse: deliverCoreResponse });
    for (const name of ["first", "second"]) {
      const workspace = path.join(root, `external-${name}`), chatId = profile === "gateway" ? `gw_${name}` : `oc_${name}`, key = `lark:${chatId}`;
      await mkdir(workspace); await writeFile(path.join(workspace, "report.txt"), `report from ${name}`);
      await sessions.upsert({ telegramChatId: name === "first" ? 1 : 2, conversationKey: key, codexSessionId: `native_${name}`,
        resume: { sessionId: `native_${name}`, dirName: name, workspacePath: workspace }, status: "idle", updatedAt: new Date().toISOString() });
      const job = await store.add({ channel: "lark", chatId: name === "first" ? 1 : 2, userId: 3, larkChatId: chatId, conversationKey: key,
        cronExpr: "0 9 * * *", prompt: "Send the project report", sessionMode, deliveryMode: "agent" });
      await withChannelProfile(profile, () => executor(job));
      expect(adapter.sendUserMessage).toHaveBeenLastCalledWith(sessionMode === "reuse" ? `native_${name}` : expect.stringMatching(/^tarobot-cron-/), expect.objectContaining({ workspaceOverride: workspace }));
      expect(send.mock.calls.some(([target, content]) => target === chatId && (content as { file?: { source: Buffer } }).file?.source.equals(Buffer.from(`report from ${name}`)))).toBe(true);
      expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe(`native_${name}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports scheduled execution start only after the real conversation queue admits it", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cron-queue-admission-"));
  const runtime = createCoreServiceRuntime();
  let release!: () => void;
  const blocking = runtime.chatQueue.enqueue("lark:gw_scheduled", () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    const store = new CronStore(stateDir);
    const job = await store.add({ channel: "lark", chatId: 1, userId: 2, larkChatId: "gw_scheduled", conversationKey: "lark:gw_scheduled", cronExpr: "0 9 * * *", prompt: "Test", deliveryMode: "agent" });
    const start = vi.fn(async () => {}), defer = vi.fn(() => start);
    const run = vi.fn(async () => ({ text: "done" }));
    const execute = buildCoreCronExecutor({ stateDir, runtime, bridge: { handleAuthorizedMessage: run }, channel: { profile: "gateway", send: vi.fn(async () => ({ messageId: "reply" })), stream: vi.fn(), downloadResource: vi.fn() } });
    const pending = withChannelProfile("gateway", () => execute(job, undefined, { deferTimeoutUntilStarted: defer }));
    await vi.waitFor(() => expect(runtime.chatQueue.pendingCount("lark:gw_scheduled")).toBe(1));
    expect(defer).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    release(); await Promise.all([blocking, pending]);
    expect(start).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  } finally { release?.(); await blocking; await rm(stateDir, { recursive: true, force: true }); }
});
