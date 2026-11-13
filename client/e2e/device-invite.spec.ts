import { PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH } from "../../src/client-protocol/pairing-invites.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { desktopTls } from "../../src/hub/desktop-tls.js";
import { HOST_ROUTES_PATH } from "../../src/client-protocol/host-routes.js";
import { isLoopbackOrUnspecified } from "../../src/client-protocol/loopback-address.js";
import { parsePairingLink, type PairingPayload } from "../src/pairing-link.js";
import type { HostSpec } from "./fixtures/device-invite.js";
import { createServer } from "./fixtures/vite.js";

// What the inviting device shows, and what a scanning device would receive.
// Showing a connection code is a read: it must never prepare listeners,
// restart the host or change shared network routes.
type Calls = { http: { host: string; path: string; method: string }[]; network: { host: string; operation: string }[]; ipc: string[]; busy: boolean };
declare global { interface Window { inviteFixture: {
  configure(ca: string): void; preparation(addresses: string[], omitted?: number): void; add(label: string, spec: HostSpec): void; show(label: string, localHost?: boolean): void;
  decodeAll(): Promise<string[]>; release(label: string): void; update(label: string, patch: Record<string, unknown>): void;
  calls(): Calls; copied(): string;
} } }

const keyA = `MCowBQYDK2VwAyEA${"a".repeat(44)}`, keyB = `MCowBQYDK2VwAyEA${"b".repeat(44)}`, keyC = `MCowBQYDK2VwAyEA${"c".repeat(44)}`;
const lan = "https://192.168.10.20:8788", tailnet = "https://100.101.102.103:8788", relay = "https://relay.example.com", relay2 = "https://relay2.example.com";
let server: ViteDevServer, directory: string, ca: string;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "device-invite-"));
  ({ certificateAuthority: ca } = await desktopTls(directory, ["192.168.10.20", "100.101.102.103"]));
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
});
test.afterAll(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/device-invite.html");
  await page.waitForFunction(() => !!window.inviteFixture);
  await page.evaluate(value => window.inviteFixture.configure(value), ca);
});

const add = (page: Page, label: string, spec: HostSpec) => page.evaluate(([l, s]) => window.inviteFixture.add(l, s), [label, spec] as const);
const show = (page: Page, label: string, localHost = false) => page.evaluate(([l, local]) => window.inviteFixture.show(l, local), [label, localHost] as const);
const calls = (page: Page) => page.evaluate(() => window.inviteFixture.calls());
const qr = (page: Page) => page.getByRole("img", { name: "连接二维码", exact: true });
async function scanned(page: Page): Promise<Extract<PairingPayload, { kind: "connect" }>> {
  await expect(qr(page)).toHaveCount(1);
  const links = await page.evaluate(() => window.inviteFixture.decodeAll());
  expect(links).toHaveLength(1);
  const payload = parsePairingLink(links[0]!);
  if (payload.kind !== "connect") throw new Error(`expected a connection code, got ${payload.kind}`);
  return payload;
}
const shareable = (payload: Extract<PairingPayload, { kind: "connect" }>) => payload.routes.every(route => route.url.startsWith("https://") && !isLoopbackOrUnspecified(new URL(route.url).hostname));
// Only reads of the owner route view; no listener preparation, restart or publication.
async function onlyRead(page: Page, host?: string) {
  const log = await calls(page);
  expect(log.ipc).toEqual([]);
  expect(log.network).toEqual([]);
  for (const call of log.http.filter(call => call.path !== PAIRING_INVITES_PATH && call.path !== PAIRING_INVITE_REVOKE_PATH)) expect(call).toMatchObject({ ...(host ? { host } : {}), path: HOST_ROUTES_PATH, method: "GET" });
  return { ...log, http: log.http.filter(call => call.path === HOST_ROUTES_PATH) };
}
// Wait until the invite has finished reading, then report whether it offers a
// code (its copy action renders together with the code).
async function codeShown(page: Page): Promise<boolean> {
  const invite = page.locator(".device-invite");
  await expect(invite).toBeVisible();
  await expect(invite.getByText(/正在读取/)).toHaveCount(0);
  if (!await invite.getByRole("button", { name: "复制连接信息", exact: true }).count()) return false;
  await expect(qr(page)).toBeVisible();
  return true;
}
const managed = (route: { name: "Direct" | "Tailscale" | "VPS"; url: string; certificateAuthority?: string }) => ({ source: "managed" as const, route });
const shared = (route: { name: "Direct" | "Tailscale" | "VPS"; url: string; certificateAuthority?: string }) => ({ source: "shared" as const, route });

