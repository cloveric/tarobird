import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";

// The injected lost reply must reach Playwright, not a service worker.
test.use({ serviceWorkers: "block" });

for (const width of [1360, 390]) test(`strict invitation: lost reply, reload, retry and explicit approval at ${width}`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "strict-pair-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await page.setViewportSize({ width, height: 844 });
  try {
    await page.goto(hub.url);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("首次配对需要有效的限时连接码");
    expect(await hub.store.db.all("SELECT * FROM pairing_requests WHERE status='pending'")).toHaveLength(0);
    await preparePairing(page, hub);
    await page.getByLabel("设备名称", { exact: true }).fill("新设备恢复测试");
    const bodies: unknown[] = [];
    await page.route("**/api/pair", async route => {
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (bodies.length === 1) await route.abort("failed"); else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(page.getByRole("button", { name: "核对上次申请", exact: true })).toBeEnabled();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`request-unconfirmed-${width}.png`) });
    await page.reload();
    const code = await page.getByLabel("配对码", { exact: true }).innerText();
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
    expect(await hub.store.db.all("SELECT * FROM pairing_requests WHERE status='pending'")).toHaveLength(1);
    expect((await hub.store.devices("owner")).filter(d => d.name === "新设备恢复测试")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`pending-approval-${width}.png`) });
    await hub.auth.approve(code, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15000 });
    await waitForClientOnline(page);
    await page.reload();
    await waitForClientOnline(page);
    expect(bodies).toHaveLength(2);
    expect((await hub.store.devices("owner")).filter(d => d.name === "新设备恢复测试")).toHaveLength(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a definitively rejected invite is removed from recovery storage without replacing identity", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rejected-pair-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url); await preparePairing(page, hub);
    const bodies: Record<string, string>[] = [];
    await page.route("**/api/pair", async route => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: bodies.length === 1 ? "pairing_invite_invalid" : "pairing_invite_required" }) });
    });
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("button", { name: "扫描新的连接码", exact: true })).toBeVisible();
    expect(bodies[0]?.invite).toBeTruthy();
    await page.reload();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).not.toHaveProperty("invite");
    for (const key of ["deviceId", "publicKey", "requestId"]) expect(bodies[1]?.[key]).toBe(bodies[0]?.[key]);
    expect(await hub.store.db.all("SELECT * FROM pairing_requests WHERE status='pending'")).toHaveLength(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a pending request without its receipt gives recovery guidance instead of a nonexistent approval code", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pending-pair-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.route("**/api/pair", route => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "pairing_already_pending" }) }));
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("这里尚未收到配对码");
    await expect(page.getByRole("button", { name: "核对上次申请", exact: true })).toBeEnabled();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "扫描新的连接码", exact: true })).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
