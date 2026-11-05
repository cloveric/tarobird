import { test, expect } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "./fixtures/vite.js";
type Fixture = { enable(key: string): Promise<void>; remove(key: string): Promise<void>; snapshot(): { scopes: string[]; removed: string[]; registrations: string[]; receipts: { key: string; path: string; body: { endpoint?: string } }[] } };
declare global { interface Window { hostPushFixture: Fixture } }
test("separate Web Push subscriptions retain the other Hub and root worker when one host is removed", async ({ page }) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const keys = Array.from({ length: 3 }, () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"));
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/host-push.html");
    await page.waitForFunction(() => !!window.hostPushFixture);
    for (const key of keys.slice(0, 2)) await page.evaluate((key) => window.hostPushFixture.enable(key), key);
    const before = await page.evaluate(() => window.hostPushFixture.snapshot());
    expect(before.scopes).toHaveLength(3); expect(new Set(before.registrations).size).toBe(2);
    const subscriptions = before.receipts.filter((receipt) => receipt.path === "/api/push");
    expect(subscriptions.map((receipt) => receipt.key)).toEqual(keys.slice(0, 2));
    expect(subscriptions[0]!.body.endpoint).not.toBe(subscriptions[1]!.body.endpoint);
    await page.evaluate((key) => window.hostPushFixture.remove(key), keys[0]!);
    const after = await page.evaluate(() => window.hostPushFixture.snapshot());
    expect(after.scopes).toEqual(before.scopes.filter((scope) => scope !== before.registrations[0]));
    expect(after.removed).toEqual([before.registrations[0]]);
    // Missing scope returns the root worker per browser semantics; never clear it.
    await page.evaluate((key) => window.hostPushFixture.remove(key), keys[2]!);
    expect(await page.evaluate(() => window.hostPushFixture.snapshot())).toEqual(after);
  } finally { await server.close(); }
});


test("Web Push missing-body fallback uses only saved locale and never creates or reads host state", async ({ page }) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.addScriptTag({ content: readFileSync(new URL("../service-worker-notifications.js", import.meta.url), "utf8") });
    const result = await page.evaluate(async () => {
      const body = (window as unknown as { webPushNotificationBody(payload: { body?: string }): Promise<string> }).webPushNotificationBody;
      const before = (await indexedDB.databases()).map(db => db.name).sort();
      const missing = await body({});
      const after = (await indexedDB.databases()).map(db => db.name).sort();
      const save = (database: string, store: string, value: unknown) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(store, "readwrite");
          if (value === undefined) tx.objectStore(store).delete("preferences"); else tx.objectStore(store).put(value, "preferences");
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      await save("tarocub-v1", "settings", { locale: "en" }); const legacy = await body({});
      await save("tarocub-hosts-v1", "meta", JSON.stringify({ locale: "zh" })); const global = await body({});
      await save("tarocub-hosts-v1", "meta", JSON.stringify({ locale: "en" })); const english = await body({});
      await save("tarocub-hosts-v1", "meta", "invalid JSON"); const corrupt = await body({});
      await save("tarocub-hosts-v1", "meta", undefined); const legacyAgain = await body({});
      const open = indexedDB.open; let reads = 0;
      indexedDB.open = (() => { reads++; throw new Error("storage unavailable"); }) as typeof indexedDB.open;
      const supplied = await body({ body: "x".repeat(250) }); const normalReads = reads;
      const unavailable = await body({}); indexedDB.open = open;
      return { before, after, missing, legacy, global, english, corrupt, legacyAgain, supplied, normalReads, unavailable };
    });
    expect(result).toEqual({ before: [], after: [], missing: "收到新消息。", legacy: "New message received.", global: "收到新消息。", english: "New message received.", corrupt: "收到新消息。", legacyAgain: "New message received.", supplied: "x".repeat(200), normalReads: 0, unavailable: "收到新消息。" });
  } finally { await server.close(); }
});