test("a paired phone shows the host's current address at once, and copying gives the same code", async ({ page }) => {
  await add(page, "A", { key: keyA, identityRoutes: [{ name: "Direct", url: lan }, { name: "VPS", url: relay }],
    view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca }), shared({ name: "VPS", url: relay })], lan: { enabled: true, listening: true } } });
  await show(page, "A");
  const payload = await scanned(page);
  expect(payload.hubPublicKey).toBe(keyA);
  expect(shareable(payload)).toBe(true);
  expect(payload.routes.map(route => route.url)).toEqual(expect.arrayContaining([lan]));
  expect(payload.routes.find(route => route.url === lan)?.certificateAuthority).toBe(ca);
  await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
  expect(parsePairingLink(await page.evaluate(() => window.inviteFixture.copied()))).toEqual(payload);
  expect((await onlyRead(page, "A")).http).toHaveLength(1);
  // A narrow phone still sees the whole code and its controls.
  await page.setViewportSize({ width: 320, height: 640 });
  for (const element of await page.locator(".device-invite img, .device-invite button, .device-invite select").all()) {
    const box = await element.boundingBox(); if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(321);
  }
});

test("a desktop whose listener is already on shows its code without preparing, restarting or publishing", async ({ page }) => {
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }],
    view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca })], lan: { enabled: true, listening: true } } });
  await show(page, "L", true);
  const payload = await scanned(page);
  expect(payload).toMatchObject({ hubPublicKey: keyA, routes: [{ name: "Direct", url: lan, certificateAuthority: ca }] });
  // The owner is not sent through "generate" first.
  await expect(page.getByRole("button", { name: "生成局域网二维码", exact: true })).toBeHidden();
  await onlyRead(page, "L");
});

test("every offered connection choice yields a decodable code for that network", async ({ page }) => {
  await add(page, "A", { key: keyA, view: { routes: [
    managed({ name: "Direct", url: lan, certificateAuthority: ca }), managed({ name: "Tailscale", url: tailnet, certificateAuthority: ca }),
    shared({ name: "VPS", url: relay }), shared({ name: "VPS", url: relay2 }),
  ], lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } } });
  await show(page, "A");
  await scanned(page);
  const choice = page.getByRole("combobox");
  const values = await choice.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  const directs = new Set<string>(); let relayOnly: Extract<PairingPayload, { kind: "connect" }> | undefined;
  for (const value of values) {
    await choice.selectOption(value);
    // Wait for the image to correspond to the selection before decoding.
    const viaRelay = [relay, relay2].includes(value);
    await expect.poll(async () => {
      const links = await page.evaluate(() => window.inviteFixture.decodeAll());
      if (links.length !== 1) return false;
      const p = parsePairingLink(links[0]!), direct = p.kind === "connect" ? p.routes.find(r => r.name !== "VPS") : undefined;
      return p.kind === "connect" && (viaRelay ? !direct : direct?.url === value);
    }).toBe(true);
    const payload = await scanned(page);
    expect(payload.hubPublicKey).toBe(keyA);
    expect(shareable(payload)).toBe(true);
    const direct = payload.routes.filter(route => route.name !== "VPS");
    expect(direct.length).toBeLessThanOrEqual(1);
    if (direct[0]) { directs.add(direct[0].url); expect(direct[0].certificateAuthority).toBe(ca); }
    else relayOnly = payload;
  }
  expect([...directs].sort()).toEqual([tailnet, lan].sort());
  // A relay-only code still carries every relay the host shares.
  expect(relayOnly?.routes.map(route => route.url).sort()).toEqual([relay, relay2].sort());
  await onlyRead(page, "A");
});

