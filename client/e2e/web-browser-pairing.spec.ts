import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { browserPairingLink } from "../src/web-browser.js";
import { pairingLink } from "../src/pairing-link.js";
import { fixtureInvitation } from "./fixtures/pairing-invite.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

async function startHub(root: string, name: string, origins?: string[]) {
  return HubServer.start({ stateDir: path.join(root, name), clientDir: path.resolve("dist"), ...(origins ? { origins } : {}) });
}

test("browser #pair= link strips fragment, hides App pre-scan buttons, pairs over 127.0.0.1 and localhost, and resets label on replacement", async ({ page, browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-pair-ok-"));
  const hub = await startHub(root, "hub");
  const secondContext = await browser.newContext({ serviceWorkers: "block" });
  const localhostPage = await secondContext.newPage();
  try {
    // 1) Mobile viewport (390x844): pre-scan App instructions/buttons stay hidden and primary Pair action is visible.
    await page.setViewportSize({ width: 390, height: 844 });
    const firstInvite = await fixtureInvitation(hub);
    const link = browserPairingLink(hub.url, {
      v: 1,
      kind: "connect",
      hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "Direct", url: hub.url }],
      invite: firstInvite.invite,
    });
    await page.goto(link);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toBeVisible();
    await expect(page.locator(".pairing-import")).toContainText("127.0.0.1");
    await expect(page.locator(".pairing-qr-source")).toHaveCount(0);
    await expect(page.locator(".pairing-import-actions")).toHaveCount(0);
    const pairButton = page.getByRole("button", { name: "配对此设备", exact: true });
    await expect(pairButton).toBeInViewport();

    // Replacing via "更换连接信息" with a regular tarocub:// code resets the browser-link label and displays actual VPS hostnames.
    const replaceInvite = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "更换连接信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(pairingLink({
      v: 1,
      kind: "connect",
      hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "VPS", url: hub.url }],
      invite: replaceInvite.invite,
    }));
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("已读取主机信息", { exact: true })).toBeVisible();
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toHaveCount(0);
    await expect(page.locator(".pairing-import")).toContainText("127.0.0.1");

    // 2) Same-tab hashchange with a fresh browser link loads it and strips hash again.
    const freshInvite = await fixtureInvitation(hub);
    const freshHash = new URL(browserPairingLink(hub.url, {
      v: 1,
      kind: "connect",
      hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "Direct", url: hub.url }],
      invite: freshInvite.invite,
    })).hash;
    await page.evaluate((hash) => { window.location.hash = hash; }, freshHash);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toBeVisible();

    await pairButton.click();
    const code = await page.getByLabel("配对码", { exact: true }).innerText();
    await hub.auth.approve(code, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await waitForClientOnline(page);

    // 3) http://localhost:<port> works end-to-end (both /api/pair and /ws pass HubServer origin check).
    const port = new URL(hub.url).port;
    const localhostOrigin = `http://localhost:${port}`;
    const localhostInvite = await fixtureInvitation(hub);
    const localhostLink = browserPairingLink(localhostOrigin, {
      v: 1,
      kind: "connect",
      hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "Direct", url: localhostOrigin }],
      invite: localhostInvite.invite,
    });
    await localhostPage.goto(localhostLink);
    await expect.poll(() => localhostPage.evaluate(() => window.location.hash)).toBe("");
    await localhostPage.getByRole("button", { name: "配对此设备", exact: true }).click();
    const localhostCode = await localhostPage.getByLabel("配对码", { exact: true }).innerText();
    await hub.auth.approve(localhostCode, "local-owner");
    await expect(localhostPage.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await waitForClientOnline(localhostPage);
  } finally {
    await secondContext.close();
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-origin and malformed #pair= fragments fail closed and are stripped from URL history", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-pair-sec-"));
  const victim = await startHub(root, "victim");
  const attacker = await startHub(root, "attacker", [victim.url]);
  try {
    // 1) Foreign-only #pair= fragment on victim origin is rejected before loading and stripped immediately.
    const attackerInvite = await fixtureInvitation(attacker);
    const foreignHash = new URL(browserPairingLink(attacker.url, {
      v: 1,
      kind: "connect",
      hubPublicKey: attacker.auth.publicKey,
      routes: [{ name: "VPS", url: attacker.url }],
      invite: attackerInvite.invite,
    })).hash;
    await page.goto(`${victim.url}/${foreignHash}`);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByRole("alert")).toContainText("与当前访问地址不匹配");
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toHaveCount(0);

    // 2) Mixed [victimOrigin, attackerOrigin] with attacker's public key fails closed on victim /health identity mismatch (never fails over to attacker).
    let attackerPairCalled = false;
    await page.route(`${attacker.url}/api/pair`, async route => {
      attackerPairCalled = true;
      await route.continue();
    });
    const mixedHash = new URL(browserPairingLink(victim.url, {
      v: 1,
      kind: "connect",
      hubPublicKey: attacker.auth.publicKey,
      routes: [{ name: "Direct", url: victim.url }, { name: "VPS", url: attacker.url }],
      invite: attackerInvite.invite,
    })).hash;
    await page.goto(`${victim.url}/${mixedHash}`);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("主机身份校验未通过");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
    expect(attackerPairCalled).toBe(false);

    // 3) Malformed #pair= hash is stripped and shows an explicit error.
    await page.goto(`${victim.url}/#pair=not-json&invite=${attackerInvite.invite}`);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByRole("alert")).toContainText("无效或不完整");
  } finally {
    await page.close();
    await attacker.close();
    await victim.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending pairing renews on same-host #pair= link and switches cleanly on different-host link", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-pair-pending-"));
  const hubA = await startHub(root, "hub-a");
  const hubB = await startHub(root, "hub-b", [hubA.url]);
  try {
    let pairCalls = 0;
    await page.route(`${hubA.url}/api/pair`, async route => {
      const response = await route.fetch();
      const body = await response.json();
      pairCalls++;
      await route.fulfill({ response, json: { ...body, expiresAt: pairCalls === 1 ? Date.now() + 1200 : body.expiresAt } });
    });

    const invite1 = await fixtureInvitation(hubA);
    await page.goto(browserPairingLink(hubA.url, {
      v: 1, kind: "connect", hubPublicKey: hubA.auth.publicKey,
      routes: [{ name: "Direct", url: hubA.url }], invite: invite1.invite,
    }));
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const expiredCode = await page.getByLabel("配对码", { exact: true }).innerText();
    const pendingBefore = await hubA.store.db.get<{ device_id: string }>("SELECT device_id FROM pairing_requests WHERE status='pending'");
    await expect(page.getByRole("status").filter({ hasText: "配对码已过期" })).toBeVisible({ timeout: 10_000 });
    await hubA.store.db.run("UPDATE pairing_requests SET expires_at=?", [Date.now() - 1]);

    // Opening a fresh #pair= link for the SAME host renews the pending pairing with the same deviceId.
    const invite2 = await fixtureInvitation(hubA);
    await page.goto(browserPairingLink(hubA.url, {
      v: 1, kind: "connect", hubPublicKey: hubA.auth.publicKey,
      routes: [{ name: "Direct", url: hubA.url }], invite: invite2.invite,
    }));
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByLabel("配对码", { exact: true })).not.toHaveText(expiredCode, { timeout: 10_000 });
    const renewedCode = await page.getByLabel("配对码", { exact: true }).innerText();
    expect(await hubA.store.db.get("SELECT device_id FROM pairing_requests WHERE status='pending'")).toEqual(pendingBefore);

    // Opening a #pair= link for a DIFFERENT host (carrying hubA.url origin so it passes origin check) switches cleanly to new-host form without wiping payload.
    const inviteB = await fixtureInvitation(hubB);
    const otherHostHash = new URL(browserPairingLink(hubA.url, {
      v: 1, kind: "connect", hubPublicKey: hubB.auth.publicKey,
      routes: [{ name: "Direct", url: hubA.url }, { name: "VPS", url: hubB.url }], invite: inviteB.invite,
    })).hash;
    await page.evaluate((hash) => { window.location.hash = hash; }, otherHostHash);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toBeVisible();
    // Returning to the pending pairing still lets us approve the renewed code.
    await page.getByRole("button", { name: "返回配对申请", exact: true }).click();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText(renewedCode);
    await hubA.auth.approve(renewedCode, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await waitForClientOnline(page);
  } finally {
    await page.close();
    await hubB.close();
    await hubA.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revoked browser opening a fresh #pair= link strips fragment, routes to Pairing, and re-pairs after removing old connection", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-pair-revoked-"));
  const hub = await startHub(root, "hub");
  try {
    // Pair the browser normally first.
    const invite1 = await fixtureInvitation(hub);
    await page.goto(browserPairingLink(hub.url, {
      v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "Direct", url: hub.url }], invite: invite1.invite,
    }));
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const firstCode = await page.getByLabel("配对码", { exact: true }).innerText();
    await hub.auth.approve(firstCode, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await waitForClientOnline(page);

    // Revoke the paired browser device on the Hub.
    const pairedDevice = (await hub.store.devices("owner")).find((d) => d.id !== "pairing_fixture_owner")!;
    await hub.auth.revoke(pairedDevice.id, "local-owner");
    await expect(page.locator(".connection-pill.online")).toHaveCount(0, { timeout: 10_000 });

    // Open a fresh #pair= link in the revoked browser.
    const invite2 = await fixtureInvitation(hub);
    await page.goto(browserPairingLink(hub.url, {
      v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey,
      routes: [{ name: "Direct", url: hub.url }], invite: invite2.invite,
    }));
    // One-time invite token is stripped immediately from URL history even though a host record exists.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toBeVisible();
    await expect(page.locator(".pairing-existing-host")).toBeVisible();

    // Remove the old revoked connection via the inline button, keeping the loaded browser pairing link intact.
    await page.getByRole("button", { name: "打开此设备的连接", exact: true }).click();
    await page.getByRole("button", { name: "从此设备移除", exact: true }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(page.getByText("还没有保存的主机连接。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭连接管理", exact: true }).click();

    // Complete re-pairing immediately using the already-loaded fresh invite.
    await expect(page.getByText("已读取浏览器配对链接", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const secondCode = await page.getByLabel("配对码", { exact: true }).innerText();
    await hub.auth.approve(secondCode, "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await waitForClientOnline(page);
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
