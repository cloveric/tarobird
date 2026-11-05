import { test, expect } from "@playwright/test";
import { parsePairingLink } from "../src/pairing-link.js";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings } from "./fixtures/settings.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

for (const ownerWidth of [390, 1360]) test(`invitation survives moving the owner wizard to approval before a new device submits (${ownerWidth}px owner)`, async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  // Real disposable HTTPS Hubs behind the existing browser transport fixture:
  // no fake owner API, capability, invitation, enrollment or approval response.
  const fixture = await noviceNetworkFixture();
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const second = await secondContext.newPage();
  const hub = fixture.hubs[0]!;
  let pairPosts = 0;
  second.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/pair")) pairPosts++; });
  try {
    await page.setViewportSize({ width: ownerWidth, height: 900 });
    await page.goto(fixture.phoneOrigin + "__novice?phone=1");
    await page.getByLabel("设备名称", { exact: true }).fill("邀请管理设备");
    await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toBeHidden({ timeout: 20_000 });
    await waitForClientOnline(page);
    await openSettings(page, "devices");
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    await expect(page.getByRole("img", { name: "连接二维码", exact: true })).toBeVisible();
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (text: string) => { Object.assign(window, { wizardCopiedInvitation: text }); } } }));
    await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
    const link = await page.evaluate(() => (window as unknown as { wizardCopiedInvitation: string }).wizardCopiedInvitation);
    const payload = parsePairingLink(link);
    expect(payload.kind).toBe("connect");
    expect(payload.kind === "connect" && payload.invite).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await second.goto(fixture.phoneOrigin + "__novice?phone=1");
    await second.getByLabel("设备名称", { exact: true }).fill("稍后提交的新手机");
    await second.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
    await second.getByLabel("配对信息", { exact: true }).fill(link);
    await second.getByRole("button", { name: "使用配对信息", exact: true }).click();
    // The important ordering: importing/scanning is not yet a POST. The owner
    // changes wizard step while this invitation is still unused on the Host.
    expect(pairPosts).toBe(0);
    await page.getByRole("button", { name: "已扫码，输入配对码", exact: true }).click();
    await expect(page.getByLabel("新设备配对码", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "连接二维码", exact: true })).toBeHidden();
    const admission = second.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/api/pair"));
    await second.getByRole("button", { name: "配对此设备", exact: true }).click();
    const response = await admission;
    expect(response.status()).toBe(201);
    const code = await second.getByLabel("配对码", { exact: true }).innerText();
    expect(code).toMatch(/^\d{8}$/);
    expect(pairPosts).toBe(1);
    await page.getByLabel("新设备配对码", { exact: true }).fill(code);
    await page.getByRole("button", { name: "确认配对", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /已在.+确认新设备/ })).toBeVisible();
    await expect(second.getByLabel("配对码", { exact: true })).toBeHidden({ timeout: 20_000 });
    await waitForClientOnline(second);
    const registered = (await hub.store.devices("owner")).filter(device => device.name === "稍后提交的新手机");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.revoked).toBe(0);
    await page.screenshot({ path: info.outputPath(`wizard-approval-owner-${ownerWidth}.png`) });
    await second.screenshot({ path: info.outputPath(`wizard-joined-phone-${ownerWidth}.png`) });
  } finally { await secondContext.close(); await page.close(); await fixture.close(); }
});
