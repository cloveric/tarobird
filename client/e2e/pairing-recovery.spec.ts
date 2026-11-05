import { pairingLink } from "../src/pairing-link.js";
import { preparePairing, fixtureInvitation } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";

// Pairing expiry is injected at the HTTP boundary; a worker must not bypass
// that route in WebKit before the first registration request is submitted.
test.use({ serviceWorkers: "block" });

test("pending pairing survives a reload and enters chats only after authenticated approval", async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pair-resume-"));
  const hub = await HubServer.start({ stateDir: dir, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const code = await page.getByLabel("配对码", { exact: true }).innerText();
    await expect(page.getByRole("heading", { name: "用已配对设备确认" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText(code);
    await page.getByRole("button", { name: "重新检查连接", exact: true }).click();
    expect((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).toHaveLength(0);
    await expect(page.getByLabel("配对码", { exact: true })).toBeVisible();
    await hub.auth.approve(code, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    expect((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).toHaveLength(1);
    await page.reload(); await expect(page.locator(".connection-pill.online")).toBeVisible();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(dir, { recursive: true, force: true }); }
});

test("expired enrollment renews the same device key without losing the host", async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pair-renew-"));
  const hub = await HubServer.start({ stateDir: dir, clientDir: path.resolve("dist") });
  try {
    let requests = 0;
    await page.route("**/api/pair", async route => {
      requests++; const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, json: { ...body, expiresAt: requests === 1 ? Date.now() + 1000 : body.expiresAt } });
    });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const code = await page.getByLabel("配对码", { exact: true }).innerText();
    const before = await hub.store.db.get<{ device_id: string; public_key: string }>("SELECT device_id,public_key FROM pairing_requests WHERE status='pending'");
    await hub.store.db.run("UPDATE pairing_requests SET expires_at=?", [Date.now() - 1]);
    const invitation = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "扫描新的连接码", exact: true }).click();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, routes: [{ name: "Direct", url: hub.url }], invite: invitation.invite }));
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await expect(page.getByLabel("配对码", { exact: true })).not.toHaveText(code);
    expect(await hub.store.db.get("SELECT device_id,public_key FROM pairing_requests WHERE status='pending'")).toEqual(before);
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    expect((await hub.store.devices("owner")).find(device => device.id !== "pairing_fixture_owner")?.id).toBe(before?.device_id);
  } finally { await page.close(); await hub.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an abandoned first enrollment can be removed without trapping the welcome screen", async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pair-abandon-"));
  const hub = await HubServer.start({ stateDir: dir, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByLabel("配对码", { exact: true })).toBeVisible();
    await page.getByText("无法连接？更新主机地址", { exact: true }).click();
    await page.getByRole("button", { name: "设备与网络", exact: true }).click(); await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    await page.getByRole("button", { name: "从此设备移除", exact: true }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(page.getByRole("heading", { name: "连接你的 TaroBird", exact: true })).toBeVisible();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).toHaveLength(0);
  } finally { await page.close(); await hub.close(); await rm(dir, { recursive: true, force: true }); }
});
