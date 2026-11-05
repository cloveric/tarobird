import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { test, expect } from "@playwright/test";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";

test("two-device QR pairing pins the Hub and requires the trusted device's explicit approval", async ({ page, browser }, info) => {
  const fixture = await noviceNetworkFixture(), hub = fixture.hubs[0]!; const secondContext = await browser.newContext({ serviceWorkers: "block" }); const second = await secondContext.newPage();
  const image = (src: string | null) => ({ name: "pairing.png", mimeType: "image/png", buffer: Buffer.from(src!.split(",")[1]!, "base64") });
  try {
    await page.goto(fixture.phoneOrigin + "__novice?phone=1"); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await openSettings(page, "devices"); await openDevicePairing(page, false, 0); await expect(page.getByAltText("连接二维码")).toBeVisible(); const invitation = image(await page.getByAltText("连接二维码").getAttribute("src"));
    await second.goto(fixture.origin + "__novice?phone=1"); await second.getByRole("button", { name: "扫描连接二维码" }).click(); await second.getByLabel("二维码图片", { exact: true }).setInputFiles(invitation); await expect(second.getByRole("dialog")).toHaveCount(0); await second.getByLabel("设备名称", { exact: true }).fill("扫码新设备"); await second.getByRole("button", { name: "配对此设备", exact: true }).click();
    const code = await second.getByLabel("配对码", { exact: true }).innerText(); await second.getByText("其他确认方式", { exact: true }).click(); await expect(second.getByAltText("确认新设备二维码")).toBeVisible(); const approval = image(await second.getByAltText("确认新设备二维码").getAttribute("src"));
    expect((await hub.store.devices("owner")).map((d) => d.name)).not.toContain("扫码新设备");
    await page.getByRole("button", { name: "已扫码，输入配对码", exact: true }).click(); await page.getByRole("button", { name: "扫描新设备配对码" }).click(); await page.getByLabel("二维码图片", { exact: true }).setInputFiles(approval); await expect(page.getByLabel("新设备配对码", { exact: true })).toHaveValue(code);
    // Scanning alone cannot authorize a device.
    expect((await hub.store.devices("owner")).map((d) => d.name)).not.toContain("扫码新设备");
    await page.getByRole("button", { name: "确认配对", exact: true }).click(); await expect.poll(async () => (await hub.store.devices("owner")).some((d) => d.name === "扫码新设备")).toBe(true);
    await second.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(second.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
  } catch (error) {
    await info.attach("second-device-errors", { body: JSON.stringify(await second.getByRole("alert").allTextContents()), contentType: "application/json" });
    await info.attach("second-device-screen", { body: await second.screenshot(), contentType: "image/png" });
    throw error;
  } finally { await secondContext.close(); await page.close(); await fixture.close(); }
});
