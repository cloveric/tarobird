import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { deviceActionProofText } from "../../src/client-protocol/device-actions.js";
import { terminalConfigureText } from "../../src/client-protocol/host-terminal.js";
import { HubServer } from "../../src/hub/server.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});

const url = (query = "") => server.resolvedUrls!.local[0] + "e2e/fixtures/host-terminal.html" + query;

test("TerminalPanel scopes tabs per conversation, prevents StrictMode double-spawn, aborts polls on hide, and handles 403/404 cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(url("?strict=1"));

  const panel = page.getByRole("complementary", { name: "主机终端", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: "zsh #1" })).toBeVisible();
  await expect(panel.getByText("READY_term_a1")).toBeVisible();

  // Verify truecolor segment was NOT misparsed as red or bold
  const readySpan = panel.locator(".terminal-output span").filter({ hasText: "READY_term_a1" }).first();
  await expect(readySpan).toHaveCSS("color", "rgb(0, 31, 1)");
  await expect(readySpan).not.toHaveCSS("font-weight", "600");

  // ResizeObserver calls terminalResize
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.state.resizeCalls.length)).toBeGreaterThan(0);

  // StrictMode empty conversation auto-creates ONLY ONE terminal (no duplicate spawn)
  await page.getByRole("button", { name: "Conv Empty", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "zsh #11" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).terminalFixture.state.createCalls.length)).toBe(1);

  // Slow stale response from Conv A must NOT overwrite Conv B's tabs
  await page.evaluate(() => (window as any).terminalFixture.holdList("conv_a"));
  await page.getByRole("button", { name: "Conv A", exact: true }).click();
  // Immediately switches to Conv B before Conv A resolves
  await page.getByRole("button", { name: "Conv B", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "zsh #2" })).toBeVisible();
  await page.evaluate(() => (window as any).terminalFixture.releaseList());
  await page.waitForTimeout(100);
  await expect(panel.getByRole("tab", { name: "zsh #2" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "zsh #1" })).toHaveCount(0);

  // IME composition Enter (isComposing / keyCode 229) must NOT submit input
  const input = panel.getByLabel("终端命令输入", { exact: true });
  await input.fill("中文输入");
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
  expect(await page.evaluate(() => (window as any).terminalFixture.state.inputCalls)).toEqual([]);

  // Normal Enter sends CR (\r) for PTY/ConPTY compatibility
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.state.inputCalls)).toEqual([
    { id: "term_b1", data: "中文输入\r" },
  ]);

  // Hiding panel aborts in-flight long-poll immediately
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.state.outputCalls.some((c: any) => c.aborted))).toBe(true);

  // Closing a tab that returns 404 removes it cleanly instead of leaving it stuck
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click();
  await expect(panel).toBeVisible();
  await page.evaluate(() => (window as any).terminalFixture.markClose404("term_b1"));
  await panel.getByRole("button", { name: "关闭并结束 zsh #2", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "zsh #2" })).toHaveCount(0);

  // 403 terminal_not_authorized stops polling (no infinite retry loop) and fires onUnauthorized
  await page.evaluate(() => (window as any).terminalFixture.setOutputMode("403"));
  await page.getByRole("button", { name: "Conv A", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("尚未获得主机终端权限");
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.state.unauthorizedCount)).toBeGreaterThan(0);
  const callsAfter403 = await page.evaluate(() => (window as any).terminalFixture.state.outputCalls.length);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).terminalFixture.state.outputCalls.length)).toBe(callsAfter403);
});

test("HostTerminalSettings subscribes to connection status, formats platformName, excludes ungranted mobile devices, surfaces load errors, and reports busy state", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(url());

  const card = page.getByRole("region", { name: "主机终端权限", exact: true });
  await expect(card).toBeVisible();
  // Desktop devices show localized platform names; ungranted iOS device is excluded
  await expect(card.getByText("Studio Mac")).toBeVisible();
  await expect(card.getByText("Mac", { exact: true })).toBeVisible();
  await expect(card.getByText("Work PC")).toBeVisible();
  await expect(card.getByText("Windows", { exact: true })).toBeVisible();
  await expect(card.getByText("Pocket Phone")).toHaveCount(0);

  // Going offline disables toggles via useSyncExternalStore
  await page.evaluate(() => (window as any).terminalFixture.setOnline(false));
  await expect(card.getByLabel("允许主机终端")).toBeDisabled();
  await page.evaluate(() => (window as any).terminalFixture.setOnline(true));
  await expect(card.getByLabel("允许主机终端")).toBeEnabled();

  // Toggling a device sends requestId and reports busyChange(true -> false)
  await card.getByLabel(/Work PC/).check();
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.state.configured.length)).toBe(1);
  const cfg = await page.evaluate(() => (window as any).terminalFixture.state.configured[0]);
  expect(typeof cfg.requestId).toBe("string");
  expect(cfg.requestId.length).toBeGreaterThan(0);
  const busyEvents = await page.evaluate(() => (window as any).terminalFixture.state.busyEvents);
  expect(busyEvents).toContain(true);
  expect(busyEvents[busyEvents.length - 1]).toBe(false);

  // Initial load failure shows error + retry instead of silently returning null
  await page.goto(url("?failStatus=1"));
  const failedCard = page.getByRole("region", { name: "主机终端权限", exact: true });
  await expect(failedCard).toBeVisible();
  await expect(failedCard.getByRole("alert")).toContainText("暂时无法读取主机终端权限设置");
  await page.evaluate(() => (window as any).terminalFixture.setFailStatusLoad(false));
  await failedCard.getByRole("button", { name: "重试", exact: true }).click();
  await expect(failedCard.getByRole("alert")).toHaveCount(0);
  await expect(failedCard.getByLabel("允许主机终端")).toBeVisible();
});

