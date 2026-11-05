import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeTurnRecovery } from "../src/codex/claude-turn-recovery.js";
import { JsonStore } from "../src/state/json-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const receipt = { startedAt: 1000, stoppedAt: 20_000, toolCalls: 2, toolResults: 1, pendingTools: ["Bash"] };
describe("Claude interrupted-turn receipts", () => {
  it("keeps in-memory facts usable when optional persistence never completes", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(JsonStore.prototype, "read").mockResolvedValue({ version: 1, entries: [] });
    const write = vi.spyOn(JsonStore.prototype, "write").mockReturnValue(new Promise(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new ClaudeTurnRecovery("/unused/receipt.json");
      store.remember("native", undefined, receipt);
      let facts: string | undefined;
      void store.instructions("native").then(value => { facts = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(facts).toContain('"toolCallsObserved":2');
      store.clear("native");
      let cleared = false;
      void store.instructions("native").then(value => { cleared = value === undefined; });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toBe(true);
      let flushed = false;
      void store.flush().then(() => { flushed = true; });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(flushed).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); warn.mockRestore(); vi.useRealTimers(); }
  });
  it("bounds initial loading and ignores late disk data instead of replacing newer memory", async () => {
    vi.useFakeTimers();
    let finishRead!: (value: unknown) => void;
    const read = vi.spyOn(JsonStore.prototype, "read").mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    const write = vi.spyOn(JsonStore.prototype, "write").mockResolvedValue();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new ClaudeTurnRecovery("/unused/receipt.json");
      store.remember("native", undefined, receipt);
      let facts: string | undefined;
      void store.instructions("native").then(value => { facts = value; });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(facts).toContain('"toolCallsObserved":2');
      finishRead({ version: 1, entries: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(await store.instructions("native")).toContain('"toolCallsObserved":2');
      expect(write).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); warn.mockRestore(); vi.useRealTimers(); }
  });
  it("persists the latest cleared state after an earlier write finishes", async () => {
    let finishWrite!: () => void;
    const read = vi.spyOn(JsonStore.prototype, "read").mockResolvedValue({ version: 1, entries: [] });
    const write = vi.spyOn(JsonStore.prototype, "write")
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }))
      .mockResolvedValue(undefined);
    try {
      const store = new ClaudeTurnRecovery("/unused/receipt.json");
      store.remember("native", undefined, receipt);
      await store.instructions("native");
      store.clear("native");
      expect(await store.instructions("native")).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
      finishWrite();
      await store.flush();
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[0][0]).toMatchObject({ entries: [expect.objectContaining({ toolCalls: 2 })] });
      expect(write.mock.calls[1][0]).toEqual({ version: 1, entries: [] });
    } finally { read.mockRestore(); write.mockRestore(); }
  });
  it("retains unreadable future-format receipts on disk while using a memory fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-recovery-future-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const file = path.join(root, "future.json");
      const contents = '{"version":2,"entries":[],"futureField":"preserve"}';
      await writeFile(file, contents);
      const store = new ClaudeTurnRecovery(file);
      store.remember("native", undefined, receipt);
      expect(await store.instructions("native")).toContain("toolCallsObserved");
      await store.flush();
      expect(await readFile(file, "utf8")).toBe(contents);
    } finally { warn.mockRestore(); await removeTempRoot(root); }
  });
  it("survives restart, isolates session/workspace/Bot and clears after completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-recovery-"));
    try {
      const file = path.join(root, "recovery.json");
      const store = new ClaudeTurnRecovery(file);
      store.remember("native-A", "/workspace/A", receipt);
      await store.flush();
      const restarted = new ClaudeTurnRecovery(file);
      expect(await restarted.instructions("native-A", "/workspace/A")).toContain('"toolsWithoutResultsSample":["Bash"]');
      expect(await restarted.instructions("native-A", "/workspace/A")).toContain("not a new user request");
      expect(await restarted.instructions("native-B", "/workspace/A")).toBeUndefined();
      expect(await restarted.instructions("native-A", "/workspace/B")).toBeUndefined();
      expect(await new ClaudeTurnRecovery(path.join(root, "other-bot.json")).instructions("native-A", "/workspace/A")).toBeUndefined();
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      restarted.clear("native-A", "/workspace/A");
      await restarted.flush();
      expect(await new ClaudeTurnRecovery(file).instructions("native-A", "/workspace/A")).toBeUndefined();
      const persisted = await readFile(file, "utf8");
      expect(persisted).not.toContain("native-A");
      expect(persisted).not.toContain("/workspace/A");
    } finally { await removeTempRoot(root); }
  });
  it("bounds stored sessions and preserves mutation ordering without recreating a cleared receipt", async () => {
    const store = new ClaudeTurnRecovery();
    for (let i = 0; i < 70; i++) store.remember(`session-${i}`, undefined, receipt);
    expect(await store.instructions("session-0")).toBeUndefined();
    expect(await store.instructions("session-69")).toContain("toolCallsObserved");
    store.remember("same", undefined, receipt);
    store.clear("same");
    store.remember("same", undefined, { ...receipt, pendingTools: ["Read"] });
    expect(await store.instructions("same")).toContain('"Read"');
  });
  it("does not let damaged or unwritable optional receipts block a user prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-recovery-errors-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const file = path.join(root, "bad.json");
      await writeFile(file, '{"version":1,"entries":[{"key":"malicious"}]}');
      expect(await new ClaudeTurnRecovery(file).instructions("native")).toBeUndefined();
      const store = new ClaudeTurnRecovery(path.join(file, "not-a-directory.json"));
      store.remember("native", undefined, receipt);
      expect(await store.instructions("native")).toContain("toolCallsObserved");
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); await removeTempRoot(root); }
  });
});
