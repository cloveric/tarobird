import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test("a late pairing receipt cannot resurrect approval or overwrite a replacement request", async ({ page }) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/multiple-hosts.html");
    await page.waitForFunction(() => !!(window as any).multipleHosts);
    const result = await page.evaluate(async () => {
      const { ClientCache } = (window as any).multipleHosts;
      const cache = new ClientCache("pairing-cas-isolated");
      const pending = { code: "", expiresAt: 0, request: { invite: "a".repeat(43), requestId: "b".repeat(43) } };
      const identity = { deviceId: "pending", name: "Phone", platform: "web", publicKey: "key", hubPublicKey: "hub", routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }], pendingPairing: pending };
      await cache.saveIdentity(identity);
      const expected = { code: "", requestId: pending.request.requestId };
      const next = { code: "12345678", expiresAt: Date.now() + 300_000, request: pending.request };
      await cache.savePendingPairing(identity, next, expected);
      await cache.savePendingPairing(identity, undefined);
      let approvedLate = ""; try { await cache.savePendingPairing(identity, next, expected); } catch (e) { approvedLate = (e as Error).message; }
      const approved = await cache.identity();
      await cache.savePendingPairing(identity, { ...pending, request: { invite: "c".repeat(43), requestId: "d".repeat(43) } });
      let replacedLate = ""; try { await cache.savePendingPairing(identity, next, expected); } catch (e) { replacedLate = (e as Error).message; }
      const replaced = await cache.identity();
      await cache.forgetIdentity(); cache.close();
      return { approvedLate, approvedPending: approved.pendingPairing, replacedLate, requestId: replaced.pendingPairing.request.requestId };
    });
    expect(result).toEqual({ approvedLate: "pairing_request_changed", approvedPending: undefined, replacedLate: "pairing_request_changed", requestId: "d".repeat(43) });
  } finally { await page.close(); await server.close(); }
});