test("loopback and unspecified addresses are never handed to a new device", async ({ page }) => {
  // The invitation capability and route discovery are independent; saved routes may still be used.
  await add(page, "old", { key: keyA, hostRoutesAvailable: false, identityRoutes: [{ name: "Direct", url: "https://127.0.0.1:8788" }, { name: "VPS", url: relay }] });
  await show(page, "old");
  const payload = await scanned(page);
  expect(shareable(payload)).toBe(true);
  expect(payload.routes.map(route => route.url)).toEqual([relay]);
  // Nothing shareable: explain instead of drawing an unusable code, and a
  // phone is not offered host-side listener setup.
  await add(page, "self", { key: keyB, hostRoutesAvailable: false, identityRoutes: [{ name: "Direct", url: "https://localhost:8788" }, { name: "Tailscale", url: "https://0.0.0.0:8788" }, { name: "VPS", url: "https://[::1]:9443" }] });
  await show(page, "self");
  await expect(page.locator(".device-invite")).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await expect(page.locator(".device-invite")).toContainText(/地址|线路|二维码/);
  await expect(page.getByRole("button", { name: "复制连接信息", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /生成.*二维码/ })).toHaveCount(0);
  // A host that advertises its own loopback is not trusted for the code.
  await add(page, "bad", { key: keyC, view: { routes: [managed({ name: "Direct", url: "https://127.0.0.1:8788" })], lan: { enabled: true, listening: true } } });
  await show(page, "bad");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  expect((await calls(page)).ipc).toEqual([]);
});

test("a route answer signed for another host never becomes this host's code", async ({ page }) => {
  await add(page, "A", { key: keyA, identityRoutes: [{ name: "Direct", url: lan }], view: { hostPublicKey: keyB, routes: [managed({ name: "Direct", url: tailnet, certificateAuthority: ca })], lan: { enabled: true, listening: true } } });
  await show(page, "A");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await onlyRead(page, "A");
});

test("offline or without management rights: no owner read, no change; recovery reads the host again", async ({ page }) => {
  await add(page, "A", { key: keyA, status: "offline", identityRoutes: [{ name: "Direct", url: lan }, { name: "VPS", url: relay }],
    view: { routes: [managed({ name: "Tailscale", url: tailnet, certificateAuthority: ca })], tailscale: { enabled: true, listening: true } } });
  await show(page, "A");
  await expect(page.getByRole("status").filter({ hasText: /离线/ })).toBeVisible();
  const offline = await calls(page);
  expect(offline.http).toEqual([]);
  expect(await codeShown(page)).toBe(false);
  // Back online: the host's current direct route replaces the saved one,
  // unprompted, and a relay configured only on this phone is still offered.
  await page.evaluate(() => window.inviteFixture.update("A", { status: "online" }));
  await expect.poll(async () => {
    const link = (await page.evaluate(() => window.inviteFixture.decodeAll()))[0], payload = link ? parsePairingLink(link) : undefined;
    return payload?.kind === "connect" ? { key: payload.hubPublicKey, direct: payload.routes.filter(route => route.name !== "VPS").map(route => route.url), relays: payload.routes.filter(route => route.name === "VPS").map(route => route.url) } : undefined;
  }).toEqual({ key: keyA, direct: [tailnet], relays: [relay] });
  await onlyRead(page, "A");

  await add(page, "M", { key: keyB, role: "member", identityRoutes: [{ name: "Direct", url: lan }], view: { routes: [managed({ name: "Direct", url: tailnet })] } });
  await show(page, "M");
  await expect(page.locator(".device-invite")).toBeVisible();
  const member = await calls(page);
  expect(member.http.filter(call => call.host === "M")).toEqual([]);
  expect(member.ipc).toEqual([]); expect(member.network).toEqual([]);
  expect(await codeShown(page)).toBe(false);
});

test("a failed read can be retried without changing the host", async ({ page }) => {
  await add(page, "A", { key: keyA, failures: 1, view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca })], lan: { enabled: true, listening: true } } });
  await show(page, "A");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  expect((await scanned(page)).routes[0]).toMatchObject({ url: lan });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await onlyRead(page, "A")).http).toHaveLength(2);
});

