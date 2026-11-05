import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessionUsage } from "../src/codex/claude-session-usage.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { JsonStore } from "../src/state/json-store.js";

let root: string;
let file: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "claude-session-usage-")); file = path.join(root, "claude-session-usage.json"); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

type Options = { sessionId?: string; workspace?: string; resultId?: string; freshLedger?: boolean };
const cost = async (usage: ClaudeSessionUsage, totalCostUsd: unknown, options: Options = {}) =>
  (await usage.recordResult({ sessionId: options.sessionId ?? "native-1", workspace: options.workspace ?? "/work/a", totalCostUsd, resultId: options.resultId, freshLedger: options.freshLedger ?? false })).costUsd;

describe.each([["memory", false], ["durable file", true]])("ClaudeSessionUsage (%s)", (_label, durable) => {
  const make = () => new ClaudeSessionUsage(durable ? file : undefined);

  it("records each result's increase for a session the CLI created in this process", async () => {
    const usage = make();
    expect(await cost(usage, 0.0045, { freshLedger: true })).toBe(0.0045);
    expect(await cost(usage, 0.009)).toBe(0.0045);
  });

  it("never treats an unknown resumed session's cumulative total as this turn's cost", async () => {
    const usage = make();
    expect(await cost(usage, 327.64)).toBeUndefined();
    expect(await cost(usage, 327.65)).toBe(0.01);
  });

  it("a failed result after earlier spend adds only its own increase, then success continues from it", async () => {
    const usage = make();
    expect(await cost(usage, 0.0045, { freshLedger: true })).toBe(0.0045);
    expect(await cost(usage, 0.0045)).toBe(0);
    expect(await cost(usage, 0.009)).toBe(0.0045);
  });

  it("keys baselines by native session and workspace", async () => {
    const usage = make();
    expect(await cost(usage, 0.009, { freshLedger: true, workspace: "/work/a" })).toBe(0.009);
    expect(await cost(usage, 0.0135, { workspace: "/work/b" })).toBeUndefined();
    expect(await cost(usage, 0.018, { workspace: "/work/b" })).toBe(0.0045);
    expect(await cost(usage, 0.0135, { workspace: "/work/a/../a" })).toBe(0.0045);
    expect(await cost(usage, 0.5, { sessionId: "native-2" })).toBeUndefined();
  });

  it("keeps the high-water mark, so a rollback and return never charge the interval again", async () => {
    const usage = make();
    expect(await cost(usage, 0.01, { freshLedger: true })).toBe(0.01);
    expect(await cost(usage, 0.004)).toBeUndefined();
    expect(await cost(usage, 0.01)).toBe(0);
    expect(await cost(usage, 0.012)).toBe(0.002);
  });

  it("ignores late or repeated frames, not only adjacent duplicates", async () => {
    const usage = make();
    expect(await cost(usage, 0.004, { freshLedger: true, resultId: "r-1" })).toBe(0.004);
    expect(await cost(usage, 0.006, { resultId: "r-2" })).toBe(0.002);
    expect(await cost(usage, 0.004, { resultId: "r-1" })).toBe(0); // late repeat of an old frame
    expect(await cost(usage, 0.005, { resultId: "r-old" })).toBeUndefined(); // late lower frame, new id
    expect(await cost(usage, 0.007, { resultId: "r-3" })).toBe(0.001);
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -0.01, "0.1"])("treats total %s as unknown without moving the baseline", async (total) => {
    const usage = make();
    expect(await cost(usage, 0.004, { freshLedger: true })).toBe(0.004);
    expect(await cost(usage, total)).toBeUndefined();
    expect(await cost(usage, 0.006)).toBe(0.002);
  });
});

