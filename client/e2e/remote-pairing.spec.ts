import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";
import { pairingLink } from "../src/pairing-link.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test("a paired phone shares a connection and confirms a new computer without the host desktop", async ({ page, browser }) => {
  const fixture = await noviceNetworkFixture(), hub = fixture.hubs[0]!;
  const computerContext = await browser.newContext({ serviceWorkers: "block" }), computer = await computerContext.newPage();
  try {
    // Establish one pre-existing phone authorization; all subsequent actions use App UI.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.phoneOrigin + "__novice?phone=1"); await page.getByLabel("设备名称", { exact: true }).fill("已配对手机");
    await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden", timeout: 20000 }); await waitForClientOnline(page);
    const existingDevices = ((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).length;
    await openWorkspacePage(page, "设备与网络");
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Object.assign(window, { invitation: text }); } } }));
    await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
    const link = await page.evaluate(() => (window as unknown as { invitation: string }).invitation);
    await computer.goto(fixture.origin + "__novice?phone=1");
    await computer.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
    await computer.getByLabel("配对信息", { exact: true }).fill(link);
    await computer.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await expect(computer.getByText("已读取主机信息", { exact: true })).toBeVisible();
    // Importing connection information alone neither enrolls nor authorizes anything.
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).length).toBe(existingDevices);
    await computer.getByLabel("设备名称", { exact: true }).fill("旅途中的 MacBook Pro");
    await computer.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(computer.getByRole("heading", { name: "用已配对设备确认" })).toBeVisible();
    await expect(computer.getByText(/无需回到主机旁/)).toBeVisible();
    const code = await computer.getByLabel("配对码", { exact: true }).innerText();
    const pending = page.getByRole("region", { name: "等待确认的设备" });
    await expect(pending).toContainText("旅途中的 MacBook Pro", { timeout: 12000 });
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).length).toBe(existingDevices);
    await pending.getByRole("button", { name: "输入配对码确认", exact: true }).click();
    await page.getByLabel("新设备配对码", { exact: true }).fill(code);
    await page.getByRole("button", { name: "确认配对", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新设备自动连接" })).toBeVisible();
    await expect(computer.getByLabel("配对码", { exact: true })).toHaveCount(0);
    await expect(computer.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).map(device => device.name)).toContain("旅途中的 MacBook Pro");
  } finally { await computerContext.close(); await page.close(); await fixture.close(); }
});

test("phone confirmation shortcut skips sharing and wrong-host approval QR stays rejected", async ({ page, browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-confirm-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden", timeout: 20000 }); await waitForClientOnline(page); await page.setViewportSize({ width: 320, height: 740 });
    await openWorkspacePage(page, "设备与安全 设备名称与访问授权");
    await page.getByRole("button", { name: "输入配对码确认", exact: true }).click();
    await expect(page.getByRole("heading", { name: "输入新设备上的 8 位配对码", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "扫描新设备配对码", exact: true }).click();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(pairingLink({ v: 1, kind: "approve", code: "12345678", hubPublicKey: "A".repeat(48) }));
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("属于另一台主机");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByLabel("新设备配对码", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "确认配对", exact: true })).toBeDisabled();
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).length).toBe(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