test("a late answer from the previous host never shows up as the current host's code", async ({ page }) => {
  const view = (url: string) => ({ routes: [managed({ name: "Direct" as const, url, certificateAuthority: ca })], lan: { enabled: true, listening: true } });
  await add(page, "A", { key: keyA, hold: true, view: view(lan) });
  await add(page, "B", { key: keyB, view: view("https://192.168.10.21:8788") });
  await add(page, "C", { key: keyC, hold: true, view: view("https://192.168.10.22:8788") });
  await show(page, "A");
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await show(page, "B");
  expect((await scanned(page)).hubPublicKey).toBe(keyB);
  await page.evaluate(() => window.inviteFixture.release("A"));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect(await scanned(page)).toMatchObject({ hubPublicKey: keyB, routes: [{ url: "https://192.168.10.21:8788" }] });
  // The other order: while the next host is still loading, the previous
  // host's code must not stay on screen under the new host.
  await show(page, "C");
  await expect(page.locator(".device-invite").getByText(/正在读取/)).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制连接信息", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.inviteFixture.release("C"));
  expect(await scanned(page)).toMatchObject({ hubPublicKey: keyC, routes: [{ url: "https://192.168.10.22:8788" }] });
  expect((await calls(page)).ipc).toEqual([]);
  expect((await calls(page)).network).toEqual([]);
});

test("a first-time desktop with nothing to share prepares only when the owner asks", async ({ page }, testInfo) => {
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: [] } });
  await show(page, "L", true);
  const generate = page.getByRole("button", { name: "生成局域网二维码", exact: true });
  await expect(generate).toBeVisible();
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  expect((await calls(page)).ipc).toEqual([]);
  await generate.click();
  await expect.poll(async () => (await calls(page)).ipc).toEqual(["status", "network"]);
  await expect.poll(async () => { const link = (await page.evaluate(() => window.inviteFixture.decodeAll()))[0]; return link ? parsePairingLink(link) : undefined; })
    .toMatchObject({ kind: "connect", hubPublicKey: keyA, routes: [{ url: lan, certificateAuthority: ca }] });
  // Once the code is on screen the owner can continue or leave the flow.
  await expect.poll(async () => (await calls(page)).busy, { timeout: 5000 }).toBe(false);
  // Recorded, not asserted: whether an explicit pairing preparation also
  // publishes shared network routes is a product decision (see review R1).
  testInfo.annotations.push({ type: "network-calls-after-explicit-prepare", description: JSON.stringify((await calls(page)).network) });
});

test("a first-time desktop whose host predates network sync is not left waiting after preparing", async ({ page }) => {
  await add(page, "L", { key: keyA, networkAvailable: false, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: [] } });
  await show(page, "L", true);
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await expect.poll(async () => { const link = (await page.evaluate(() => window.inviteFixture.decodeAll()))[0]; return link ? parsePairingLink(link) : undefined; })
    .toMatchObject({ kind: "connect", hubPublicKey: keyA, routes: [{ url: lan }] });
  // Pairing does not depend on network route sync: the flow must not stay
  // busy (blocking Back/close) or end in a sync error for such a host.
  await expect.poll(async () => (await calls(page)).busy, { timeout: 5000 }).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await calls(page)).network).toEqual([]);
});

test("a stale listener is not presented as a working code", async ({ page }) => {
  // The host still lists its signed LAN address, but reports that nothing is
  // listening there any more (for example after changing Wi-Fi).
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }],
    view: { routes: [shared({ name: "Direct", url: lan, certificateAuthority: ca })], lan: { enabled: true, listening: false }, notices: ["lan_not_listening"] } });
  await show(page, "L", true);
  await expect.poll(async () => (await calls(page)).http.length).toBeGreaterThan(0);
  // Either no code for the dead address, or a visible warning next to it.
  if (await codeShown(page)) await expect(page.locator(".device-invite")).toContainText(/监听|失效|不可用|无法|网络变了|重新|变化|过期/);
  expect((await calls(page)).ipc).toEqual([]);
});

