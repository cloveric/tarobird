import { test, expect, type Page } from "@playwright/test";
import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { pairingLink } from "../src/pairing-link.js";
import { agyAcpFixture } from "./fixtures/agy-acp.js";

test.use({ serviceWorkers: "block", actionTimeout: 12_000 });

/** Optional: also keep review copies outside the test output directory. */
const reviewDir = process.env.AGY_ACP_UI_SHOTS;

async function shot(page: Page, info: { outputPath(name: string): string }, name: string) {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (reviewDir) await page.screenshot({ path: `${reviewDir}/${name}.png` });
}

async function noHorizontalOverflow(page: Page, selector?: string) {
  if (selector) expect(await page.locator(selector).first().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const english of [false, true]) for (const phone of [false, true]) test(`Antigravity ACP steering choice, tasks, commands and approval mode · ${phone ? "phone" : "desktop"} · ${english ? "en" : "zh"}`, async ({ browser }, info) => {
  const fixture = await agyAcpFixture(english ? "en" : "zh");
  const tr = (zh: string, en: string) => english ? en : zh;
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const tag = `${phone ? "phone" : "desktop"}-${english ? "en" : "zh"}`;
  try {
    await page.goto(fixture.hub.url);
    if (english) {
      const invitation = await fixtureInvitation(fixture.hub);
      await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
      await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: fixture.hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: fixture.hub.url }] }));
      await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
    } else await preparePairing(page, fixture.hub);
    await page.getByRole("button", { name: tr("配对此设备", "Pair this device"), exact: true }).click();
    const code = page.getByLabel(tr("配对码", "Pairing code"), { exact: true });
    await fixture.hub.auth.approve(await code.innerText(), "local-owner"); await code.waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    const title = fixture.chats[0]!.title;
    if (english && phone) {
      const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
      await home.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
      await home.locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) }).click();
      await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
    } else await selectConversation(page, title);

    const input = page.getByRole("textbox", { name: tr("消息", "Message"), exact: true });
    const send = page.getByRole("button", { name: tr("发送消息", "Send message"), exact: true });
    await input.fill(tr("检查构建", "Check the build")); await send.click();
    await expect.poll(() => fixture.turns.length).toBe(1);

    // Steering choice: same control and copy as Claude/Pi while AGY is replying.
    const current = page.locator('.claude-send-choice [data-mode="current"]'), next = page.locator('.claude-send-choice [data-mode="next"]');
    await expect(current).toBeChecked();
    await expect(current).toBeEnabled(); await expect(next).toBeEnabled();
    await input.fill(tr("也跑一下单元测试", "Also run the unit tests"));
    await noHorizontalOverflow(page, ".claude-send-choice");
    await shot(page, info, `${tag}-send-choice`);
    await next.click(); await expect(next).toBeChecked();
    await expect(page.locator(".composer-hint")).toHaveText(tr("等待当前任务结束后再处理", "Process after the current task finishes"));
    await current.click(); await expect(current).toBeChecked();
    await send.click();
    await expect.poll(() => fixture.inputs).toEqual([tr("也跑一下单元测试", "Also run the unit tests")]);
    await expect(input).toHaveValue("");

    // Task panel: the background command is listed, without a per-task stop.
    const trigger = page.getByRole("button", { name: tr("子代理与后台任务", "Subagents & background tasks"), exact: true });
    await expect(trigger).toBeVisible(); await trigger.click();
    const dialog = page.getByRole("dialog", { name: tr("子代理与后台任务", "Subagents & background tasks"), exact: true });
    const task = dialog.getByRole("article", { name: "npm run build -- --watch --mode production", exact: true });
    await expect(task).toContainText(tr("执行中", "Running"));
    await expect(task).toContainText(tr("后台执行", "Running in background"));
    await expect(task.getByRole("button")).toHaveCount(0);
    await noHorizontalOverflow(page, ".engine-tasks-dialog");
    await shot(page, info, `${tag}-tasks`);
    await dialog.getByRole("button", { name: tr("关闭任务列表", "Close task list"), exact: true }).click();

    // Command menu: native AGY commands follow the Host commands with localized copy; Host commands keep one entry.
    const menu = page.locator(".command-menu");
    await input.fill("/g");
    await expect(menu.getByRole("button", { name: /^\/grill-me\s/ })).toContainText(tr("逐题访谈", "Interview me to align on a plan"));
    await expect(menu.getByRole("button", { name: /^\/goal\s/ })).toHaveCount(1);
    await noHorizontalOverflow(page, ".command-menu");
    await shot(page, info, `${tag}-commands`);
    await menu.getByRole("button", { name: /^\/grill-me\s/ }).click();
    await expect(input).toHaveValue("/grill-me "); await input.fill("");

    // Approval mode: Normal for an ACP Bot is per-action approval, not a whole-turn approval.
    fixture.finish(); await expect(page.locator("p", { hasText: tr("本轮已完成。", "This turn is complete.") }).first()).toBeVisible();
    await page.getByRole("button", { name: tr("查看对话详情", "View conversation details"), exact: true }).click();
    await page.getByRole("button", { name: tr("Bot 设置", "Bot settings"), exact: true }).click();
    await page.getByRole("button", { name: tr("调整 Bot 权限", "Adjust Bot permissions"), exact: true }).click();
    const level = page.getByRole("combobox", { name: tr("权限与批准", "Permissions & approvals"), exact: true });
    await expect(level).toHaveValue("normal");
    await expect(level.locator('option[value="normal"]')).toContainText(tr("普通审批 · 逐项确认", "Normal approval · Per action"));
    await expect(page.getByRole("note")).toContainText(tr("逐项在对话中请求批准", "asked one by one in chat"));
    await noHorizontalOverflow(page);
    await shot(page, info, `${tag}-approval-mode`);
    expect(errors).toEqual([]);
  } finally { await context.close(); await fixture.close(); }
});