describe("ClaudeSessionUsage durability", () => {
  it("persists baselines across a host restart and stores only hashed keys", async () => {
    expect(await cost(new ClaudeSessionUsage(file), 0.009, { freshLedger: true })).toBe(0.009);
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain("native-1");
    expect(stored).not.toContain("/work/a");
    expect(await cost(new ClaudeSessionUsage(file), 0.0135)).toBe(0.0045);
  });

  it("releases a cost only after its baseline is durably written", async () => {
    const order: string[] = [];
    const write = JsonStore.prototype.write;
    vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (this: JsonStore<unknown>, value) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await write.call(this, value);
      order.push("baseline durable");
    });
    const usage = new ClaudeSessionUsage(file);
    const released = cost(usage, 0.004, { freshLedger: true }).then((value) => { order.push(`cost ${value}`); });
    await released;
    expect(order).toEqual(["baseline durable", "cost 0.004"]);
  });

  it("a failed write releases no cost and leaves the old baseline, so the interval is charged once later", async () => {
    const usage = new ClaudeSessionUsage(file);
    expect(await cost(usage, 0.004, { freshLedger: true })).toBe(0.004);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(new Error("disk full"));
    expect(await cost(usage, 0.006)).toBeUndefined();
    expect(await cost(usage, 0.009)).toBe(0.005);
    expect(await cost(new ClaudeSessionUsage(file), 0.009)).toBe(0); // the restart sees the stored high water
  });

  it("a stalled transaction gives up without moving the baseline past an unreleased cost", async () => {
    const usage = new ClaudeSessionUsage(file, 50);
    expect(await cost(usage, 0.004, { freshLedger: true })).toBe(0.004);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let releaseRead!: () => void;
    const read = JsonStore.prototype.read;
    vi.spyOn(JsonStore.prototype, "read").mockImplementationOnce(async function (this: JsonStore<unknown>, fallback) {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return await read.call(this, fallback);
    });
    expect(await cost(usage, 0.006)).toBeUndefined();
    releaseRead();
    await usage.flush();
    expect(await cost(new ClaudeSessionUsage(file), 0.009)).toBe(0.005);
  });

  it("a write that lands after the caller gave up can only drop that cost, never charge it twice", async () => {
    const usage = new ClaudeSessionUsage(file, 50);
    expect(await cost(usage, 0.004, { freshLedger: true })).toBe(0.004);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const write = JsonStore.prototype.write;
    vi.spyOn(JsonStore.prototype, "write").mockImplementationOnce(async function (this: JsonStore<unknown>, value) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await write.call(this, value);
    });
    expect(await cost(usage, 0.006)).toBeUndefined();
    await usage.flush();
    expect(await cost(usage, 0.009)).toBe(0.003);
  });

  it("two adapters on the same ledger never lose each other's baselines", async () => {
    const first = new ClaudeSessionUsage(file), second = new ClaudeSessionUsage(file);
    expect(await cost(first, 0.004, { freshLedger: true })).toBe(0.004);
    expect(await cost(second, 0.006)).toBe(0.002);
    expect(await cost(first, 0.009)).toBe(0.003);
    const results = await Promise.all([
      cost(first, 0.001, { sessionId: "native-a", freshLedger: true }),
      cost(second, 0.002, { sessionId: "native-b", freshLedger: true }),
      cost(first, 0.012),
      cost(second, 0.012),
    ]);
    expect(results.slice(0, 2)).toEqual([0.001, 0.002]);
    expect(results.slice(2).sort()).toEqual([0, 0.003]); // the same cumulative total is charged once
    const reloaded = new ClaudeSessionUsage(file);
    expect(await cost(reloaded, 0.002, { sessionId: "native-a" })).toBe(0.001);
    expect(await cost(reloaded, 0.003, { sessionId: "native-b" })).toBe(0.001);
  });

  it("sets a corrupt cache aside without echoing it and keeps persisting new sessions", async () => {
    await writeFile(file, '{"version":1,"entries":[{"key":"native-secret-session","totalCostUsd":1}');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = new ClaudeSessionUsage(file);
    expect(await cost(usage, 0.2)).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("native-secret-session");
    expect((await readdir(root)).some((name) => name.includes(".corrupt.") && name.endsWith(".bak"))).toBe(true);
    expect(await cost(usage, 0.003, { sessionId: "native-new", freshLedger: true })).toBe(0.003);
    expect(await cost(new ClaudeSessionUsage(file), 0.005, { sessionId: "native-new" })).toBe(0.002);
  });

  it("never overwrites state it cannot interpret, and releases no cost meanwhile", async () => {
    const newer = JSON.stringify({ schemaVersion: 999, version: 2, entries: [] });
    await writeFile(file, newer);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await cost(new ClaudeSessionUsage(file), 0.004, { freshLedger: true })).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(newer);
  });

  it("releases no cost when the baseline file is not writable, and leaves no temp files", async () => {
    await mkdir(file); // the atomic rename onto a directory fails
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await cost(new ClaudeSessionUsage(file), 0.004, { freshLedger: true })).toBeUndefined();
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("bounds the number of remembered sessions, evicting the oldest", async () => {
    const key = (sessionId: string) => createHash("sha256").update(JSON.stringify([sessionId, path.resolve("/work/a")])).digest("hex");
    const entries = Array.from({ length: 512 }, (_, index) => ({ key: key(`native-${index}`), totalCostUsd: 0.001, resultIds: [], updatedAt: index }));
    await writeFile(file, JSON.stringify({ version: 1, entries }));
    const usage = new ClaudeSessionUsage(file);
    expect(await cost(usage, 0.001, { sessionId: "native-new", freshLedger: true })).toBe(0.001);
    expect(JSON.parse(await readFile(file, "utf8")).entries).toHaveLength(512);
    expect(await cost(usage, 0.002, { sessionId: "native-511" })).toBe(0.001);
    expect(await cost(usage, 0.002, { sessionId: "native-0" })).toBeUndefined();
  });
});