test("narrow desktop width (800px) keeps TerminalPanel within viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(url());
  const panel = page.getByRole("complementary", { name: "主机终端", exact: true });
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(801);
});

async function setupRealHubWithTerminalGrant() {
  const root = await mkdtemp(path.join(os.tmpdir(), "e2e-host-terminal-"));
  const botWorkspace = path.join(root, "ws");
  await mkdir(botWorkspace, { recursive: true });
  await mkdir(path.join(root, "bots", "bot_1"), { recursive: true });
  await writeFile(path.join(root, "bots", "bot_1", "config.json"), JSON.stringify({ engine: "codex", workspacePath: botWorkspace }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_1','DevBot','codex','h',1)");
  const conv = await hub.store.createConversation("owner", ["bot_1"], "Dev Chat", "conv_e2e_1", { type: "direct" });

  // Enroll a local desktop controller to grant terminal access cleanly via signed terminal-grant proof
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await hub.store.db.run(
    "INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen,revoked) VALUES('ctrl_mac','owner','Local Mac','macos',?,1,1,0)",
    [pubB64],
  );
  await hub.auth.markLocalDesktopController({ deviceId: "ctrl_mac", name: "Local Mac", platform: "macos", publicKey: pubB64 });
  const nonce = "c".repeat(43);
  const ch = await hub.auth.challenge("conn_ctrl", "ctrl_mac", nonce, "127.0.0.1");
  const sig = sign(null, Buffer.from(`tarocub/device/v1\0ctrl_mac\0${ch.nonce}\0${nonce}`), privateKey).toString("base64");
  const ctrlAuth = await hub.auth.authenticate("conn_ctrl", sig);

  const grantDevice = async (deviceId: string, devicePubKey: string, expectedRevision: number) => {
    const command = {
      expectedRevision,
      enabled: true,
      grants: [{ deviceId, publicKey: devicePubKey }],
      requestId: `req_${expectedRevision}_${deviceId}`,
    };
    const target = createHash("sha256").update(terminalConfigureText(command)).digest("hex");
    const session = await hub.auth.authorize(ctrlAuth.token, "127.0.0.1");
    const statement = await hub.auth.prepareDeviceAction({ operation: "terminal-grant", target }, ctrlAuth.token, session);
    const signature = sign(null, Buffer.from(deviceActionProofText(statement)), privateKey).toString("base64");
    await hub.hostTerminal.configure(session, command, { nonce: statement.nonce, signature });
  };

  return {
    hub,
    conv,
    grantDevice,
    dispose: async () => {
      await hub.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Workspace Rail and Terminal panel stay mutually exclusive with active trigger styling, and landscape mobile UAs stay hidden", async ({ browser }) => {
  const { hub, grantDevice, dispose } = await setupRealHubWithTerminalGrant();
  const desktopContext = await browser.newContext({ viewport: { width: 1200, height: 760 }, serviceWorkers: "block" });
  const mobileContext = await browser.newContext({
    viewport: { width: 900, height: 430 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  try {
    // 1. Desktop client: pair, grant terminal, verify Workspace Rail mutual exclusion and active button highlight
    const page = await desktopContext.newPage();
    await page.addInitScript(() => { localStorage.setItem("tarobird.workspaceRailOpen", "1"); });
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const pairCode = await page.getByLabel("配对码", { exact: true }).innerText();
    const desktopDeviceId = await hub.auth.approve(pairCode, "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);

    const desktopRow = await hub.store.db.get<{ public_key: string }>("SELECT public_key FROM devices WHERE id=?", [desktopDeviceId]);
    await grantDevice(desktopDeviceId, desktopRow!.public_key, 0);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    const terminalBtn = page.getByRole("button", { name: "终端", exact: true });
    await expect(terminalBtn).toBeVisible();
    const workspacePanel = page.getByRole("complementary", { name: "会话工作区" });
    await expect(workspacePanel).toBeVisible();

    // Open Terminal -> Workspace Rail must hide (no simultaneous overlap!) and trigger must be expanded/highlighted
    await terminalBtn.click();
    await expect(terminalBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("complementary", { name: "主机终端", exact: true })).toBeVisible();
    await expect(workspacePanel).toHaveCount(0);
    const expandedBg = await terminalBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(expandedBg).not.toBe("rgba(0, 0, 0, 0)");

    // Open Workspace Rail -> Terminal hides; close Workspace Rail -> Terminal restores!
    await page.getByRole("button", { name: "会话工作区", exact: true }).click();
    await expect(workspacePanel).toBeVisible();
    await expect(page.getByRole("complementary", { name: "主机终端", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "会话工作区", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "主机终端", exact: true })).toBeVisible();
    await expect(workspacePanel).toHaveCount(0);

    // 2. Landscape mobile UA (width 900 > 760px): even if granted, Terminal button MUST stay hidden
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(hub.url);
    await preparePairing(mobilePage, hub);
    await mobilePage.getByRole("button", { name: "配对此设备", exact: true }).click();
    const mobileCode = await mobilePage.getByLabel("配对码", { exact: true }).innerText();
    const mobileDeviceId = await hub.auth.approve(mobileCode, "local-owner");
    await mobilePage.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(mobilePage);

    const mobileRow = await hub.store.db.get<{ public_key: string }>("SELECT public_key FROM devices WHERE id=?", [mobileDeviceId]);
    await grantDevice(mobileDeviceId, mobileRow!.public_key, 1);
    await mobilePage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await mobilePage.waitForTimeout(300);
    await expect(mobilePage.getByRole("button", { name: "终端", exact: true })).toHaveCount(0);
  } finally {
    await desktopContext.close();
    await mobileContext.close();
    await dispose();
  }
});
