import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import QRCode from "qrcode";
import { HubServer } from "../../src/hub/server.js";
import { pairingLink } from "../src/pairing-link.js";
import { openSettings } from "./fixtures/settings.js";

for (const name of ["Direct", "Tailscale"] as const) test(`${name} offline QR repair checks the same host, requires confirmation and preserves enrollment`, async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "route-repair-"));
  const hub = await HubServer.start({ stateDir: dir, clientDir: path.resolve("dist") });
  let enrollments = 0; page.on("request", request => { if (request.url().endsWith("/api/pair")) enrollments++; });
  const original = "https://192.0.2.1:8788", replacement = name === "Tailscale" ? "https://100.101.102.103:8788" : "https://192.0.2.2:8788";
  const image = async (key: string) => ({ name: "connection.png", mimeType: "image/png", buffer: await QRCode.toBuffer(pairingLink({ v: 1, kind: "connect", hubPublicKey: key, routes: [{ name, url: replacement }], deployment: "computer" }), { scale: 6, margin: 4 }) });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    const device = ((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))[0]!.id;
    await openSettings(page, "connection");
    await page.getByLabel("主机的直连地址（可选）", { exact: true }).fill(original);
    await page.getByRole("button", { name: "保存线路", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("线路已保存");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "扫描二维码更新连接", exact: true }).click();
    const scan = page.getByRole("dialog", { name: "扫描配对二维码", exact: true });
    await scan.getByLabel("二维码图片", { exact: true }).setInputFiles(await image(`MCowBQYDK2VwAyEA${"x".repeat(44)}`));
    await expect(scan.getByRole("alert")).toContainText("这不是当前主机的二维码");
    await expect(page.getByRole("dialog", { name: "更新此主机的连接？", exact: true })).toHaveCount(0);
    await scan.getByLabel("二维码图片", { exact: true }).setInputFiles(await image(hub.auth.publicKey));
    const confirm = page.getByRole("dialog", { name: "更新此主机的连接？", exact: true });
    await expect(confirm).toContainText(replacement);
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".saved-routes")).toContainText(original);
    await page.getByRole("button", { name: "扫描二维码更新连接", exact: true }).click();
    await scan.getByLabel("二维码图片", { exact: true }).setInputFiles(await image(hub.auth.publicKey));
    await confirm.getByRole("button", { name: "更新连接", exact: true }).click();
    await expect(page.locator(".saved-routes")).toContainText(replacement);
    await expect(page.locator(".saved-routes")).toContainText(original); // custom origin remains; QR is not permission to remove it
    await expect(page.getByText("连接已更新。已保留其他线路，将检测新地址并自动选择连接。", { exact: true })).toBeVisible();
    expect(enrollments).toBe(1); expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))[0]!.id).toBe(device);
    await page.reload(); await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible({ timeout: 20000 }); await openSettings(page, "connection");
    await expect(page.getByLabel(name === "Tailscale" ? "主机的 Tailscale 连接地址（可选）" : "主机的直连地址（可选）", { exact: true })).toHaveValue(replacement);
  } finally { await page.close(); await hub.close(); await rm(dir, { recursive: true, force: true }); }
});
