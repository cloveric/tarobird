import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HubHttpError } from "../client/src/http-error.js";
import { negotiateSideCapability, sideCapabilityFailure, type SideCapabilityShape } from "../client/src/side-capability.js";

const label = (shape: SideCapabilityShape) => shape.delivery ? "delivery+tools+audio" : shape.tools ? "tools+audio" : shape.audio ? "audio" : "plain";
function scripted(responses: Array<unknown>) {
  const asked: string[] = [];
  return { asked, request: async (shape: SideCapabilityShape) => {
    asked.push(label(shape));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? label(shape);
  } };
}
const options = { current: () => true, delays: [1, 1], sleep: async () => undefined };

describe("side capability negotiation", () => {
  it("steps down only on an explicit request rejection", async () => {
    const both = scripted([new HubHttpError(400, "unknown_parameter"), new HubHttpError(400, "unknown_parameter"), new HubHttpError(400, "unknown_parameter")]);
    expect(await negotiateSideCapability(both.request, options)).toEqual({ kind: "ok", value: "plain" });
    expect(both.asked).toEqual(["delivery+tools+audio", "tools+audio", "audio", "plain"]);
    // A Host rejecting only delivery keeps inherited tools and audio.
    const tools = scripted([new HubHttpError(400, "unknown_parameter")]);
    expect(await negotiateSideCapability(tools.request, options)).toEqual({ kind: "ok", value: "tools+audio" });
    expect(tools.asked).toEqual(["delivery+tools+audio", "tools+audio"]);
  });

  it("retries the same shape after transient failures and never drops an opt-in", async () => {
    for (const error of [new TypeError("Failed to fetch"), new DOMException("The request was aborted", "AbortError"), new DOMException("timeout", "TimeoutError"),
      new HubHttpError(0, "offline"), new HubHttpError(503, "hub_stopping"), new HubHttpError(502, "bad_gateway"), new HubHttpError(401, "token_expired_or_invalid"), new Error("native transport closed")]) {
      const flaky = scripted([error]);
      expect(await negotiateSideCapability(flaky.request, options)).toEqual({ kind: "ok", value: "delivery+tools+audio" });
      expect(flaky.asked).toEqual(["delivery+tools+audio", "delivery+tools+audio"]);
    }
  });

  it("reports a bounded transient outcome instead of a downgraded capability", async () => {
    const down = scripted([new TypeError("a"), new TypeError("b"), new TypeError("c"), "never"]);
    const delays: number[] = [];
    expect(await negotiateSideCapability(down.request, { ...options, delays: [1000, 3000], sleep: async ms => { delays.push(ms); } })).toEqual({ kind: "transient" });
    expect(down.asked).toEqual(["delivery+tools+audio", "delivery+tools+audio", "delivery+tools+audio"]); expect(delays).toEqual([1000, 3000]);
    // A transient failure while already on an older shape retries that shape, not an older one.
    const mixed = scripted([new HubHttpError(400, "unknown_parameter"), new TypeError("reset")]);
    expect(await negotiateSideCapability(mixed.request, options)).toEqual({ kind: "ok", value: "tools+audio" });
    expect(mixed.asked).toEqual(["delivery+tools+audio", "tools+audio", "tools+audio"]);
  });

  it("stops on definite refusals, malformed replies and stale sessions", async () => {
    let malformed: unknown; try { z.object({ ok: z.boolean() }).parse({}); } catch (error) { malformed = error; }
    for (const error of [new HubHttpError(403, "conversation_forbidden"), new HubHttpError(404, "not_found"), new HubHttpError(409, "side_unavailable"), new HubHttpError(500, "internal_error"), malformed as Error]) {
      const refused = scripted([error]);
      expect(await negotiateSideCapability(refused.request, options)).toEqual({ kind: "final" });
      expect(refused.asked).toEqual(["delivery+tools+audio"]);
    }
    const last = scripted([new HubHttpError(400, "x"), new HubHttpError(400, "x"), new HubHttpError(400, "x"), new HubHttpError(400, "x")]);
    expect(await negotiateSideCapability(last.request, options)).toEqual({ kind: "final" });
    let live = true; const stale = scripted([new TypeError("reset")]);
    expect(await negotiateSideCapability(stale.request, { ...options, sleep: async () => { live = false; }, current: () => live })).toEqual({ kind: "stale" });
    expect(stale.asked).toEqual(["delivery+tools+audio"]);
    expect(sideCapabilityFailure(new HubHttpError(400, "x"))).toBe("older");
  });
});
