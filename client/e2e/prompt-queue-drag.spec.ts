import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

async function fixture(page: Page, texts = Array.from({ length: 6 }, (_, i) => `待处理任务 ${i + 1}`)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-drag-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
  const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
  const chat = await hub.store.createConversation("owner", ["alpha"], "手指调整待执行顺序", "create");
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `pending-${i}`, text, attachments: [], ...(i === 1 ? { replyTo: ids[0] } : {}) })).message.id);
  const writes: unknown[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && request.url().includes(`/api/conversations/${chat.id}/queue`)) writes.push(request.postDataJSON()); });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await selectConversation(page, chat.title);
  const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("尚未发送的主输入框草稿");
  const open = () => page.getByRole("button", { name: /管理待执行消息，共/ }).click(); await open();
  const panel = page.getByRole("dialog", { name: "待执行消息", exact: true }), list = panel.locator(".prompt-queue-list");
  const row = (id: string) => panel.locator(`[data-queue-message-id="${id}"]`);
  const order = async () => (await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id);
  await expect(panel.locator(".prompt-queue-item")).toHaveCount(texts.length);
  // Opening refresh briefly occupies a phone status row. Wait for that layout
  // and the text metrics before measuring a drag, rather than racing a resize.
  await expect(list).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => { await document.fonts.ready; });
  return { hub, queue, chat, ids, panel, list, row, order, writes, errors, composer, open,
    close: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

// Chromium drives real touch input and pointer capture. WebKit's automation
// transport has no touch-move command, so exercise the same phone pointer path
// with trusted mouse input there (not a claim of physical-iPhone acceptance).
async function pointer(page: Page, touch = true, stableStart = true) {
  const cdp = touch && page.context().browser()!.browserType().name() === "chromium" ? await page.context().newCDPSession(page) : undefined;
  let x = 0, y = 0;
  return {
    start: async (handle: Locator) => {
      await handle.scrollIntoViewIfNeeded();
      if (stableStart) await handle.click({ trial: true });
      const box = (await handle.boundingBox())!; x = box.x + box.width / 2; y = box.y + box.height / 2;
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      else { await page.mouse.move(x, y); await page.mouse.down(); }
    },
    move: async (nextY: number, nextX = x) => {
      x = nextX; y = nextY;
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      else await page.mouse.move(x, y, { steps: 3 });
    },
    end: async (cancel = false) => {
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
      else { if (cancel) await page.keyboard.press("Escape"); await page.mouse.up(); }
    },
    dispose: async () => cdp?.detach().catch(() => {}),
  };
}

const layoutBounds = (row: Locator) => row.evaluate(node => {
  const rect = node.getBoundingClientRect(), value = getComputedStyle(node).transform;
  const transform = new DOMMatrixReadOnly(value === 'none' ? undefined : value);
  return { y: rect.top - transform.m42, height: rect.height };
});

test("phone handles reorder once on release, retain drafts and persist across reload", async ({ page }, info) => {
  const f = await fixture(page), p = await pointer(page);
  try {
    // Returning from the queue must not leave a sticky hover fill that looks
    // like a different queue state. System Back retains the trigger's focus.
    const trigger = page.getByRole("button", { name: /管理待执行消息，共/ });
    await f.panel.getByRole("button", { name: "关闭待执行消息", exact: true }).tap();
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, mode);
      await f.composer.tap();
      const fill = await trigger.evaluate(node => {
        const sample = document.createElement("span"); sample.style.backgroundColor = "var(--hover)";
        node.append(sample); const color = getComputedStyle(sample).backgroundColor; sample.remove(); return color;
      });
      expect(fill).not.toBe("rgba(0, 0, 0, 0)");
      await expect(trigger).toHaveCSS("background-color", fill);
      await trigger.tap(); await expect(f.panel).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
      await expect(f.panel).toHaveCount(0); await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS("background-color", fill);
      await page.screenshot({ path: info.outputPath(`queue-trigger-${mode}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await trigger.tap(); await expect(f.panel).toBeVisible();
    const original = await f.hub.store.snapshot("owner", f.chat.id);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const handle = f.row(f.ids[0]).getByRole("button", { name: /^拖动调整/ });
      await expect(handle).toBeVisible(); const box = (await handle.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(f.panel.locator('.prompt-queue-help')).toHaveCount(0);
      await expect(f.panel.locator('header').getByRole('button', { name: '刷新待执行消息', exact: true })).toBeEnabled();
      const beforeTop = (await f.list.boundingBox())!.y;
      const beforeWrites = f.writes.length;
      await p.start(handle); const destination = (await f.row(f.ids[2]).boundingBox())!;
      await p.move(destination.y + destination.height - 8);
      await expect(f.row(f.ids[2])).toHaveClass(/is-drop-after/);
      expect(f.writes).toHaveLength(beforeWrites); expect(await f.order()).toEqual(f.ids);
      await p.end();
      await expect.poll(f.order).toEqual([f.ids[1], f.ids[2], f.ids[0], ...f.ids.slice(3)]);
      await expect(f.panel.getByRole("status")).toContainText("消息已移到第 3 条");
      expect((await f.panel.getByRole('status').boundingBox())!.height).toBeLessThanOrEqual(1);
      expect(Math.abs((await f.list.boundingBox())!.y - beforeTop)).toBeLessThan(2);
      expect(f.writes).toHaveLength(beforeWrites + 1);
      await expect(f.list).not.toHaveAttribute('data-queue-saving', 'true');
      await expect(f.list.locator('[data-queue-settling="true"]')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`phone-queue-${width}.png`), animations: 'disabled' });
      await p.start(handle); const first = (await f.row(f.ids[1]).boundingBox())!;
      await p.move(first.y + 6); await expect(f.row(f.ids[1])).toHaveClass(/is-drop-before/); await p.end();
      await expect.poll(f.order).toEqual(f.ids);
      await expect(f.panel.getByRole("status")).toContainText("消息已移到第 1 条");
      expect(f.writes).toHaveLength(beforeWrites + 2);
    }
    await f.panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(f.composer).toHaveValue("尚未发送的主输入框草稿");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, f.chat.title); await f.open();
    expect(await f.list.locator("article").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.queueMessageId))).toEqual(f.ids);
    await expect(f.row(f.ids[1])).toContainText("包含引用");
    const after = await f.hub.store.snapshot("owner", f.chat.id);
    expect(after.messages).toEqual(original.messages);
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

test("phone drag cancels safely and a held handle never scrolls or writes", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await fixture(page), p = await pointer(page);
  try {
    const handle = f.row(f.ids[0]).getByRole("button", { name: /^拖动调整/ });
    // Ordinary text owns no drag and keeps the list's native pan-y behavior.
    await p.start(f.row(f.ids[0]).locator(".prompt-queue-text"));
    await expect(f.list).not.toHaveAttribute("data-dragging", "true"); await p.end();
    expect(await f.list.evaluate(node => getComputedStyle(node).touchAction)).toBe("pan-y");
    if (page.context().browser()!.browserType().name() === "chromium") {
      const text = f.row(f.ids[1]).locator(".prompt-queue-text"), box = (await text.boundingBox())!;
      await p.start(text); await p.move(box.y - 50); await p.move(box.y - 120); await p.end();
      await expect.poll(() => f.list.evaluate(node => node.scrollTop)).toBeGreaterThan(20);
      await expect(f.list).not.toHaveAttribute("data-dragging", "true");
      await f.list.evaluate(node => new Promise<void>(resolve => {
        let last = node.scrollTop, stable = 0;
        const check = () => { const next = node.scrollTop; stable = Math.abs(next - last) < .5 ? stable + 1 : 0; last = next; if (stable >= 4) resolve(); else requestAnimationFrame(check); }; check();
      }));
      await f.list.evaluate(node => { node.scrollTop = 0; });
    }
    await p.start(handle); await expect(f.list).not.toHaveAttribute("data-dragging", "true");
    await page.waitForTimeout(2200); // At least one unchanged queue poll during a hold.
    await expect(f.list).not.toHaveAttribute("data-dragging", "true");
    expect(await f.list.evaluate(node => node.scrollTop)).toBe(0); await p.end();
    expect(f.writes).toHaveLength(0);
    for (const reason of ["cancel", "escape", "outside", "blur", "resize", "second-pointer", "revision", "close"]) {
      await p.start(handle); const destination = await layoutBounds(f.row(f.ids[1]));
      await p.move(destination.y + destination.height - 8); await expect(f.row(f.ids[1]), reason).toHaveClass(/is-drop-after/);
      if (reason === "escape") await page.keyboard.press("Escape");
      if (reason === "outside") await p.move(5);
      if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      if (reason === "resize") await page.setViewportSize({ width: 380, height: 844 });
      if (reason === "second-pointer") await f.list.dispatchEvent("pointerdown", { pointerId: 99, pointerType: "touch", isPrimary: false, button: 0 });
      if (reason === "revision") {
        const snapshot = await f.queue.read("owner", "alpha", f.chat.id);
        await f.queue.mutate("owner", f.chat.id, { botId: "alpha", requestId: "external-edit", revision: snapshot.revision, action: { type: "edit", messageId: f.ids[1], text: "另一设备修改后的内容" } });
        await expect(f.row(f.ids[1])).toContainText("另一设备修改后的内容");
        await expect(f.list).not.toHaveAttribute("data-dragging", "true");
      }
      if (reason === "close") await f.panel.getByRole("button", { name: "关闭待执行消息", exact: true }).evaluate((node: HTMLButtonElement) => node.click());
      await p.end(reason === "cancel");
      if (reason === "close") await f.open();
      await expect(f.list).not.toHaveAttribute("data-dragging", "true");
      await expect(f.list.locator(".is-drop-before,.is-drop-after")).toHaveCount(0);
      expect(f.writes, reason).toHaveLength(0); expect(await f.order()).toEqual(f.ids);
    }
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

test("phone drag scrolls a long queue and cannot cross a control command", async ({ page }) => {
  const f = await fixture(page, Array.from({ length: 14 }, (_, i) => i === 9 ? "/new" : `长队列任务 ${i + 1}`)), p = await pointer(page);
  try {
    await expect(f.row(f.ids[9]).locator("[data-queue-drag-handle]")).toHaveCount(0);
    await p.start(f.row(f.ids[0]).getByRole("button", { name: /^拖动调整/ }));
    const box = (await f.list.boundingBox())!;
    await p.move(box.y + box.height - 6);
    await expect.poll(() => f.list.evaluate(node => node.scrollTop)).toBeGreaterThan(250);
    expect(f.writes).toHaveLength(0);
    // Continue to a card beyond the command barrier without committing any
    // intermediate position while edge scrolling.
    // Card height varies with actions, text and phone width. This is a barrier
    // correctness check, not a five-second scroll-speed benchmark. Keep a
    // bounded allowance based on the actual distance and 400px/s edge speed.
    const travel = Math.max(0, (await f.row(f.ids[10]).boundingBox())!.y - (box.y + box.height - 150));
    const scrollTimeout = Math.min(15_000, Math.max(5_000, 2000 + travel / .4 * 3));
    await expect.poll(async () => (await f.row(f.ids[10]).boundingBox())!.y, { timeout: scrollTimeout }).toBeLessThan(box.y + box.height - 150);
    const forbidden = (await f.row(f.ids[10]).boundingBox())!;
    await p.move(forbidden.y + 20);
    await expect(f.list.locator(".is-drop-before,.is-drop-after")).toHaveCount(0);
    await p.end(); expect(f.writes).toHaveLength(0); expect(await f.order()).toEqual(f.ids);
    await f.list.evaluate(node => { node.scrollTop = 0; });
    await p.start(f.row(f.ids[0]).getByRole("button", { name: /^拖动调整/ }));
    await p.move(box.y + box.height - 6);
    await expect.poll(() => f.list.evaluate(node => node.scrollTop)).toBeGreaterThan(200);
    // Move away from the edge before release; this position is within the
    // first movable segment and therefore commits one move.
    await p.move(box.y + box.height / 2);
    await expect(f.list.locator(".is-drop-before,.is-drop-after")).toHaveCount(1); await p.end();
    await expect.poll(() => f.writes.length).toBe(1);
    await expect.poll(f.order).not.toEqual(f.ids);
    expect((await f.order()).slice(9)).toEqual(f.ids.slice(9));
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

test("landscape keyboard layout drags through the dialog scroll surface", async ({ page }, info) => {
  await page.addInitScript(() => {
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    (window as any).setQueueViewport = (height: number) => { Object.assign(visual, { height, width: innerWidth }); visual.dispatchEvent(new Event("resize")); };
  });
  const f = await fixture(page), p = await pointer(page);
  try {
    // WebKit uses trusted mouse input, so stay within the phone breakpoint;
    // Chromium's real touch path also covers a wide landscape phone.
    await page.setViewportSize({ width: info.project.use.browserName === "webkit" ? 740 : 844, height: 390 });
    await f.row(f.ids[1]).getByRole("button", { name: /^编辑第/ }).click();
    await f.panel.getByRole("textbox", { name: "编辑待执行消息", exact: true }).focus();
    // Exercise native-keyboard viewport signals, not a physical keyboard.
    await page.evaluate(() => (window as any).setQueueViewport(220));
    await expect(f.panel).toHaveCSS("overflow-y", "auto");
    await expect(f.list).toHaveCSS("overflow-y", "visible");
    const handle = f.row(f.ids[0]).getByRole("button", { name: /^拖动调整/ });
    await p.start(handle);
    const box = (await f.panel.boundingBox())!;
    await p.move(box.y + box.height - 5);
    await expect(f.list).toHaveAttribute("data-dragging", "true");
    await expect.poll(() => f.panel.evaluate(node => node.scrollTop)).toBeGreaterThan(220);
    expect(f.writes).toHaveLength(0);
    await p.move(box.y + box.height - 50);
    await expect(f.list.locator(".is-drop-before,.is-drop-after")).toHaveCount(1);
    await p.end(); await expect.poll(() => f.writes.length).toBe(1);
    await expect.poll(f.order).not.toEqual(f.ids);
    await page.screenshot({ path: info.outputPath("phone-queue-landscape.png") });
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

async function watchQueueMotion(page: Page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    (window as any).queueMotionCalls = [];
    Element.prototype.animate = function(frames, options) {
      if (this.classList.contains('prompt-queue-item')) (window as any).queueMotionCalls.push({ id: (this as HTMLElement).dataset.queueMessageId, frames, options });
      return animate.call(this, frames, options);
    };
  });
}
const motionCalls = (page: Page) => page.evaluate(() => (window as any).queueMotionCalls as { id: string; options: { duration: number; easing: string } }[]);
const visualOrder = (list: Locator) => list.locator('article').evaluateAll(rows => rows.map(row => ({ id: (row as HTMLElement).dataset.queueMessageId, y: row.getBoundingClientRect().top })).sort((a, b) => a.y - b.y).map(row => row.id));

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'} queue cards follow the pointer, make variable-height space and settle after the Host receipt`, async ({ page }, info) => {
  await watchQueueMotion(page);
  const f = await fixture(page, ['短任务', '高度不同的任务：' + '读取正文并保留引用。'.repeat(20), '中间任务', '最后任务']), p = await pointer(page, phone);
  let release: (() => void) | undefined, delay = true;
  try {
    if (!phone) await page.setViewportSize({ width: 1360, height: 900 });
    const base = await Promise.all(f.ids.map(id => f.row(id).boundingBox()));
    expect(base[1]!.height - base[0]!.height).toBeGreaterThan(40);
    await page.route(`**/api/conversations/${f.chat.id}/queue`, async route => {
      if (route.request().method() !== 'POST' || !delay) return route.continue();
      delay = false;
      await new Promise<void>(resolve => { release = resolve; }); await route.continue();
    });
    await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
    const grip = (await f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }).boundingBox())!;
    const pickup = grip.y + grip.height / 2 - base[0]!.y, destination = base[2]!.y + base[2]!.height - 12;
    await p.move(destination);
    await expect(f.row(f.ids[2])).toHaveClass(/is-drop-after/);
    expect((await f.row(f.ids[0]).boundingBox())!.y).toBeCloseTo(destination - pickup, 0);
    await expect.poll(() => visualOrder(f.list)).toEqual([f.ids[1], f.ids[2], f.ids[0], f.ids[3]]);
    // An unaffected row must not acquire a needless animation/compositor layer.
    expect((await motionCalls(page)).some(call => call.id === f.ids[3])).toBe(false);
    const started = (await motionCalls(page)).length;
    await page.waitForTimeout(350); // Neighbour animations must not retarget an idle pointer.
    expect((await motionCalls(page)).length).toBe(started);
    await expect(f.row(f.ids[2])).toHaveClass(/is-drop-after/);
    expect(await f.order()).toEqual(f.ids); expect(f.writes).toHaveLength(0);
    expect(await f.list.locator('article').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.queueMessageId))).toEqual(f.ids);
    await page.screenshot({ path: info.outputPath(`${phone ? 'phone' : 'desktop'}-queue-drag.png`) });
    await p.end(); await expect.poll(() => f.writes.length).toBe(1);
    await expect(f.list).toHaveAttribute('data-queue-saving', 'true');
    await expect.poll(() => f.panel.locator('.prompt-queue-item').evaluateAll(rows => rows.every(row => row.getAnimations().length === 0))).toBe(true);
    const preview = await Promise.all(f.ids.map(id => f.row(id).boundingBox()));
    const gap = base[1]!.y - base[0]!.y - base[0]!.height;
    expect(preview[1]!.y).toBeCloseTo(base[0]!.y, 0);
    expect(preview[2]!.y).toBeCloseTo(preview[1]!.y + preview[1]!.height + gap, 0);
    expect(preview[0]!.y).toBeCloseTo(preview[2]!.y + preview[2]!.height + gap, 0);
    release!();
    await expect.poll(f.order).toEqual([f.ids[1], f.ids[2], f.ids[0], f.ids[3]]);
    await expect(f.list).not.toHaveAttribute('data-queue-saving', 'true');
    await expect(f.panel.getByRole('status')).toContainText('消息已移到第 3 条');
    const final = await Promise.all(f.ids.map(id => f.row(id).boundingBox()));
    for (let i = 0; i < f.ids.length; i++) expect(final[i]!.y).toBeCloseTo(preview[i]!.y, 0);
    const calls = await motionCalls(page); expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) { expect(call.options.duration).toBeLessThanOrEqual(200); expect(call.options.easing).toBe('cubic-bezier(.2,.8,.2,1)'); }
    // Button movement shares the same short final-placement animation.
    const beforeButton = calls.length;
    await f.row(f.ids[0]).getByRole('button', { name: /^上移第/ }).click();
    await expect.poll(() => motionCalls(page).then(value => value.length)).toBeGreaterThan(beforeButton);
    await expect.poll(f.order).toEqual([f.ids[1], f.ids[0], f.ids[2], f.ids[3]]);
    expect(f.errors).toEqual([]);
  } finally { release?.(); await p.dispose(); await f.close(); }
});

