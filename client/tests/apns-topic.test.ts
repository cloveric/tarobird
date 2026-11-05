import { describe, expect, it, vi } from "vitest";
import { apnsTopicFor, ApnsTopicError, nativeApnsTopic, systemPushSubscription } from "../src/apns-topic.js";
import { maintainPushBinding } from "../src/push-maintenance.js";

const token = "b".repeat(64);
describe("APNs topic capability", () => {
  it("requires the Hub's advertised allowlist to contain this App's native topic", () => {
    expect(() => apnsTopicFor({ providers: { apns: true } }, "com.tarobot.client")).toThrow(new ApnsTopicError("apns_topic_unsupported"));
    expect(() => apnsTopicFor({ apnsTopics: ["com.tarocub.client"] }, "com.tarobot.client")).toThrow(new ApnsTopicError("apns_topic_not_allowed"));
    expect(apnsTopicFor({ apnsTopics: ["com.tarocub.client", "com.tarobot.client"] }, "com.tarobot.client")).toBe("com.tarobot.client");
  });

  it("builds APNs writes with the native topic and leaves FCM unchanged", async () => {
    const state = vi.fn(async () => ({ apnsTopics: ["com.tarobot.client"] }));
    expect(await systemPushSubscription("apns", token, state, async () => "com.tarobot.client")).toEqual({ provider: "apns", token, topic: "com.tarobot.client" });
    expect(await systemPushSubscription("fcm", "f".repeat(40), state, async () => { throw new Error("unused"); })).toEqual({ provider: "fcm", token: "f".repeat(40) });
    expect(state).toHaveBeenCalledTimes(1);
    await expect(systemPushSubscription("apns", token, async () => ({ providers: { apns: true } }), async () => "com.tarobot.client")).rejects.toMatchObject({ code: "apns_topic_unsupported" });
  });

  it("accepts only a valid bundle identifier from the native App and retries after a failed read", async () => {
    await expect(nativeApnsTopic(async () => ({ id: "not a bundle" }))).rejects.toThrow();
    expect(await nativeApnsTopic(async () => ({ id: "com.tarobot.client" }))).toBe("com.tarobot.client");
    // Cached for this installation; a later caller cannot substitute another identity.
    expect(await nativeApnsTopic(async () => ({ id: "com.example.other" }))).toBe("com.tarobot.client");
  });
});

describe("APNs token maintenance", () => {
  function connection() {
    const writes: unknown[] = [];
    return { writes, value: {
      state: { status: "online" },
      subscribe: () => () => {},
      async http(route: string, init: RequestInit = {}) {
        if (init.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return {}; }
        return { provider: "apns", revision: "binding-1", enabled: true };
      },
    } };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it("rotates with the declared topic", async () => {
    const hub = connection();
    const stop = maintainPushBinding(hub.value, { provider: "apns", token: async () => token, observe: () => () => {},
      subscription: async (value) => ({ provider: "apns", token: value, topic: "com.tarobot.client" }) }, () => () => {});
    await settle(); stop();
    expect(hub.writes).toEqual([{ provider: "apns", token, topic: "com.tarobot.client", expectedRevision: "binding-1" }]);
  });

  it("bounds the capability read by the maintenance signal and writes nothing after dispose", async () => {
    const hub = connection(); let seen: AbortSignal | undefined;
    const stop = maintainPushBinding(hub.value, { provider: "apns", token: async () => token, observe: () => () => {},
      subscription: (_value, signal) => new Promise((_resolve, reject) => { seen = signal; signal.addEventListener("abort", () => reject(signal.reason)); }) }, () => () => {});
    await settle();
    expect(seen?.aborted).toBe(false);
    stop(); await settle();
    expect(seen?.aborted).toBe(true);
    expect(hub.writes).toEqual([]);
  });

  it("does not rotate a token the Hub cannot route", async () => {
    const hub = connection();
    const stop = maintainPushBinding(hub.value, { provider: "apns", token: async () => token, observe: () => () => {},
      subscription: async () => { throw new ApnsTopicError("apns_topic_unsupported"); } }, () => () => {});
    await settle(); stop();
    expect(hub.writes).toEqual([]);
  });
});
