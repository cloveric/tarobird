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


test("renewing an invitation commits its routes atomically and refuses stale edits or approval", async ({ page }) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/multiple-hosts.html");
    await page.waitForFunction(() => !!(window as any).multipleHosts);
    const result = await page.evaluate(async () => {
      const { ClientCache, HubConnection } = (window as any).multipleHosts;
      const cache = new ClientCache("renewal-routes-isolated");
      const oldRoutes = [{ name: "Direct", url: "https://192.168.1.10:8788", certificateAuthority: "A".repeat(120) }];
      const newRoutes = [{ ...oldRoutes[0], url: "https://192.168.1.11:8788" }];
      const pending = { code: "12345678", expiresAt: 1, request: { requestId: "old" } };
      const identity = { deviceId: "pending", name: "Phone", publicKey: "key", hubPublicKey: "hub", routes: oldRoutes, pendingPairing: pending };
      await cache.saveIdentity(identity);
      const connection = new HubConnection(identity, cache);
      const next = { code: "", expiresAt: 0, request: { invite: "a".repeat(43), requestId: "new" } };
      await connection.updateRoutes(newRoutes, { expected: identity.routes, pairing: { next, expected: { code: pending.code, requestId: "old" } } });
      const saved = await cache.identity();
      let stale = "";
      try { await connection.updateRoutes(oldRoutes, { pairing: { next: pending, expected: { code: pending.code, requestId: "old" } } }); } catch (e) { stale = (e as Error).message; }
      const afterStale = await cache.identity();
      await cache.savePendingPairing(identity, undefined);
      let approved = "";
      try { await connection.updateRoutes(oldRoutes, { pairing: { next: pending, expected: { code: "", requestId: "new" } } }); } catch (e) { approved = (e as Error).message; }
      const afterApproval = await cache.identity();
      connection.close(); await cache.forgetIdentity(); cache.close();
      return { saved, stale, afterStale, approved, afterApproval };
    });
    expect(result.saved).toMatchObject({ routes: [{ url: "https://192.168.1.11:8788" }], pendingPairing: { request: { requestId: "new" } } });
    expect(result.stale).toBe("pairing_request_changed");
    expect(result.afterStale).toEqual(result.saved);
    expect(result.approved).toBe("pairing_request_changed");
    expect(result.afterApproval.routes).toEqual(result.saved.routes);
    expect(result.afterApproval.pendingPairing).toBeUndefined();
  } finally { await page.close(); await server.close(); }
});
