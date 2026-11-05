import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import type { ClientCache, Identity } from "../src/storage.js";

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html";
});
test.afterAll(async () => { await server.close(); });

test("group routing metadata does not appear in draft counts/previews or notify draft subscribers", async ({ page }) => {
  await page.goto(url); await page.waitForFunction(() => "streamCache" in window);
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey: "host-key", routes: [] };
    await cache.initializeIdentity(identity); await cache.saveDraft("chat", "真实草稿");
    let changed = 0; const unsubscribe = cache.subscribeDrafts(() => { changed++; });
    try {
      await cache.saveGroupReplyMetadata("capabilities", '{"discussion":true,"guard":true}', identity);
      await cache.saveGroupReplyMetadata("mode:chat", '{"mode":"mentions","revision":"gs_test"}', identity);
      return { changed, count: await cache.draftCount(), previews: await cache.draftPreviews(), saved: await cache.groupReplyMetadata("mode:chat") };
    } finally { unsubscribe(); }
  });
  expect(result).toEqual({ changed: 0, count: 1, previews: { chat: { text: "真实草稿", files: 0, reply: false } }, saved: '{"mode":"mentions","revision":"gs_test"}' });
});

test("stale and revoked identities cannot replace cached group routing metadata", async ({ page }) => {
  await page.goto(url); await page.waitForFunction(() => "streamCache" in window);
  const result = await page.evaluate(async () => {
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey: "host-key", routes: [] };
    await cache.initializeIdentity(identity); await cache.saveGroupReplyMetadata("mode", "confirmed", identity);
    await cache.saveGroupReplyMetadata("mode", "wrong-host", { ...identity, hubPublicKey: "other-host" });
    await cache.saveGroupReplyMetadata("mode", "wrong-device", { ...identity, publicKey: "other-device" });
    await cache.markIdentityRevoked(identity); await cache.saveGroupReplyMetadata("mode", "revoked", identity);
    return { value: await cache.groupReplyMetadata("mode"), count: await cache.draftCount(), previews: await cache.draftPreviews() };
  });
  expect(result).toEqual({ value: "confirmed", count: 0, previews: {} });
});
