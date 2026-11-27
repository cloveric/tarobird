import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { desktopTls } from "../../src/hub/desktop-tls.js";
import { parseBrowserPairingHash } from "../src/web-browser.js";
import type { HostSpec } from "./fixtures/device-invite.js";
import { createServer } from "./fixtures/vite.js";

declare global {
  interface Window {
    inviteFixture: {
      configure(ca: string): void;
      add(label: string, spec: HostSpec): void;
      show(label: string, localHost?: boolean): void;
      copied(): string;
    };
  }
}

const keyA = `MCowBQYDK2VwAyEA${"a".repeat(44)}`;
const keyB = `MCowBQYDK2VwAyEA${"b".repeat(44)}`;
const keyC = `MCowBQYDK2VwAyEA${"c".repeat(44)}`;
const lan = "https://192.168.10.20:8788";
const tailnet = "https://100.64.0.1:8788";
const relay = "https://relay.example.com";

let server: ViteDevServer;
let directory: string;
let ca: string;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "device-invite-browser-"));
  ({ certificateAuthority: ca } = await desktopTls(directory, ["192.168.10.20", "100.64.0.1"]));
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
});

test.afterAll(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/device-invite.html");
  await page.waitForFunction(() => !!window.inviteFixture);
  await page.evaluate((value) => window.inviteFixture.configure(value), ca);
});

const add = (page: Page, label: string, spec: HostSpec) =>
  page.evaluate(([l, s]) => window.inviteFixture.add(l, s), [label, spec] as const);
const show = (page: Page, label: string, localHost = false) =>
  page.evaluate(([l, local]) => window.inviteFixture.show(l, local), [label, localHost] as const);
const managed = (route: { name: "Direct" | "Tailscale" | "VPS"; url: string; certificateAuthority?: string }) => ({
  source: "managed" as const,
  route,
});
const shared = (route: { name: "Direct" | "Tailscale" | "VPS"; url: string; certificateAuthority?: string }) => ({
  source: "shared" as const,
  route,
});

test("browser invite mode handles loopback locality, lan_not_listening, Tailscale cert warning, and untrusted routes safely", async ({ page }) => {
  // 1) Remote client (!localHost) with saved loopback routes (including a VPS-named loopback) must neither show loopback nor crash.
  await add(page, "remote-loopback", {
    key: keyA,
    hostRoutesAvailable: false,
    identityRoutes: [
      { name: "Direct", url: "http://127.0.0.1:8787" },
      { name: "VPS", url: "http://127.0.0.1:9443" },
      { name: "Tailscale", url: tailnet },
    ],
  });
  await show(page, "remote-loopback", false);
  await page.getByRole("button", { name: "在浏览器中使用", exact: true }).click();
  // Tailscale IP without CA is untrusted for browsers and shows Tailscale-specific warning (not LAN copy) without mentioning "本机浏览器".
  await expect(page.locator(".device-invite-browser-cert")).toContainText("Tailscale");
  await expect(page.locator(".device-invite-browser-cert")).not.toContainText("这条局域网线路");
  await expect(page.locator(".device-invite-browser-cert")).not.toContainText("本机浏览器");
  await expect(page.locator(".pair-qr")).toHaveCount(0);

  // 2) Local desktop (localHost = true) with lan_not_listening still defaults to working loopback in browser mode, hides QR, and adjusts copy.
  await add(page, "local-lan-down", {
    key: keyB,
    identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }],
    view: {
      routes: [
        managed({ name: "Direct", url: lan, certificateAuthority: ca }),
        managed({ name: "Tailscale", url: tailnet, certificateAuthority: ca }),
      ],
      lan: { enabled: true, listening: false },
      tailscale: { enabled: true, listening: true },
      notices: ["lan_not_listening"],
    },
  });
  await show(page, "local-lan-down", true);
  await page.getByRole("button", { name: "在浏览器中使用", exact: true }).click();
  await expect(page.getByRole("combobox")).toHaveValue("http://127.0.0.1:8787");
  // Loopback link is copy-only (no QR to scan with a phone camera).
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await expect(page.locator(".device-invite-note")).toContainText("无法用手机扫码");
  await page.getByRole("button", { name: "复制浏览器链接", exact: true }).click();
  const localLink = await page.evaluate(() => window.inviteFixture.copied());
  const parsedLocal = parseBrowserPairingHash(new URL(localLink).hash, "http://127.0.0.1:8787");
  expect(parsedLocal?.hubPublicKey).toBe(keyB);
  expect(parsedLocal?.routes.map((route) => route.url)).toEqual(["http://127.0.0.1:8787"]);

  // 3) Trusted VPS relay omits private-CA routes from browser pairing links and produces a scannable browser QR.
  await add(page, "trusted-vps", {
    key: keyC,
    view: {
      routes: [
        managed({ name: "Direct", url: lan, certificateAuthority: ca }),
        shared({ name: "VPS", url: relay }),
        shared({ name: "VPS", url: "https://relay-private.example.com", certificateAuthority: ca }),
      ],
      lan: { enabled: true, listening: true },
    },
  });
  await show(page, "trusted-vps", false);
  await page.getByRole("button", { name: "在浏览器中使用", exact: true }).click();
  await expect(page.getByRole("img", { name: "浏览器配对二维码", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制浏览器链接", exact: true }).click();
  const relayLink = await page.evaluate(() => window.inviteFixture.copied());
  const parsedRelay = parseBrowserPairingHash(new URL(relayLink).hash, relay);
  expect(parsedRelay?.hubPublicKey).toBe(keyC);
  expect(parsedRelay?.routes).toEqual([{ name: "VPS", url: relay }]);
});

test("oversized browser pairing link renders an inline alert instead of crashing React", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const longSegment = Array.from({ length: 18 }, () => "a".repeat(55)).join(".");
  const longRelays = Array.from({ length: 8 }, (_, index) =>
    shared({
      name: "VPS" as const,
      url: `https://r${index}.${longSegment}.example.com`,
    }),
  );
  await add(page, "huge", { key: keyA, view: { routes: longRelays } });
  await show(page, "huge", false);
  await page.getByRole("button", { name: "在浏览器中使用", exact: true }).click();
  await expect(page.locator(".device-invite")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("配对信息过长");
  expect(errors).toEqual([]);
});
