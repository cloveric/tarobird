import { expect, it } from "vitest";
import { promptQueueMove } from "../src/prompt-queue-order.js";
const item = (id: string, canMove = true, reorderBarrier?: boolean) => ({ message: { id }, canMove, reorderBarrier });
it("moves an owned prompt around a Bus goal without granting edits to the goal", () => {
  const items = [item("a", true, false), item("bus", false, false), item("b", true, false)];
  expect(promptQueueMove(items, "a", "b", true)).toEqual({ beforeId: null, after: true });
  expect(promptQueueMove(items, "b", "a", false)).toEqual({ beforeId: "a", after: false });
  expect(promptQueueMove(items, "b", "bus", false)).toEqual({ beforeId: "bus", after: false });
  expect(promptQueueMove(items, "bus", "a", false)).toBeUndefined();
});
it("keeps command and old-Host barriers while allowing a drop on the same side", () => {
  for (const barrier of [true, undefined]) {
    const items = [item("a"), item("command", false, barrier), item("b"), item("c")];
    expect(promptQueueMove(items, "a", "c", true)).toBeUndefined();
    expect(promptQueueMove(items, "c", "a", false)).toBeUndefined();
    expect(promptQueueMove(items, "c", "command", true)).toEqual({ beforeId: "b", after: true });
    expect(promptQueueMove(items, "c", "command", false)).toBeUndefined();
  }
});