test('queue animations stay enabled through live system reduced-motion changes', async ({ page }) => {
  await watchQueueMotion(page);
  const f = await fixture(page), p = await pointer(page);
  try {
    const handle = f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ });
    const target = (await f.row(f.ids[2]).boundingBox())!;
    await p.start(handle); await p.move(target.y + target.height - 10);
    await expect.poll(() => motionCalls(page).then(value => value.length)).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    const count = (await motionCalls(page)).length;
    await p.end(); await expect.poll(f.order).not.toEqual(f.ids);
    expect((await motionCalls(page)).length).toBeGreaterThanOrEqual(count);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await f.panel.getByRole('button', { name: '关闭待执行消息', exact: true }).click();
    await openSettings(page); await expect(page.getByRole('switch', { name: '界面动画', exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await closeSettings(page); await selectConversation(page, f.chat.title); await f.open();
    const initial = await f.order(), from = f.row(initial[0]).getByRole('button', { name: /^拖动调整/ }), second = (await f.row(initial[1]).boundingBox())!;
    const before = (await motionCalls(page)).length;
    await p.start(from); await p.move(second.y + second.height - 8); await p.end();
    await expect.poll(f.order).not.toEqual(initial);
    expect((await motionCalls(page)).length).toBeGreaterThan(before);
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

test('failed saves restore canonical positions and late geometry changes cannot commit a stale drag', async ({ page }) => {
  const f = await fixture(page), p = await pointer(page);
  try {
    await page.route(`**/api/conversations/${f.chat.id}/queue`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'queue_changed' }) });
    });
    const before = await Promise.all(f.ids.map(id => f.row(id).boundingBox()));
    await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
    await p.move(before[1]!.y + before[1]!.height - 8); await p.end();
    await expect(f.panel.getByRole('alert')).toContainText('队列已变化');
    await expect(f.list).not.toHaveAttribute('data-queue-saving', 'true');
    await expect.poll(() => f.list.locator('article').evaluateAll(rows => rows.every(row => !row.getAnimations().length && !((row as HTMLElement).style.transform)))).toBe(true);
    expect(await visualOrder(f.list)).toEqual(f.ids); expect(await f.order()).toEqual(f.ids);
    await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
    const destination = (await f.row(f.ids[1]).boundingBox())!; await p.move(destination.y + destination.height - 8);
    // Simulate expansion before the next animation frame / ResizeObserver.
    await f.row(f.ids[1]).evaluate(row => { (row as HTMLElement).style.paddingBottom = '70px'; });
    await p.end();
    expect(f.writes).toHaveLength(1); expect(await f.order()).toEqual(f.ids);
    await expect(f.list.locator('.prompt-queue-drop-slot')).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});