test("an invite retains the relay saved only on the inviting phone", async ({ page }) => {
  await add(page, "A", { key: keyA, identityRoutes: [{ name: "VPS", url: relay2 }], activeUrl: relay2,
    view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca }), shared({ name: "VPS", url: relay })] } });
  await show(page, "A");
  const payload = await scanned(page);
  expect(payload.routes.map(route => route.url)).toEqual([relay2, relay]);
  await onlyRead(page, "A");
});

test("combining saved and host relays respects QR capacity and keeps the active relay", async ({ page }) => {
  const hostRelays = Array.from({ length: 8 }, (_, i) => shared({ name: "VPS" as const, url: `https://relay${i}.example.com` }));
  await add(page, "A", { key: keyA, identityRoutes: [{ name: "VPS", url: "https://phone-relay.example.com" }], activeUrl: "https://phone-relay.example.com", view: { routes: hostRelays } });
  await show(page, "A");
  const payload = await scanned(page);
  expect(payload.routes).toHaveLength(8);
  expect(payload.routes[0]?.url).toBe("https://phone-relay.example.com");
  await onlyRead(page, "A");
});

test("a local desktop defaults to LAN, and an unavailable LAN falls back to a listening route", async ({ page }) => {
  const routes = [managed({ name: "Tailscale" as const, url: tailnet, certificateAuthority: ca }), managed({ name: "Direct" as const, url: lan, certificateAuthority: ca })];
  await add(page, "A", { key: keyA, view: { routes, lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } } });
  await show(page, "A", true);
  expect((await scanned(page)).routes[0]?.url).toBe(lan);
  await add(page, "B", { key: keyB, activeUrl: lan, view: { routes, lan: { enabled: true, listening: false }, tailscale: { enabled: true, listening: true }, notices: ["lan_not_listening"] } });
  await show(page, "B", true);
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await scanned(page)).routes[0]?.url).toBe(tailnet);
  await onlyRead(page);
});

