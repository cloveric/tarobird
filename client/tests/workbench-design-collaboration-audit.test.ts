import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignShareClient, type DesignShareTransport } from "../src/workbench-design-collaboration.js";
import type { DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";

const list = { op: "list" as const, conversationId: "c" };
function fixture() {
  let listener: (frame: DesignShareServerFrame) => void = () => {};
  const sends: { reject(error: Error): void }[] = [];
  const transport: DesignShareTransport = {
    onFrame(fn) { listener = fn; return () => {}; },
    send() { return new Promise<void>((_resolve, reject) => sends.push({ reject })); },
  };
  return { client: new DesignShareClient(transport, 1_000), sends, emit: (frame: DesignShareServerFrame) => listener(frame) };
}
afterEach(() => vi.useRealTimers());
describe("Design sharing request ownership", () => {
  it("does not let an old asynchronous send failure remove a retried request", async () => {
    vi.useFakeTimers(); const f = fixture();
    const old = f.client.request(list, "same-id").catch(error => error.code);
    f.client.abortPending(); expect(await old).toBe("design_share_outcome_unknown");
    const retry = f.client.request(list, "same-id").then(value => ({ value }), error => ({ error: error.code }));
    f.sends[0].reject(new Error("old socket rejected")); await Promise.resolve();
    f.emit({ v: 1, type: "design.share.result", requestId: "same-id", ok: true, result: { shares: [] } });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await retry).toEqual({ value: { shares: [] } }); f.client.dispose();
  });
  it("does not dispatch another request while the same id is already pending", async () => {
    vi.useFakeTimers(); const f = fixture();
    const first = f.client.request(list, "duplicate").catch(error => error.code);
    const duplicate = f.client.request({ ...list, conversationId: "another" }, "duplicate").catch(error => error.code);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.sends).toHaveLength(1);
    expect(await duplicate).toBe("design_share_request_pending");
    expect(await first).toBe("design_share_outcome_unknown"); f.client.dispose();
  });
});