test('an uncertain save rolls back visually and a later authoritative poll animates the confirmed order', async ({ page }) => {
  await watchQueueMotion(page);
  const f = await fixture(page), p = await pointer(page);
  let allowReads = true, releaseReads: (() => void) | undefined;
  const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
  try {
    await page.route(`**/api/conversations/${f.chat.id}/queue*`, async route => {
      if (route.request().method() === 'POST') { allowReads = false; await route.fetch(); await route.abort('connectionfailed'); }
      else { if (!allowReads) await readGate; await route.continue().catch(() => {}); }
    });
    const old = await f.order(), target = await layoutBounds(f.row(f.ids[1]));
    await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
    await p.move(target.y + target.height - 8);
    const sampling = f.row(f.ids[0]).evaluate(row => new Promise<number[]>(resolve => {
      const frames = [row.getBoundingClientRect().top], start = performance.now();
      const frame = () => { frames.push(row.getBoundingClientRect().top); if (performance.now() - start < 600) requestAnimationFrame(frame); else resolve(frames); };
      requestAnimationFrame(frame);
    }));
    await p.end();
    await expect(f.panel.getByRole('alert')).toContainText('操作结果尚未确认');
    await expect(f.list).not.toHaveAttribute('data-queue-saving', 'true');
    await expect.poll(() => f.list.locator('article').evaluateAll(rows => rows.every(row => !row.getAnimations().length && !(row as HTMLElement).style.transform))).toBe(true);
    const frames = await sampling;
    // Inserting the unknown-result alert must not shift the rollback origin
    // and make the card jump away before returning to its original order.
    expect(Math.max(...frames)).toBeLessThanOrEqual(Math.max(frames[0], frames.at(-1)!) + 2);
    expect(await visualOrder(f.list)).toEqual(old); expect(f.writes).toHaveLength(1);
    const before = (await motionCalls(page)).length;
    allowReads = true; releaseReads!();
    await expect.poll(() => f.list.locator('article').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.queueMessageId))).toEqual([f.ids[1], f.ids[0], ...f.ids.slice(2)]);
    await expect.poll(() => motionCalls(page).then(calls => calls.length)).toBeGreaterThan(before);
    await expect(f.panel.getByRole('button', { name: '重试并核对结果', exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { allowReads = true; releaseReads?.(); await p.dispose(); await f.close(); }
});

test('a card can be picked up during its return animation without jumping or dispatching', async ({ page }) => {
  const f = await fixture(page), p = await pointer(page, false, false);
  try {
    const source = f.row(f.ids[0]), handle = source.getByRole('button', { name: /^拖动调整/ });
    const destination = await layoutBounds(f.row(f.ids[2]));
    await p.start(handle); await p.move(destination.y + destination.height - 12);
    await expect(f.list).toHaveAttribute('data-dragging', 'true'); await p.end(true);
    // Hold a real return-animation frame so the test driver hits the visible
    // moving handle, without an IPC round trip racing the next painted frame.
    await source.evaluate(row => { for (const animation of row.getAnimations()) { animation.pause(); animation.currentTime = 60; } });
    const before = (await source.boundingBox())!, grip = (await handle.boundingBox())!;
    await p.start(handle); await p.move(grip.y + grip.height / 2 + 12);
    await expect(f.list).toHaveAttribute('data-dragging', 'true');
    expect((await source.boundingBox())!.y).toBeCloseTo(before.y + 12, 0);
    await p.end(true); expect(f.writes).toHaveLength(0); expect(await f.order()).toEqual(f.ids);
    await expect(f.list.locator('.prompt-queue-drop-slot')).toHaveCount(0); expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});


test('regrabbing an unchanged card lets returning neighbours finish even without a new drop target', async ({ page }) => {
  const f = await fixture(page, ['第一项', '第二项', '第三项', '第四项']), p = await pointer(page, false, false);
  try {
    const destination = await layoutBounds(f.row(f.ids[2]));
    await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
    await p.move(destination.y + destination.height - 12); await p.end(true);
    await f.list.evaluate(list => { for (const row of list.querySelectorAll('article')) for (const animation of row.getAnimations()) { animation.pause(); animation.currentTime = 60; } });
    const offsets = () => f.list.locator('article').evaluateAll(rows => rows.slice(0, 3).map(row => {
      const transform = getComputedStyle(row).transform;
      return Math.abs(new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m42);
    }));
    expect((await offsets()).some(value => value > 1)).toBe(true);
    const handle = f.row(f.ids[3]).getByRole('button', { name: /^拖动调整/ }), grip = (await handle.boundingBox())!;
    await p.start(handle); await p.move(grip.y + grip.height / 2 + 9);
    await expect(f.list).toHaveAttribute('data-dragging', 'true');
    await expect(f.list.locator('.is-drop-before, .is-drop-after')).toHaveCount(0);
    await expect.poll(async () => (await offsets()).every(value => value < 1)).toBe(true);
    await p.end(true); expect(f.writes).toHaveLength(0); expect(await f.order()).toEqual(f.ids);
    expect(f.errors).toEqual([]);
  } finally { await p.dispose(); await f.close(); }
});


test('a second save retains its preview while the previous error is visible', async ({ page }) => {
  const f = await fixture(page, ['第一项', '不同高度。'.repeat(25), '第三项', '第四项']), p = await pointer(page);
  let reject = true, release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route(`**/api/conversations/${f.chat.id}/queue`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (reject) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'queue_control_barrier' }) });
      await gate; await route.continue();
    });
    const drag = async () => {
      await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
      const target = await layoutBounds(f.row(f.ids[2]));
      await p.move(target.y + target.height - 8); await p.end();
    };
    await drag(); await expect(f.panel.getByRole('alert')).toContainText('不能跨过控制命令');
    await expect.poll(() => f.list.locator('article').evaluateAll(rows => rows.every(row => !row.getAnimations().length))).toBe(true);
    reject = false; await drag(); await expect.poll(() => f.writes.length).toBe(2);
    await expect(f.list).toHaveAttribute('data-queue-saving', 'true');
    await expect.poll(() => f.list.locator('article').evaluateAll(rows => rows.every(row => !row.getAnimations().length))).toBe(true);
    expect(await visualOrder(f.list)).toEqual([f.ids[1], f.ids[2], f.ids[0], f.ids[3]]);
    await expect(f.panel.getByRole('button', { name: '重试并核对结果', exact: true })).toHaveCount(0);
    expect(await f.order()).toEqual(f.ids);
    release!(); await expect.poll(f.order).toEqual([f.ids[1], f.ids[2], f.ids[0], f.ids[3]]);
    await expect(f.panel.getByRole('alert')).toHaveCount(0);
    await expect(f.list).not.toHaveAttribute('data-queue-saving', 'true');
    expect(f.writes).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { release?.(); await p.dispose(); await f.close(); }
});


