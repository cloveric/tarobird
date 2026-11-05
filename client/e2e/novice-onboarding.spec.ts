import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

for (const approvalView of ["foreground", "background", "controller-only", "network-loading"] as const) test(`fresh desktop joins through a phone, survives restart and appears in the network (${approvalView} approval)`, async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const fixture = await noviceNetworkFixture();
  let releaseNetwork!: () => void;
  const networkReady = new Promise<void>(resolve => { releaseNetwork = resolve; });
  if (approvalView === "network-loading") await page.route(/\/__novice\/proxy\/[12]\/api\/network$/, async route => { await networkReady; await route.continue().catch(() => {}); });
  const context = await browser.newContext({ serviceWorkers: "block" }), phone = await context.newPage();
  try {
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(fixture.phoneOrigin + "__novice?phone=1");
    await phone.getByLabel("设备名称", { exact: true }).fill("已配对手机");
    await phone.getByLabel("Hub 地址", { exact: true }).fill(fixture.hubs[0]!.url);
    await preparePairing(phone, fixture.hubs[0]!); await phone.getByRole("button", { name: "配对此设备", exact: true }).click();
    await fixture.hubs[0]!.auth.approve(await phone.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await expect(phone.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached({ timeout: 20000 });
    await waitForClientOnline(phone);
    await openWorkspacePage(phone, "设备与安全 设备名称与访问授权");
    await phone.getByRole("button", { name: "添加设备", exact: true }).click();
    await phone.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Object.assign(window, { invitation: text }); } } }));
    await phone.getByRole("button", { name: "复制连接信息", exact: true }).click();
    const invitation = await phone.evaluate(() => (window as any).invitation as string);

    await page.goto(fixture.origin + "__novice");
    await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
    await expect(page.getByLabel("加入步骤")).toBeVisible();
    await page.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(invitation);
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const code = await page.getByLabel("配对码", { exact: true }).innerText();
    await expect(page.getByText(/手机确认后，这里会继续/)).toBeVisible();
    // The new desktop was previously lost behind its local workspace on restart.
    await page.reload();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText(code, { timeout: 20000 });
    if (approvalView === "background") await page.getByRole("button", { name: "返回会话", exact: true }).click();
    await phone.getByRole("button", { name: "已扫码，输入配对码", exact: true }).click();
    await phone.getByLabel("新设备配对码", { exact: true }).fill(code);
    await phone.getByRole("button", { name: "确认配对", exact: true }).click();
    const join = page.getByRole("dialog", { name: "加入网络", exact: true });
    if (approvalView === "network-loading") {
      await expect(page.getByLabel("配对码", { exact: true })).toBeHidden({ timeout: 20000 });
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("tarobot:desktop-join-intent:v1") ?? "null"))).toEqual({ sourceKey: fixture.hubs[1]!.auth.publicKey, targetKey: fixture.hubs[0]!.auth.publicKey });
      await expect(join).toHaveCount(0);
      releaseNetwork();
      await expect(page.getByRole("button", { name: "继续加入网络", exact: true })).toBeVisible({ timeout: 20000 });
      expect((await fixture.hubs[1]!.network.view()).membership).toBeUndefined();
      return;
    }
    if (approvalView === "background") {
      await expect(page.getByRole("button", { name: "继续加入网络", exact: true })).toBeVisible({ timeout: 20000 });
      await expect(join).toHaveCount(0);
      await page.getByRole("button", { name: "继续加入网络", exact: true }).click();
    }
    await expect(join).toBeVisible({ timeout: 20000 });
    expect((await fixture.hubs[1]!.network.view()).host.routes).toHaveLength(0);
    expect((await fixture.hubs[1]!.network.view()).membership).toBeUndefined();
    await join.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续加入网络", exact: true })).toBeVisible();
    if (approvalView === "controller-only") {
      await page.getByRole("button", { name: "暂不加入", exact: true }).click();
      await page.reload(); await waitForClientOnline(page);
      await expect(page.getByRole("button", { name: "继续加入网络", exact: true })).toHaveCount(0);
      expect((await fixture.hubs[1]!.network.view()).membership).toBeUndefined();
      expect(await page.evaluate(() => localStorage.getItem("tarobot:desktop-join-intent:v1"))).toBeNull();
      return;
    }
    await page.reload();
    await page.getByRole("button", { name: "继续加入网络", exact: true }).click();
    await expect(join).toBeVisible();
    await expect(join.getByRole("checkbox")).toBeDisabled();
    await expect(join.getByRole("button", { name: "准备「新的 MacBook Pro」的连接线路", exact: true })).toBeEnabled();
    await join.getByRole("button", { name: "准备局域网线路", exact: true }).click();
    await expect(join.getByText("已共享 1 条线路", { exact: true })).toHaveCount(2);
    expect((await fixture.hubs[1]!.network.view()).host.routes).toHaveLength(1);
    // The owner can correct a LAN choice without leaving the join flow.
    await join.getByText("更换本机连接方式", { exact: true }).click();
    await join.getByRole("button", { name: "Tailscale 异地连接", exact: true }).click();
    await expect(join.getByRole("button", { name: "准备 Tailscale 线路", exact: true })).toBeVisible();
    await join.getByText("更换本机连接方式", { exact: true }).click();
    await join.getByRole("checkbox").check();
    await expect(join.getByRole("button", { name: "确认加入", exact: true })).toBeEnabled();
    // A genuinely changed directory requires another explicit review, never an auto retry.
    await join.getByRole("button", { name: "确认加入", exact: true }).click();
    if (await join.isVisible() && await join.getByRole("alert").count()) {
      await expect(join.getByRole("alert")).toContainText("网络成员已变化");
      await join.getByRole("checkbox").check(); await join.getByRole("button", { name: "确认加入", exact: true }).click();
    }
    await expect(join).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "已加入" })).toBeVisible();
    const localKey = fixture.hubs[1]!.auth.publicKey;
    await expect.poll(async () => (await fixture.hubs[0]!.network.view()).membership?.manifest.hosts.find(host => host.publicKey === localKey)?.state).toBe("active");
    await phone.getByRole("button", { name: "完成", exact: true }).click();
    await phone.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(phone.getByRole("button", { name: "新的 MacBook Pro 已连接", exact: true })).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: info.outputPath("joined-desktop.png") });
    await phone.screenshot({ path: info.outputPath("joined-phone.png") });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("tarobot:desktop-join-intent:v1"))).toBeNull();
    await page.reload();
    await expect(page.getByRole("button", { name: "继续加入网络", exact: true })).toHaveCount(0);
    await waitForClientOnline(page);
  } finally { releaseNetwork(); await context.close(); await page.close(); await fixture.close(); }
});
