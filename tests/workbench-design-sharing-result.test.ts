import { describe, expect, it } from "vitest";
import { DESIGN_SHARE_LIMITS } from "../src/client-protocol/workbench-design-sharing.js";
import { appendDesignShareResult, encodeDesignShareResult, splitDesignShareResult, type DesignShareResultBuffer } from "../src/client-protocol/workbench-design-sharing-result.js";
import { DesignShareClient, type DesignShareTransport } from "../client/src/workbench-design-collaboration.js";

describe("bounded shared result reassembly", () => {
  const value = { text: "中文🙂".repeat(100000) }, bytes = encodeDesignShareResult(value);
  const parts = [...splitDesignShareResult(bytes)];
  it("reassembles UTF-8 across fragment boundaries without exposing a partial result", () => {
    let buffer: DesignShareResultBuffer | undefined;
    for (const [index, part] of parts.entries()) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(512 * 1024);
      const next = appendDesignShareResult(buffer, part, DESIGN_SHARE_LIMITS.resultBufferBytes);
      buffer = next.buffer;
      expect(next.complete).toBe(index === parts.length - 1);
      if (next.complete) expect(next.value).toEqual(value);
    }
  });
  it("rejects out-of-order, inconsistent, empty and oversized fragments before adoption", () => {
    expect(() => appendDesignShareResult(undefined, parts[1], DESIGN_SHARE_LIMITS.resultBytes)).toThrow("design_share_bad_chunk");
    const { buffer } = appendDesignShareResult(undefined, parts[0], DESIGN_SHARE_LIMITS.resultBytes);
    expect(() => appendDesignShareResult(buffer, { ...parts[1], size: bytes.length + 1 }, DESIGN_SHARE_LIMITS.resultBytes)).toThrow("design_share_bad_chunk");
    expect(() => appendDesignShareResult(undefined, { ...parts[0], base64: "" }, DESIGN_SHARE_LIMITS.resultBytes)).toThrow("design_share_bad_chunk");
    expect(() => appendDesignShareResult(undefined, { ...parts[0], size: DESIGN_SHARE_LIMITS.resultBytes + 1 }, Infinity)).toThrow("design_share_bad_chunk");
    expect(() => appendDesignShareResult(undefined, parts[0], bytes.length - 1)).toThrow("design_share_reply_busy");
    expect(() => appendDesignShareResult(undefined, { size: 1, offset: 0, base64: "/w==" }, 1)).toThrow("design_share_bad_chunk");
    expect(() => appendDesignShareResult(undefined, { size: 1, offset: 0, base64: "eA==" }, 1)).toThrow("design_share_bad_chunk");
  });
  it("drops partial bytes after refusal and accepts a clean retry on the same request id", async () => {
    let emit: Parameters<DesignShareTransport["onFrame"]>[0] = () => {};
    const client = new DesignShareClient({ send: () => {}, onFrame: listener => { emit = listener; return () => {}; } });
    const request = { op: "list" as const, conversationId: "c" }, header = { v: 1 as const, type: "design.share.result" as const, requestId: "r" };
    let settled = false;
    const pending = client.request(request, "r"); void pending.then(() => { settled = true; }, () => { settled = true; });
    emit({ ...header, ok: true, part: parts[0] }); await Promise.resolve(); expect(settled).toBe(false);
    emit({ ...header, ok: false, error: "design_share_revoked" }); await expect(pending).rejects.toThrow("design_share_revoked");
    const retry = client.request(request, "r"); emit({ ...header, ok: true, result: { shares: [] } });
    expect(await retry).toEqual({ shares: [] }); client.dispose();
  });
  it.each(["db.list", "db.write"] as const)("preserves uncertainty on %s if the reply cannot be assembled", async call => {
    let emit: Parameters<DesignShareTransport["onFrame"]>[0] = () => {};
    const client = new DesignShareClient({ send: () => {}, onFrame: listener => { emit = listener; return () => {}; } });
    const request = { op: "call" as const, shareId: `ds_${"a".repeat(24)}`, windowId: "w", call, payload: {} };
    const bad = client.request(request, "bad");
    emit({ v: 1, type: "design.share.result", requestId: "bad", ok: true, part: parts[1] });
    await expect(bad).rejects.toThrow(call === "db.write" ? "design_share_outcome_unknown" : "design_share_bad_chunk");
    const release = client.reserveReply(DESIGN_SHARE_LIMITS.resultBufferBytes);
    const busy = client.request(request, "busy");
    emit({ v: 1, type: "design.share.result", requestId: "busy", ok: true, part: parts[0] });
    await expect(busy).rejects.toThrow(call === "db.write" ? "design_share_outcome_unknown" : "design_share_reply_busy");
    release(); client.dispose();
  });
  it("reports local payload validation without pretending the App disconnected", async () => {
    let sent = 0;
    const client = new DesignShareClient({ send: () => { sent++; }, onFrame: () => () => {} });
    await expect(client.request({ op: "call", shareId: `ds_${"a".repeat(24)}`, windowId: "w", call: "session", payload: "x".repeat(300000) })).rejects.toThrow("design_share_payload_too_large");
    expect(sent).toBe(0); expect(client.online).toBe(true); client.dispose();
  });
});
