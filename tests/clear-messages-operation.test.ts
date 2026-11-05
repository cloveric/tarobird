import { expect, it, vi } from "vitest";
import { clearMessageHistory } from "../src/client-protocol/clear-messages-operation.js";

it("stops on a lost receipt and can retry the same boundary including an empty final receipt", async () => {
  const batch = vi.fn().mockResolvedValueOnce({ throughId: "last", clearedIds: ["a"], remaining: 1, seq: 4 }).mockRejectedValueOnce(new Error("lost"));
  const accept = vi.fn();
  await expect(clearMessageHistory({ throughId: "last", count: 2 }, batch, accept)).rejects.toThrow("lost");
  expect(batch.mock.calls).toEqual([["last"], ["last"]]); expect(accept).toHaveBeenCalledTimes(1);
  const retry = vi.fn().mockResolvedValue({ throughId: "last", clearedIds: [], remaining: 0, seq: 5 });
  await expect(clearMessageHistory({ throughId: "last", count: 1 }, retry, accept)).resolves.toEqual({ cleared: 0 });
  expect(accept).toHaveBeenLastCalledWith({ throughId: "last", clearedIds: [], remaining: 0, seq: 5 });
});

it("does not send another batch until local receipt verification succeeds", async () => {
  const batch = vi.fn().mockResolvedValue({ throughId: "last", clearedIds: ["a"], remaining: 1, seq: 4 });
  await expect(clearMessageHistory({ throughId: "last", count: 2 }, batch, () => { throw new Error("sync failed"); })).rejects.toThrow("sync failed");
  expect(batch).toHaveBeenCalledTimes(1);
});

it("rejects a wrong boundary, missing sequence or a non-decreasing remainder without looping", async () => {
  for (const result of [
    { throughId: "wrong", clearedIds: ["a"], remaining: 0, seq: 4 },
    { throughId: "last", clearedIds: ["a"], remaining: 0 },
    { throughId: "last", clearedIds: ["a"], remaining: 2, seq: 4 },
    { throughId: "last", clearedIds: ["a"], remaining: 3, seq: 4 },
  ]) {
    const batch = vi.fn().mockResolvedValue(result);
    await expect(clearMessageHistory({ throughId: "last", count: 2 }, batch)).rejects.toThrow();
    expect(batch).toHaveBeenCalledTimes(1);
  }
});