class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeClaudeChild extends EventEmitter {
  stdin = { lines: [] as string[], write(chunk: string, callback?: (error?: Error | null) => void) { const text = chunk.toString().trim(); if (text) this.lines.push(text); callback?.(null); return true; } };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill() {}
  send(frame: Record<string, unknown>) { this.stdout.emitData(`${JSON.stringify({ session_id: "native-1", ...frame })}\n`); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("ClaudeStreamAdapter durable cost baselines", () => {
  const ok = (total: number) => ({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1000, output_tokens: 100 }, total_cost_usd: total });
  const boot = () => {
    const children: FakeClaudeChild[] = [], args: string[][] = [];
    const adapter = new ClaudeStreamAdapter("claude", { usageStatePath: file, spawnFn: (_command, spawnArgs) => { args.push(spawnArgs); const child = new FakeClaudeChild(); children.push(child); return child as never; } });
    return { adapter, children, args };
  };

  it("resumes with -r after a restart and records only the new increase", async () => {
    const first = boot();
    const fresh = first.adapter.sendUserMessage("tarobot-501", { text: "start", files: [] });
    await waitFor(() => first.children[0]?.stdin.lines.length === 1);
    first.children[0]!.send({ type: "system", subtype: "init" });
    first.children[0]!.send(ok(0.009));
    await expect(fresh).resolves.toMatchObject({ usage: { costUsd: 0.009 } });
    await first.adapter.destroy();

    const restarted = boot();
    const resumed = restarted.adapter.sendUserMessage("native-1", { text: "next", files: [] });
    await waitFor(() => restarted.children[0]?.stdin.lines.length === 1);
    expect(restarted.args[0]).toEqual(expect.arrayContaining(["-r", "native-1"]));
    restarted.children[0]!.send(ok(0.0135));
    await expect(resumed).resolves.toMatchObject({ usage: { inputTokens: 1000, costUsd: 0.0045 } });
    await restarted.adapter.destroy();
  });

  it("publishes no cost when the baseline cannot be saved, then charges that interval once", async () => {
    const { adapter, children } = boot();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(new Error("disk full"));
    const first = adapter.sendUserMessage("tarobot-502", { text: "start", files: [] });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    children[0]!.send({ type: "system", subtype: "init" });
    children[0]!.send(ok(0.004));
    const firstUsage = (await first).usage;
    expect(firstUsage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    expect(firstUsage?.costUsd).toBeUndefined();
    const second = adapter.sendUserMessage("native-1", { text: "next", files: [] });
    await waitFor(() => children[0]!.stdin.lines.length === 2);
    children[0]!.send(ok(0.006));
    await expect(second).resolves.toMatchObject({ usage: { costUsd: 0.006 } });
    await adapter.destroy();
  });
});
