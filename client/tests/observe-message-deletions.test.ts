import { expect, it, vi } from "vitest";
import { observeMessageDeletions } from "../src/observe-message-deletions.js";
import type { HubConnection } from "../src/connection.js";

it("ignores unrelated status updates, coalesces deletion bursts and fences a closed result", async () => {
  const reads: ((value: Set<string>) => void)[] = [], listeners = new Set<() => void>();
  const read = vi.fn(() => new Promise<Set<string>>(resolve => reads.push(resolve)));
  const connection = { groupDiscussionRevision: 0, state: { status: "online" }, cache: { deletedMessageIds: read }, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const publish = vi.fn(), stop = observeMessageDeletions(connection as unknown as HubConnection, publish);
  const notify = () => listeners.forEach(fn => fn());
  reads.shift()!(new Set()); await Promise.resolve();
  for (let i = 0; i < 100; i++) notify();
  expect(read).toHaveBeenCalledTimes(1);
  connection.state.status = "offline"; notify();
  connection.state.status = "online"; notify();
  expect(read).toHaveBeenCalledTimes(2);
  reads.shift()!(new Set()); await Promise.resolve();
  for (let i = 0; i < 100; i++) notify();
  expect(read).toHaveBeenCalledTimes(2);
  connection.groupDiscussionRevision++; notify();
  for (let i = 0; i < 100; i++) { connection.groupDiscussionRevision++; notify(); }
  expect(read).toHaveBeenCalledTimes(3);
  reads.shift()!(new Set(["first"])); await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(4); expect(publish).toHaveBeenLastCalledWith(new Set(["first"]));
  stop(); reads.shift()!(new Set(["late"])); await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(3); expect(listeners.size).toBe(0);
});