for (const width of [1360, 390]) test(`short-lived invite refresh and expiry do not prepare listeners at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await page.clock.install();
  await add(page, "A", { key: keyA, view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca })] } });
  await show(page, "A");
  const first = await scanned(page); expect(first.invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
  expect(parsePairingLink(await page.evaluate(() => window.inviteFixture.copied()))).toEqual(first);
  await page.screenshot({ animations: "disabled", path: info.outputPath(`limited-code-light-${width}.png`) });
  await page.getByRole("button", { name: "重新生成二维码", exact: true }).click();
  await expect.poll(async () => (await scanned(page)).invite).not.toBe(first.invite);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  // The fake TTL clock also freezes CSS transitions. Finish theme feedback
  // before inspecting a stable dark-theme frame.
  await page.clock.runFor(200);
  await expect(page.getByRole("button", { name: "重新生成二维码", exact: true })).toHaveCSS("color", await page.evaluate(() => getComputedStyle(document.body).color));
  await page.screenshot({ animations: "disabled", path: info.outputPath(`limited-code-dark-${width}.png`) });
  await page.clock.fastForward(300_001);
  await expect(qr(page)).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByText("二维码已过期或失效，请重新生成。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制连接信息", exact: true })).toHaveCount(0);
  const log = await calls(page); expect(log.http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(2);
  expect(log.ipc).toEqual([]); expect(log.network).toEqual([]);
});

test("old hosts never advertise a non-expiring first-pairing code", async ({ page }) => {
  await add(page, "A", { key: keyA, pairingInvitesAvailable: false, view: { routes: [managed({ name: "Direct", url: lan })] } });
  await show(page, "A");
  await expect(page.getByText("请先更新此主机，才能使用限时连接码配对新设备。", { exact: true })).toBeVisible();
  await expect(qr(page)).toHaveCount(0);
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH)).toEqual([]);
});

test("a late issued invite is revoked after switching host and never becomes the next host's QR", async ({ page }) => {
  await add(page, "A", { key: keyA, holdInvite: true, view: { routes: [managed({ name: "Direct", url: lan })] } });
  await show(page, "A");
  await expect.poll(async () => (await calls(page)).http.some(call => call.host === "A" && call.path === PAIRING_INVITES_PATH && call.method === "POST")).toBe(true);
  await add(page, "B", { key: keyB, view: { routes: [managed({ name: "Direct", url: tailnet })] } });
  await show(page, "B"); expect((await scanned(page)).hubPublicKey).toBe(keyB);
  await page.evaluate(() => window.inviteFixture.release("A"));
  await expect.poll(async () => (await calls(page)).http.some(call => call.host === "A" && call.path === PAIRING_INVITE_REVOKE_PATH)).toBe(true);
  expect((await scanned(page)).hubPublicKey).toBe(keyB);
  await page.evaluate(() => window.inviteFixture.update("B", { status: "offline" }));
  await expect(qr(page)).toHaveCount(0);
});


test("ten reconnects retain the same invitation without occupying more slots", async ({ page }) => {
  await add(page, "A", { key: keyA, view: { routes: [managed({ name: "Direct", url: lan, certificateAuthority: ca })], lan: { enabled: true, listening: true } } });
  await show(page, "A");
  const original = await scanned(page);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.inviteFixture.update("A", { status: "offline" }));
    await expect(qr(page)).toHaveCount(0);
    await page.evaluate(() => window.inviteFixture.update("A", { status: "online" }));
    expect((await scanned(page)).invite).toBe(original.invite);
  }
  const log = await calls(page);
  expect(log.http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(1);
  expect(log.http.filter(call => call.path === PAIRING_INVITE_REVOKE_PATH)).toHaveLength(0);
});


test("first-time compact pairing waits for the chosen LAN address before advancing", async ({ page }) => {
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.50.2", "192.168.10.20"]));
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: [] } });
  await show(page, "L", true);
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  const selector = page.getByRole("combobox", { name: /^选择电脑所在网络/ });
  await expect(selector).toHaveValue("-1");
  await expect(page.locator(".pair-qr")).toHaveCount(0);
  expect((await calls(page)).network).toEqual([]);
  expect((await calls(page)).http.filter(call => call.method === "POST")).toEqual([]);
  await expect.poll(async () => (await calls(page)).busy).toBe(false);
  await selector.selectOption({ label: "192.168.10.20" });
  await expect(selector).toHaveCount(0);
  expect(await scanned(page)).toMatchObject({ routes: [{ url: lan }] });
  await expect.poll(async () => (await calls(page)).busy).toBe(false);
});

test("compact pairing retains partial-readiness information after advancing to its QR", async ({ page }) => {
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.10.20"], 2));
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: [] } });
  await show(page, "L", true);
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await page.getByRole("combobox", { name: /^选择电脑所在网络/ }).selectOption("0");
  await expect(page.getByText("其他连接方式", { exact: true })).toBeVisible();
  expect(await scanned(page)).toMatchObject({ routes: [{ url: lan }] });
  await expect(page.getByText("2 个地址暂未就绪，已显示可用地址。", { exact: true })).toBeVisible();
});


test("a partial LAN warning does not follow a different relay QR", async ({ page }) => {
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.10.20"], 1));
  await add(page, "L", { key: keyA, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }, { name: "VPS", url: relay }], view: { routes: [] } });
  await show(page, "L", true);
  await page.getByText("其他连接方式", { exact: true }).click();
  await page.getByRole("button", { name: "设置其他连接方式", exact: true }).click();
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await page.getByRole("combobox", { name: /^选择电脑所在网络/ }).selectOption("0");
  const selector = page.getByRole("combobox", { name: /^新设备通过什么网络连接/ });
  await expect(selector).toBeVisible();
  const warning = page.getByText("1 个地址暂未就绪，已显示可用地址。", { exact: true });
  await expect(warning).toBeVisible();
  await selector.selectOption(relay);
  await expect(warning).toHaveCount(0);
  expect(await scanned(page)).toMatchObject({ routes: [{ name: "VPS", url: relay }] });
});

for (const existing of [false, true]) test(`compact preparation never exposes a temporary invitation before returning to the QR (${existing ? "existing" : "first"} route)`, async ({ page }) => {
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.50.2", "192.168.10.20"]));
  await add(page, "L", { key: keyA, holdNetwork: true, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: existing ? [managed({ name: "Direct", url: lan, certificateAuthority: ca })] : [] } });
  await show(page, "L", true);
  if (existing) {
    await scanned(page);
    await page.getByText("其他连接方式", { exact: true }).click();
    await page.getByRole("button", { name: "设置其他连接方式", exact: true }).click();
  }
  const priorIssues = (await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST").length;
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await page.getByRole("combobox", { name: /^选择电脑所在网络/ }).selectOption("1");
  await expect.poll(async () => (await calls(page)).network.filter(call => call.operation === "routes").length).toBe(1);
  // Wait for a rendered pending state; issuing while this view is about to
  // unmount would revoke a code the new device may already have copied.
  await expect(page.getByText("正在等待本机重新连接并共享线路…", { exact: true })).toBeVisible();
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(priorIssues);
  await expect(qr(page)).toHaveCount(0);
  await page.evaluate(() => window.inviteFixture.release("L"));
  await expect(page.getByText("其他连接方式", { exact: true })).toBeVisible();
  const issued = await scanned(page);
  expect(issued.routes[0]?.url).toBe(lan);
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(priorIssues + 1);
  await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
  expect(parsePairingLink(await page.evaluate(() => window.inviteFixture.copied()))).toEqual(issued);
});

test("a definitive publication failure keeps a stable manual LAN invite beside the warning", async ({ page }) => {
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.50.2", "192.168.10.20"]));
  const shared = { name: "Tailscale" as const, url: tailnet, certificateAuthority: ca };
  await add(page, "L", { key: keyA, view: { routes: [managed(shared)], tailscale: { enabled: true, listening: true }, notices: ["lan_selection_required"] } });
  await page.evaluate(([key, route]) => window.inviteFixture.update("L", { network: { host: { publicKey: key, routes: [route] } } }), [keyA, shared] as const);
  await show(page, "L", true);
  await scanned(page);
  await page.getByText("其他连接方式", { exact: true }).click();
  await page.getByRole("button", { name: "设置其他连接方式", exact: true }).click();
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await page.getByRole("combobox", { name: /^选择电脑所在网络/ }).selectOption("1");
  await expect(page.getByRole("alert")).toContainText("此地址尚未自动共享");
  const payload = await scanned(page);
  expect(payload.routes[0]?.url).toBe(lan);
  await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
  expect(parsePairingLink(await page.evaluate(() => window.inviteFixture.copied()))).toEqual(payload);
  const count = (await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST").length;
  await page.evaluate(() => window.inviteFixture.update("L", { status: "offline" }));
  await expect(qr(page)).toHaveCount(0);
  await page.evaluate(() => window.inviteFixture.update("L", { status: "online" }));
  expect((await scanned(page)).invite).toBe(payload.invite);
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(count);
});

test("the waiting notice alone never mints a temporary code before the handoff", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.inviteFixture.preparation(["192.168.50.2", "192.168.10.20"]));
  await add(page, "L", { key: keyA, holdNetwork: true, identityRoutes: [{ name: "Direct", url: "http://127.0.0.1:8787" }], view: { routes: [] } });
  await show(page, "L", true);
  await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
  await page.getByRole("combobox", { name: /^选择电脑所在网络/ }).selectOption({ label: "192.168.10.20" });
  await expect(page.getByText("正在等待本机重新连接并共享线路…", { exact: true })).toBeVisible();
  await page.clock.fastForward(21_000);
  // Publication is late, not rejected: it may still succeed and hand off.
  await expect(page.getByRole("alert").filter({ hasText: "网络线路仍在同步，完成后会自动更新，请稍候。" })).toBeVisible();
  await expect(qr(page)).toHaveCount(0);
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toEqual([]);
  await page.evaluate(() => window.inviteFixture.release("L"));
  await expect(page.getByText("其他连接方式", { exact: true })).toBeVisible();
  expect(await scanned(page)).toMatchObject({ routes: [{ name: "Direct", url: lan }] });
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITES_PATH && call.method === "POST")).toHaveLength(1);
  expect((await calls(page)).http.filter(call => call.path === PAIRING_INVITE_REVOKE_PATH)).toEqual([]);
});
