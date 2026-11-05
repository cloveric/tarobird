import { preparePairing } from "./fixtures/pairing-invite.js";
import { enterMobileChat } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { RelayServer } from "../../src/relay/server.js";
import { RelayTunnel } from "../../src/relay/tunnel.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

test.use({ serviceWorkers: "block" });
test("direct and relay-only addresses share one host without deployment choices, preserving QR pairing and two-device history", async ({ browser }, info) => {
  // Device invitations intentionally exclude loopback addresses: another phone
  // cannot use this computer's localhost. Exercise a real shareable interface.
  const lanAddress = Object.values(os.networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))?.address;
  test.skip(!lanAddress, "A shareable IPv4 interface is required for the two-device invitation journey");
  const root = await mkdtemp(path.join(os.tmpdir(), "deployment-ui-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Temporary test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  async function pair(name: string, usage: string) {
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", name + ".key", "-out", name + ".csr", "-subj", "/CN=localhost"]);
    await writeFile(path.join(root, name + ".ext"), `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${lanAddress}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n`);
    openssl(["x509", "-req", "-in", name + ".csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", name + ".pem", "-days", "1", "-extfile", name + ".ext"]);
    return { cert: await readFile(path.join(root, name + ".pem")), key: await readFile(path.join(root, name + ".key")) };
  }
  const hostPair = await pair("host", "serverAuth"), relayPair = await pair("relay", "serverAuth"), clientPair = await pair("client", "clientAuth"), ca = await readFile(path.join(root, "ca.pem"));
  const origins: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), host: "0.0.0.0", exposure: "public", tls: hostPair, tlsListeners: [{ host: "127.0.0.1", port: 0, tls: hostPair }], origins });
  const directUrl = hub.url.replace("0.0.0.0", lanAddress!), loopbackUrl = hub.urls.find((url) => url.startsWith("https://127.0.0.1"))!;
  await hub.network.replaceManagedRoutes([], [{ name: "Direct", url: directUrl, certificateAuthority: new X509Certificate(ca).raw.toString("base64") }]);
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "localhost", tls: { ...relayPair, ca }, clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256 });
  const relayUrl = `https://localhost:${relay.status.publicPort}`;
  origins.push(directUrl, relayUrl);
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "localhost", tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: Number(new URL(loopbackUrl).port) });
  tunnel.start();
  const desktopContext = await browser.newContext({ ignoreHTTPSErrors: true }), phoneContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const stateDir = path.join(root, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','云端助手',?)", [hashSecret(secret)]);
  let calls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { calls++; return { text: "主机上的同一份会话，两种路径都能看到。" }; } } });
  async function approve(page: Page, needsInvitation = true) {
    if (needsInvitation) await preparePairing(page, hub, [{ name: "Direct", url: directUrl, certificateAuthority: new X509Certificate(ca).raw.toString("base64") }]); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("heading", { name: "用已配对设备确认", exact: true })).toBeVisible();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  }
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    expect((await desktop.request.get(directUrl + "/api/devices")).status()).toBe(401);
    expect((await desktop.request.get(directUrl + "/api/instance/uploads")).status()).toBe(401);
    await hub.store.createConversation("owner", ["alpha"], "云端工作区", "cloud");
    await desktop.goto(directUrl); await desktop.getByText("连接选项与备用中转（可选）", { exact: true }).click(); await expect(desktop.getByLabel("主端部署方式", { exact: true })).toHaveCount(0);
    await expect(desktop.getByLabel("Hub 地址", { exact: true })).toHaveValue(directUrl); await expect(desktop.locator(".vps-route")).toHaveCount(0);
    await desktop.screenshot({ path: info.outputPath("vps-direct-onboarding.png"), fullPage: true }); await approve(desktop);
    await openSettings(desktop, "devices"); await desktop.getByRole("button", { name: "添加设备", exact: true }).click();
    const qr = desktop.getByRole("img", { name: "连接二维码", exact: true }); await expect(qr).toBeVisible();
    const buffer = Buffer.from((await qr.getAttribute("src"))!.split(",")[1]!, "base64");
    await phone.goto(relayUrl); await phone.getByRole("button", { name: "扫描连接二维码", exact: true }).click();
    await phone.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "host.png", mimeType: "image/png", buffer });
    await phone.getByText("手动连接与高级选项", { exact: true }).click(); await phone.getByText("连接选项与备用中转（可选）", { exact: true }).click();
    await expect(phone.getByLabel("主端部署方式", { exact: true })).toHaveCount(0); await expect(phone.getByLabel("Hub 地址", { exact: true })).toHaveValue(directUrl);
    await approve(phone, false); await desktop.getByRole("button", { name: "关闭添加设备", exact: true }).click(); await desktop.getByRole("button", { name: "关闭设置", exact: true }).click();
    await openSettings(phone, "connection");
    await phone.getByLabel("主机的直连地址（可选）", { exact: true }).fill("");
    await expect(phone.getByLabel("主机的直连地址（可选）", { exact: true })).toHaveValue(""); await phone.getByRole("button", { name: "保存线路", exact: true }).click();
    await expect(phone.getByText("至少填写一条线路。", { exact: true })).toBeVisible();
    await phone.getByRole("button", { name: "添加中转", exact: true }).click(); await phone.getByLabel("中转地址", { exact: true }).fill(relayUrl); await phone.getByLabel("中转线路 1 名称", { exact: true }).fill("独立中转");
    await phone.getByRole("button", { name: "保存线路", exact: true }).click(); await expect(phone.locator(".connection-pill")).toContainText("独立中转");
    await phone.reload(); await expect(phone.locator(".connection-pill.online")).toContainText("独立中转"); await enterMobileChat(phone, "云端工作区");
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("手机经过中转，桌面直接访问云端主机"); await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.getByRole("region", { name: "运行回复", exact: true }).getByText("主机上的同一份会话，两种路径都能看到。", { exact: true })).toBeVisible();
    expect(calls).toBe(1); expect((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner")).toHaveLength(2);
    await openSettings(phone, "connection");
    await expect(phone.getByLabel("主机的直连地址（可选）", { exact: true })).toHaveValue("");
    await phone.locator(".deployment-guide").scrollIntoViewIfNeeded(); await phone.screenshot({ path: info.outputPath("vps-relay-phone-settings.png") });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.getByLabel("主机的直连地址（可选）", { exact: true }).fill(directUrl); await phone.getByRole("button", { name: "保存线路", exact: true }).click();
    // Adding a route does not force a name-based switch away from a healthy
    // relay. The shared performance policy chooses and preserves the route.
    await expect(phone.getByRole("status").filter({ hasText: "线路已保存" })).toBeVisible();
    await expect(phone.getByRole("status").filter({ hasText: "已通过主机与设备身份验证。" })).toBeVisible();
    await phone.reload(); await waitForClientOnline(phone); await openSettings(phone, "connection");
    await expect(phone.getByLabel("主机的直连地址（可选）", { exact: true })).toHaveValue(directUrl);
    await expect(phone.getByLabel("中转地址", { exact: true })).toHaveValue(relayUrl);
    await closeSettings(phone); await openSettings(phone, "general"); await phone.getByLabel("语言", { exact: true }).selectOption("en"); await closeSettings(phone, true);
    await phone.getByRole("button", { name: "Connection status & routes", exact: true }).filter({ visible: true }).click();
    await expect(phone.getByRole("dialog", { name: "Connection status & routes", exact: true })).toBeVisible();
    await expect(phone.getByLabel("Where your host is deployed", { exact: true })).toHaveCount(0);
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); tunnel.stop(); await relay.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