test('a disconnected retry keeps its receipt and replaces the previous rejection with an unknown result', async ({ page }) => {
  let disconnected = false;
  const sockets: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket('**/ws', socket => {
    if (disconnected) { socket.close(); return; }
    sockets.push(socket); socket.connectToServer();
  });
  const f = await fixture(page, ['第一项', '第二项', '第三项', '第四项']), p = await pointer(page);
  let mode: 'reject' | 'hold' | 'pass' = 'reject', release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route(`**/api/conversations/${f.chat.id}/queue`, async route => {
      if (route.request().method() !== 'POST' || mode === 'pass') return route.continue();
      if (mode === 'reject') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'queue_changed' }) });
      await gate; await route.abort().catch(() => {});
    });
    const drag = async () => {
      await p.start(f.row(f.ids[0]).getByRole('button', { name: /^拖动调整/ }));
      const target = await layoutBounds(f.row(f.ids[2]));
      await p.move(target.y + target.height - 8); await p.end();
    };
    await drag(); await expect(f.panel.getByRole('alert')).toContainText('队列已变化');
    mode = 'hold'; await drag(); await expect(f.list).toHaveAttribute('data-queue-saving', 'true');
    // WebKit's offline emulation leaves established WebSockets open. Close the
    // real routed connection as well, so both engines observe the same loss.
    disconnected = true; await page.context().setOffline(true);
    for (const socket of sockets) socket.close();
    await expect(f.panel.getByRole('status')).toContainText('离线时仅可查看');
    await expect(f.panel.getByRole('alert')).toContainText('上次操作结果尚未确认');
    await expect(f.panel.getByRole('alert')).not.toContainText('队列已变化');
    const retry = f.panel.getByRole('button', { name: '重试并核对结果', exact: true }); await expect(retry).toBeDisabled();
    disconnected = false; await page.context().setOffline(false); await expect(retry).toBeEnabled();
    mode = 'pass'; release!(); await retry.click();
    await expect.poll(f.order).toEqual([f.ids[1], f.ids[2], f.ids[0], f.ids[3]]);
    expect(f.writes).toHaveLength(3); expect(f.writes[2]).toEqual(f.writes[1]);
    await expect(f.panel.getByRole('alert')).toHaveCount(0); expect(f.errors).toEqual([]);
  } finally { disconnected = false; release?.(); await page.context().setOffline(false); await p.dispose(); await f.close(); }
});
