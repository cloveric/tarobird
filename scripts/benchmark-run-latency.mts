import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createCoreRunCardController } from "../src/core/message-handler.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import type { CoreChannelLike } from "../src/core/types.js";

// Measures the real shared controller, not CLI/model generation or phone RTT.
for (const profile of ["lark", "gateway"] as const) {
  const samples: number[] = [];
  await withChannelProfile(profile, async () => {
    for (let sample = 0; sample < 5; sample++) {
      let updates = 0, receivedAt = 0;
      const channel: CoreChannelLike = {
        profile, send: async () => ({ messageId: "latency-fixture" }),
        stream: async () => { throw new Error("Unexpected stream"); },
        downloadResource: async () => Buffer.alloc(0),
        updateCard: async () => { updates++; receivedAt = performance.now(); },
      };
      const controller = (await createCoreRunCardController({ channel, chatId: "fixture", conversationKey: "fixture", bridgeChatType: "private", locale: "en" }))!;
      await controller.apply({ type: "assistant_text", text: "First" });
      while (!updates) await sleep(1);
      const before = updates, startedAt = performance.now();
      await controller.apply({ type: "assistant_text", text: " second", delta: true });
      while (updates === before) {
        if (performance.now() - startedAt > 3000) throw new Error("Patch timed out");
        await sleep(1);
      }
      samples.push(Math.round((receivedAt - startedAt) * 10) / 10);
      await controller.finish("First second");
    }
  });
  console.log(JSON.stringify({ profile, boundary: "public engine event -> channel updateCard", samplesMs: samples }));
}
