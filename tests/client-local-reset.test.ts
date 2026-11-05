import { describe, expect, it } from "vitest";
import { completeLocalReset, type ResetBackend } from "../client/src/local-reset.js";

describe("recoverable local reset", () => {
  it.each(["shared", "push", "browser", "key", "cache"])("keeps the retry record and key reference when %s fails", async (failed) => {
    let pending: { keyRef: string } | undefined = { keyRef: "device_original" }, fail = true;
    const calls: string[] = [], progress: string[] = [];
    const run = async (name: string) => { calls.push(name); if (fail && name === failed) throw new Error("injected_failure"); };
    const backend: ResetBackend = {
      pending: async () => pending, shared: () => run("shared"), push: () => run("push"), browser: () => run("browser"),
      key: async (ref) => { expect(ref).toBe("device_original"); await run("key"); },
      finish: async () => { await run("cache"); pending = undefined; },
    };
    await expect(completeLocalReset(backend, (step) => progress.push(step))).rejects.toThrow("injected_failure");
    expect(pending).toEqual({ keyRef: "device_original" }); expect(progress.at(-1)).toBe(failed);
    expect(calls).toEqual(["shared", "push", "browser", "key", "cache"].slice(0, ["shared", "push", "browser", "key", "cache"].indexOf(failed) + 1));
    fail = false; calls.length = 0;
    await completeLocalReset(backend, () => undefined);
    expect(calls).toEqual(["shared", "push", "browser", "key", "cache"]); expect(pending).toBeUndefined();
    calls.length = 0; await completeLocalReset(backend, () => undefined); expect(calls).toEqual([]);
  });
  it("handles browser identities without attempting native key deletion", async () => {
    const calls: string[] = [];
    await completeLocalReset({ pending: async () => ({}), shared: async () => { calls.push("shared"); }, push: async () => { calls.push("push"); }, browser: async () => { calls.push("browser"); }, key: async () => { throw new Error("unexpected_key_delete"); }, finish: async () => { calls.push("cache"); } }, () => undefined);
    expect(calls).toEqual(["shared", "push", "browser", "cache"]);
  });
});
