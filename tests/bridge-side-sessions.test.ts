import { expect, it, vi } from "vitest";
import { Bridge, type SessionManagerLike, type AccessStoreLike } from "../src/runtime/bridge.js";
import type { CodexAdapter, EngineSideSession } from "../src/codex/adapter.js";
import type { TurnPoolLike } from "../src/runtime/turn-pool.js";

const input = { chatId: 84, userId: 42, chatType: "bus", conversationKey: "app:main", workspaceOverride: "/workspace" };
function fixture(botInstructionsPath?: string) {
  const access: AccessStoreLike = { load: vi.fn(), issuePairingCode: vi.fn() };
  const sessions: SessionManagerLike = { getExistingSession: vi.fn(async () => ({ sessionId: "native-parent" })), getOrCreateSession: vi.fn(), bindSession: vi.fn() };
  const side: EngineSideSession = { nativeId: "temporary", send: vi.fn(async () => ({ text: "answer" })), dispose: vi.fn(async () => {}) };
  const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), openSideSession: vi.fn(async () => side) };
  const pool: TurnPoolLike = { run: vi.fn(async task => task()) };
  return { sessions, side, adapter, pool, bridge: new Bridge(access, sessions, adapter, { turnPool: pool, botInstructionsPath }) };
}
it("borrows the native parent without binding, starting or replacing it and uses the shared turn pool", async () => {
  const f = fixture(), handle = await f.bridge.openSideSession(input), controller = new AbortController();
  await handle.send({ text: "question", onEngineEvent: () => {}, abortSignal: controller.signal });
  expect(f.adapter.openSideSession).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "native-parent", workspaceOverride: "/workspace" }));
  expect(f.pool.run).toHaveBeenCalledWith(expect.any(Function), { signal: controller.signal });
  expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled(); expect(f.sessions.bindSession).not.toHaveBeenCalled(); expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendUserMessage).not.toHaveBeenCalled();
  await handle.dispose(); expect(f.side.dispose).toHaveBeenCalledTimes(1);
});
it("does not manufacture a parent when the conversation has no native session", async () => {
  const f = fixture(); vi.mocked(f.sessions.getExistingSession!).mockResolvedValue(null);
  await expect(f.bridge.openSideSession(input)).rejects.toThrow("no_main_session");
  expect(f.adapter.openSideSession).not.toHaveBeenCalled(); expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled();
});
it("disposes an engine handle that arrives after the panel was closed", async () => {
  const f = fixture(), controller = new AbortController();
  vi.mocked(f.adapter.openSideSession!).mockImplementation(async () => { controller.abort(); return f.side; });
  await expect(f.bridge.openSideSession({ ...input, abortSignal: controller.signal })).rejects.toThrow(); expect(f.side.dispose).toHaveBeenCalledTimes(1);
});

it("keeps the Bot file available when a side question uses a shared project", async () => {
  const file = "/bots/alpha/workspace/AGENTS.md", f = fixture(file);
  const handle = await f.bridge.openSideSession(input), controller = new AbortController();
  await handle.send({ text: "Reread your persona", turnInstructions: "Read-only side question", onEngineEvent: () => {}, abortSignal: controller.signal });
  expect(f.side.send).toHaveBeenCalledWith(expect.objectContaining({ turnInstructions: expect.stringContaining(file) }));
  expect(f.side.send).toHaveBeenCalledWith(expect.objectContaining({ turnInstructions: expect.stringContaining("Read-only side question") }));
  expect(f.sessions.bindSession).not.toHaveBeenCalled();
});
