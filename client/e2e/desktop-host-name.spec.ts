import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
  await page.waitForFunction(() => !!(window as any).nativeTransportFixture);
});

for (const platform of ["macos", "windows"]) test(`${platform}: named desktop setup uses the durable host name for its registry and local device`, async ({ page }) => {
  await page.evaluate(platform => {
    if (platform === "windows") Object.defineProperty(navigator, "userAgent", { value: "Windows NT 10.0" });
    const fixture = (window as any).nativeTransportFixture;
    const result = { started: undefined, savedName: "", deviceName: "", nativeKey: "", connected: 0 };
    Object.assign(window, { hostNameFixture: result });
    fixture.mockIPC((command: string, args: any) => {
      if (command === "desktop_host" && args.action === "status") return { available: true, running: false, hostName: "工作电脑" };
      if (command === "desktop_host" && args.action === "start") { result.started = args.device; return { available: true, running: true, hostName: "保留的主机名称", publicKey: "local-host", url: "http://127.0.0.1:8789" }; }
      if (command === "device_create") return { deviceId: "device_local", keyRef: "device_local", publicKey: "local-device" };
      if (command === "desktop_host" && args.action === "pair") { result.deviceName = args.device.name; result.nativeKey = args.device.keyRef; return {}; }
      throw new Error("unexpected_native_request");
    });
    fixture.renderPairing({ save: async (_identity: unknown, name: string) => { result.savedName = name; }, connected: () => { result.connected++; } });
  }, platform);
  await expect(page.getByLabel("主机名称", { exact: true })).toHaveValue("工作电脑");
  await page.getByLabel("主机名称", { exact: true }).fill("  新名称  ");
  await page.getByRole("button", { name: "将这台电脑设为主机", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).hostNameFixture)).toEqual({ started: { hostName: "新名称" }, savedName: "保留的主机名称", deviceName: "保留的主机名称", nativeKey: "device_local", connected: 1 });
});

test("joining an existing network first registers the named local host without opening its workspace", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).nativeTransportFixture;
    const result = { starts: 0, paired: 0, savedName: "", connected: 0 };
    Object.assign(window, { hostNameFixture: result });
    fixture.mockIPC((command: string, args: any) => {
      if (command === "desktop_host" && args.action === "status") return { available: true, running: false, hostName: "我的 Windows" };
      if (command === "desktop_host" && args.action === "start") { result.starts++; return { available: true, running: true, hostName: args.device.hostName, publicKey: "local-host", url: "http://127.0.0.1:8789" }; }
      if (command === "device_create") return { deviceId: "device_local", keyRef: "device_local", publicKey: "local-device" };
      if (command === "desktop_host" && args.action === "pair") { result.paired++; return {}; }
      throw new Error("unexpected_native_request");
    });
    fixture.renderPairing({ save: async (_identity: unknown, name: string) => { result.savedName = name; }, connected: () => { result.connected++; } });
  });
  await expect(page.getByLabel("主机名称", { exact: true })).toHaveValue("我的 Windows");
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).hostNameFixture)).toEqual({ starts: 1, paired: 1, savedName: "我的 Windows", connected: 0 });
});

test("a late status read cannot overwrite edited names and invalid names never start either setup path", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).nativeTransportFixture;
    const result = { starts: 0, resolveStatus: undefined as undefined | ((value: unknown) => void) };
    Object.assign(window, { hostNameFixture: result });
    fixture.mockIPC((command: string, args: any) => {
      if (command === "desktop_host" && args.action === "status") return new Promise(resolve => { result.resolveStatus = resolve; });
      if (command === "desktop_host" && args.action === "start") { result.starts++; return Promise.reject("desktop_host_operation_failed"); }
      throw new Error("unexpected_native_request");
    });
    fixture.renderPairing();
  });
  const input = page.getByLabel("主机名称", { exact: true });
  await input.fill("我的主机");
  await page.evaluate(() => (window as any).hostNameFixture.resolveStatus({ available: true, running: false, hostName: "迟到的名称" }));
  await expect(input).toHaveValue("我的主机");
  await input.fill("   ");
  await expect(page.getByRole("button", { name: "将这台电脑设为主机", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "连接已有主机", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).hostNameFixture.starts)).toBe(0);
  await input.fill("失败后保留");
  await page.getByRole("button", { name: "将这台电脑设为主机", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("失败后保留");
  await expect(input).toBeEnabled();
});

for (const [reason, text] of [
  ['shadow_only', '原主机数据位于应用的隔离目录中'],
  ['conflict', '发现多份活动主机数据'],
  ['runtime_update_required', '正在运行的主机组件与此 App 不兼容，请更新主机组件'],
]) test(`welcome explains ${reason} without creating a new identity`, async ({ page }) => {
  await page.evaluate(reason => {
    const fixture = (window as any).nativeTransportFixture;
    fixture.mockIPC((command: string, args: any) => {
      if (command === 'desktop_host' && args.action === 'status') return { available:true, running:false, hostName:'原主机' };
      if (command === 'desktop_host' && args.action === 'start') return Promise.reject(`desktop_host_operation_failed|reason=state_${reason}`);
      throw new Error('unexpected_identity_creation');
    });
    fixture.renderPairing();
  }, reason);
  await page.getByRole('button', { name:'将这台电脑设为主机', exact:true }).click();
  await expect(page.getByRole('alert')).toContainText(text!);
  await expect(page.getByRole('alert')).not.toContainText('desktop_host_');
  await expect(page.getByLabel('主机名称', { exact:true })).toHaveValue('原主机');
});
