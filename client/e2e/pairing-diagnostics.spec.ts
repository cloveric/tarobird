import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import type { PairingProps } from "../src/HostApp.js";
import type { HubConnection } from "../src/connection.js";

declare global {
  interface Window {
    nativeTransportFixture: {
      mockIPC: (cb: (cmd: string, args?: Record<string, unknown>) => unknown) => void;
      renderPairing(props?: Partial<PairingProps>): void;
      renderRoutes(connection: HubConnection): void;
      setLocale(locale: "zh" | "en"): void;
      HubConnection: typeof HubConnection;
    };
  }
}

const HUB_KEY = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});

async function importInvitation(page: Page, route: { name: "Tailscale" | "Direct" | "VPS"; url: string }, locale: "zh" | "en") {
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify({ v: 1, kind: "connect", hubPublicKey: HUB_KEY, routes: [route] }))}&invite=${"i".repeat(43)}`;
  await page.getByRole("button", { name: locale === "zh" ? "粘贴连接信息" : "Paste connection details", exact: true }).click();
  await page.getByLabel(locale === "zh" ? "配对信息" : "Pairing information", { exact: true }).fill(link);
  await page.getByRole("button", { name: locale === "zh" ? "使用配对信息" : "Use pairing information", exact: true }).click();
}

for (const locale of ["zh", "en"] as const) {
  for (const scenario of [
    {
      name: "tailscale unreachable",
      route: { name: "Tailscale" as const, url: "https://100.64.0.1:8788" },
      errorCode: "native_request_timeout",
      zh: /无法通过 Tailscale 连接到主机.*Tailscale/,
      en: /Could not reach the host over Tailscale.*tailnet/i,
      forbidden: /本地网络|Local Network permission/,
    },
    {
      name: "tailscale connection refused (host not running)",
      route: { name: "Tailscale" as const, url: "https://100.64.0.1:8788" },
      errorCode: "native_connection_refused",
      zh: /已连通 Tailscale 地址，但主机拒绝了连接.*TaroBird/,
      en: /Reached the Tailscale address, but the host refused the connection/,
    },
    {
      name: "lan away from Wi-Fi",
      route: { name: "Direct" as const, url: "https://192.168.1.100:8788" },
      errorCode: "native_request_timeout",
      zh: /似乎不在同一 Wi-Fi \/ 局域网内.*Tailscale.*VPS/,
      en: /away from that Wi-Fi or LAN.*Tailscale.*VPS/,
      forbidden: /本地网络|Local Network permission/,
    },
    {
      name: "ios local network permission denied",
      route: { name: "Direct" as const, url: "https://192.168.1.100:8788" },
      errorCode: "local_network_permission_denied",
      zh: /没有获得“本地网络”权限.*设置 → 隐私与安全性 → 本地网络/,
      en: /does not have Local Network permission.*Settings → Privacy & Security → Local Network/,
    },
  ]) {
    test(`pairing explains ${scenario.name} (${locale})`, async ({ page }) => {
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
      await page.waitForFunction(() => !!window.nativeTransportFixture);
      await page.evaluate(({ locale, errorCode }) => {
        const fixture = window.nativeTransportFixture;
        fixture.setLocale(locale);
        let seq = 0;
        fixture.mockIPC((cmd) => {
          if (cmd === "desktop_host") return { available: true, running: true, hostName: "macmini" };
          if (cmd === "net_allocate") return `diag-${++seq}`;
          if (cmd === "net_http_open") return Promise.reject(new Error(errorCode));
        });
        fixture.renderPairing({ localHostReady: true });
      }, { locale, errorCode: scenario.errorCode });

      await page.getByRole("button", { name: locale === "zh" ? "连接已有主机" : "Connect to an existing host", exact: true }).click();
      await importInvitation(page, scenario.route, locale);
      await page.getByRole("button", { name: locale === "zh" ? "配对此设备" : "Pair this device", exact: true }).click();
      const alert = page.getByRole("alert");
      await expect(alert).toHaveText(scenario[locale]);
      if (scenario.forbidden) {
        await expect(alert).not.toHaveText(scenario.forbidden);
      }
    });
  }
}

test("saved routes settings show per-route failure reason and summary in zh and en", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
  await page.waitForFunction(() => !!window.nativeTransportFixture);
  await page.evaluate(async () => {
    const fixture = window.nativeTransportFixture;
    let seq = 0;
    fixture.mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `saved-${++seq}`;
      if (cmd === "net_http_open") {
        const origin = (args!.input as { origin: string }).origin;
        throw new Error(origin.includes("192.168.") ? "local_network_permission_denied" : "native_request_timeout");
      }
    });
    const connection = new fixture.HubConnection(
      {
        deviceId: "fixture",
        name: "Fixture",
        publicKey: "device",
        hubPublicKey: "trusted",
        routes: [
          { name: "Direct", url: "https://192.168.1.100:8788" },
          { name: "Tailscale", url: "https://100.64.0.1:8788" },
        ],
      },
      undefined,
      () => "macmini",
    );
    await (connection as unknown as { connect(): Promise<void> }).connect();
    connection.close();
    fixture.renderRoutes(connection);
  });

  await expect(page.getByText("缺少本地网络权限", { exact: true })).toBeVisible();
  await expect(page.getByText("连接超时", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-summary")).toContainText("本地网络");

  await page.evaluate(() => window.nativeTransportFixture.setLocale("en"));
  await expect(page.getByText("Local network permission denied", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection timed out", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-summary")).toContainText("Local Network permission");
});

test("pending /api/pair failure omits client device name, avoids paired retry wording, and re-translates on locale switch", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
  await page.waitForFunction(() => !!window.nativeTransportFixture);
  await page.evaluate((hubKey) => {
    const fixture = window.nativeTransportFixture;
    fixture.setLocale("zh");
    let seq = 0;
    const bodies = new Map<string, number[]>();
    fixture.mockIPC((cmd, args) => {
      if (cmd === "desktop_host") return { available: true, running: true, hostName: "macmini" };
      if (cmd === "net_allocate") return `pending-${++seq}`;
      if (cmd === "net_cancel") return null;
      if (cmd === "net_http_open") {
        const input = args!.input as { path: string };
        const id = args!.id as string;
        if (input.path === "/health") {
          const payload = JSON.stringify({ ok: true, publicKey: hubKey, pairingInvites: 1 });
          bodies.set(id, [...new TextEncoder().encode(payload)]);
          return { status: 200, headers: [["content-type", "application/json"]] };
        }
        return Promise.reject(new Error("native_request_timeout"));
      }
      if (cmd === "net_http_read") {
        const id = args!.id as string;
        const next = bodies.get(id) ?? [];
        bodies.delete(id);
        return next;
      }
      if (cmd === "device_create") {
        return { deviceId: "device_fixture_pending", keyRef: "fixture-ref", publicKey: "MCowBQYDK2VwAyEABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=" };
      }
    });
    fixture.renderPairing({ localHostReady: true });
  }, HUB_KEY);

  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await importInvitation(page, { name: "Tailscale", url: "https://100.64.0.1:8788" }, "zh");
  await page.getByLabel("设备名称", { exact: true }).fill("FixturePhone");
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();

  const alert = page.locator("p.error-text[role='alert']").last();
  await expect(alert).toContainText("配对申请结果待确认");
  await expect(alert).toContainText("无法通过 Tailscale 连接到主机");
  await expect(alert).not.toContainText("FixturePhone");
  await expect(alert).not.toContainText("正在自动重试");
  await expect(alert).not.toContainText("编辑线路");

  await page.evaluate(() => window.nativeTransportFixture.setLocale("en"));
  await expect(alert).toContainText("Pairing result unconfirmed");
  await expect(alert).toContainText("Could not reach the host over Tailscale");
  await expect(alert).not.toContainText("配对申请结果待确认");
  await expect(alert).not.toContainText("FixturePhone");
  await expect(alert).not.toContainText("Retrying automatically");
  await expect(alert).not.toContainText("Edit routes");
});

test("pairing handles native lifecycle errors and clears stale Tailscale hint after manual URL edit", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
  await page.waitForFunction(() => !!window.nativeTransportFixture);
  await page.evaluate(() => {
    const fixture = window.nativeTransportFixture;
    fixture.setLocale("zh");
    let seq = 0;
    fixture.mockIPC((cmd) => {
      if (cmd === "desktop_host") return { available: true, running: true, hostName: "macmini" };
      if (cmd === "net_allocate") return `life-${++seq}`;
      if (cmd === "net_http_open") return Promise.reject(new Error("native_document_retired"));
    });
    fixture.renderPairing({ localHostReady: true });
  });

  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await importInvitation(page, { name: "Tailscale", url: "https://100.64.0.1:8788" }, "zh");
  await expect(page.locator(".pairing-route-hint")).toContainText("此连接使用 Tailscale");

  // Manually replacing the imported Tailscale URL with a LAN IP must replace the route hint.
  await page.locator("summary", { hasText: "手动连接与高级选项" }).click();
  await page.getByLabel("Hub 地址", { exact: true }).fill("https://192.168.1.100:8788");
  await expect(page.locator(".pairing-route-hint")).toContainText("此连接包含局域网地址");
  await expect(page.locator(".pairing-route-hint")).not.toContainText("此连接使用 Tailscale");

  // Native lifecycle failures must not be misdiagnosed as LAN/Wi-Fi outages.
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("连接组件已失效");
  await expect(alert).not.toContainText("Wi-Fi");
  await expect(alert).not.toContainText("Tailscale");
});

test("ADHD board panes do not duplicate actionable route diagnoses across offline-banner and error-banner", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "diag-adhd-pane-"));
  const clientDir = path.resolve("dist");
  const hub = await HubServer.start({ stateDir: root, clientDir });
  try {
    await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('diag','Diag Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["diag"], "面板诊断", "diag-pane");
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden", timeout: 15_000 });
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await showDisconnectedBots(page);
    await selectConversation(page, chat.title);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：macmini · 面板诊断" }).check();
    const card = page.locator(`.adhd-card[data-pane-conversation="${chat.id}"]`);
    await expect(card).toBeVisible();

    // Actionable identity-mismatch diagnosis renders in error-banner ONLY, not duplicated in offline-banner.
    await page.route("**/health", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, publicKey: "wrong-hub-key" }) }),
    );
    await hub.close();
    await expect(card.locator(".error-banner")).toContainText("主机身份校验未通过", { timeout: 15_000 });
    await expect(card.locator(".offline-banner")).toBeVisible();
    await expect(card.locator(".offline-banner")).not.toContainText("主机身份校验未通过");

    // Routine non-actionable diagnosis renders in offline-banner ONLY, not in error-banner.
    await page.unroute("**/health");
    await expect(card.locator(".offline-banner")).toContainText("无法连接到本机 TaroBird 主机", { timeout: 15_000 });
    await expect(card.locator(".error-banner")).toHaveCount(0);
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Hub pairing surfaces expired invite explanation and saved phone connection details show host-down reason", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "diag-real-hub-"));
  const clientDir = path.resolve("dist");
  const hub = await HubServer.start({ stateDir: root, clientDir });
  try {
    await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('diag','Diag Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["diag"], "诊断对话", "diag-chat");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.route("**/api/pair", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "pairing_invite_expired" }) }),
    );
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("此连接码已过期或失效");
    await expect(page.getByRole("button", { name: "扫描新的连接码", exact: true })).toBeVisible();

    await page.unroute("**/api/pair");
    await preparePairing(page, hub);
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden", timeout: 15_000 });
    await waitForClientOnline(page);
    await showDisconnectedBots(page);
    await selectConversation(page, chat.title);

    await hub.close();
    const notice = page.locator(".phone-connection-notice");
    await expect(notice).toBeVisible();
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(46);
    await notice.locator("summary").click();
    await expect(notice.locator(".connection-notice-reason")).toContainText("无法连接到本机 TaroBird 主机");
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
