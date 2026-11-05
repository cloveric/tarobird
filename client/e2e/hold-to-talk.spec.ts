import { preparePairing } from "./fixtures/pairing-invite.js";
import { test as base, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { microphone } from "./fixtures/microphone.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

const test = base.extend<{ hub: HubServer; chat: string }>({
  hub: async ({}, use) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hold-voice-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    try { await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','语音助手','fixture')"); await use(hub); }
    finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  },
  chat: async ({ page, hub }, use) => {
    const chat = await hub.store.createConversation("owner", ["alpha"], "第一段对话", "one");
    await hub.store.createConversation("owner", ["alpha"], "第二段对话", "two");
    await microphone(page); await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, "第一段对话");
    await use(chat.id); await page.close();
  },
});
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const hold = (page: Page) => page.getByRole("button", { name: "按住说话", exact: true });
async function mode(page: Page) { await page.getByRole("button", { name: "录制语音", exact: true }).click(); await expect(hold(page)).toBeVisible(); }
async function press(page: Page) {
  const box = (await hold(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y); await page.mouse.down(); return point;
}
async function recorded(page: Page) { await expect(page.getByLabel("录音时长", { exact: true })).not.toHaveText("00:00"); }
async function released(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended")))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const mic = (window as any).__mic;
    return mic.contexts.every((c: AudioContext) => mic.closedContexts.includes(c)) && mic.closedSources.length === mic.sourceContexts.length;
  })).toBe(true);
}
async function count(hub: HubServer, chat: string) { return (await hub.store.snapshot("owner", chat)).messages.filter(m => m.authorType === "user").length; }

test("hold shows real audio levels; release sends only voice and preserves text and file drafts", async ({ page, hub, chat }, info) => {
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("这段文字先留着");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "草稿.txt", mimeType: "text/plain", buffer: Buffer.from("draft") });
  await mode(page); expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(0);
  await press(page); await recorded(page);
  const wave = page.getByRole("img", { name: "实时录音波形" });
  await expect.poll(() => wave.getAttribute("data-level").then(Number)).toBeGreaterThan(0.1);
  await page.evaluate(() => { (window as any).__mic.gain.gain.value = 0; });
  await expect.poll(() => wave.getAttribute("data-level").then(Number)).toBe(0);
  await page.evaluate(() => { (window as any).__mic.gain.gain.value = 0.15; });
  await expect.poll(() => wave.getAttribute("data-level").then(Number)).toBeGreaterThan(0.05);
  await page.screenshot({ path: info.outputPath("hold-recording.png"), fullPage: true });
  await page.mouse.up(); await released(page); await expect.poll(() => count(hub, chat)).toBe(1);
  const message = (await hub.store.snapshot("owner", chat)).messages.find(m => m.authorType === "user")!;
  expect(message.blocks.map(b => b.type)).toEqual(["audio"]);
  await page.getByRole("button", { name: "切换到键盘", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("这段文字先留着");
  await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("草稿.txt");
  await expect(page.locator(".audio-draft")).toHaveCount(0);
});

test("slide up cancels; sliding back restores release-to-send; short presses do not send", async ({ page, hub, chat }, info) => {
  await mode(page); let point = await press(page); await recorded(page);
  await page.mouse.move(point.x, point.y - 100);
  await expect(page.locator(".hold-voice")).toHaveClass(/is-cancelling/);
  await page.screenshot({ path: info.outputPath("hold-cancel.png"), fullPage: true });
  await page.mouse.up(); await released(page); expect(await count(hub, chat)).toBe(0);
  await press(page); await expect(page.getByText("正在录音", { exact: true })).toBeVisible(); await page.mouse.up(); await expect(page.getByRole("alert")).toContainText("说话时间太短");
  await released(page); expect(await count(hub, chat)).toBe(0);
  point = await press(page); await recorded(page); await page.mouse.move(point.x, point.y - 100); await page.mouse.move(point.x, point.y);
  await expect(page.locator(".hold-voice")).not.toHaveClass(/is-cancelling/);
  await page.mouse.up(); await released(page); await expect.poll(() => count(hub, chat)).toBe(1);
});

test("late permission, denial, pointer cancellation, backgrounding and native Back never send", async ({ page, hub, chat }) => {
  await mode(page);
  await page.evaluate(() => { (window as any).__mic.mode = "pending"; });
  await press(page); await expect(page.getByText("等待麦克风权限…", { exact: true })).toBeVisible(); await page.mouse.up();
  await page.evaluate(() => (window as any).__mic.resolve()); await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.length)).toBe(1); await released(page);
  await page.evaluate(() => { (window as any).__mic.mode = "deny"; }); await press(page); await page.mouse.up();
  await expect(page.getByRole("alert")).toContainText("允许麦克风"); await released(page);
  await page.evaluate(() => { (window as any).__mic.mode = "ok"; });
  for (const interruption of ["pointercancel", "background", "back"]) {
    await press(page); await recorded(page);
    if (interruption === "pointercancel") await hold(page).dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true });
    if (interruption === "background") await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    if (interruption === "back") expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await page.mouse.up(); await released(page); await expect(page.locator(".hold-voice-panel")).toHaveCount(0);
    await page.evaluate(() => { delete (document as any).visibilityState; });
    expect(await count(hub, chat)).toBe(0);
  }
});

test("keyboard hold supports release and Escape without repeated recordings", async ({ page, hub, chat }) => {
  await mode(page); await hold(page).focus(); await page.keyboard.down("Space"); await recorded(page);
  await page.keyboard.down("Space"); await page.keyboard.press("Escape"); await page.keyboard.up("Space"); await released(page);
  expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(1); expect(await count(hub, chat)).toBe(0);
  await hold(page).focus(); await page.keyboard.down("Enter"); await recorded(page); await page.keyboard.up("Enter");
  await released(page); await expect.poll(() => count(hub, chat)).toBe(1);
});

test("delayed encoding after navigation stays in the originating draft and never sends", async ({ page, hub, chat }) => {
  await mode(page); await press(page); await recorded(page);
  await page.evaluate(() => { const recorder = (window as any).__mic.recorder as MediaRecorder; const stopped = recorder.onstop!; recorder.onstop = event => { (window as any).releaseVoice = () => stopped.call(recorder, event); }; });
  await page.mouse.up(); await page.waitForFunction(() => typeof (window as any).releaseVoice === "function");
  await selectConversation(page, "第二段对话"); await page.evaluate(() => (window as any).releaseVoice()); await released(page);
  await page.getByRole("button", { name: "切换到键盘", exact: true }).click(); await expect(page.locator(".audio-draft")).toHaveCount(0);
  await selectConversation(page, "第一段对话"); await expect(page.locator(".audio-draft audio")).toHaveCount(1);
  await page.reload(); await waitForClientOnline(page); await selectConversation(page, "第一段对话");
  await expect(page.locator(".audio-draft audio")).toHaveCount(1); expect(await count(hub, chat)).toBe(0);
});

test("a rejected upload retains a playable voice draft that can be retried", async ({ page, hub, chat }) => {
  await page.route("**/api/uploads", route => route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "fixture_upload_rejected" }) }));
  await mode(page); await press(page); await recorded(page); await page.mouse.up(); await released(page);
  await expect(page.getByRole("alert")).toContainText("语音未发送，已保留为草稿");
  await expect(page.locator(".audio-draft audio")).toHaveCount(1); expect(await count(hub, chat)).toBe(0);
  await page.unroute("**/api/uploads"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => count(hub, chat)).toBe(1); await expect(page.locator(".audio-draft")).toHaveCount(0);
});

test("recording stays inside narrow and landscape safe areas", async ({ page, chat }, info) => {
  void chat;
  await page.addStyleTag({ content: ":root { --safe-area-inset-top: 30px; --safe-area-inset-bottom: 20px; --safe-area-inset-left: 25px; --safe-area-inset-right: 25px; }" });
  await mode(page);
  for (const size of [{ width: 320, height: 640 }, { width: 740, height: 390 }]) {
    await page.setViewportSize(size); await press(page); await recorded(page);
    const button = (await hold(page).boundingBox())!, panel = (await page.locator(".hold-voice-panel").boundingBox())!;
    expect(button.y + button.height).toBeLessThanOrEqual(size.height - 19); expect(panel.y).toBeGreaterThan(29);
    expect(button.x).toBeGreaterThanOrEqual(25); expect(button.x + button.width).toBeLessThanOrEqual(size.width - 25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`hold-${size.width}.png`), fullPage: true });
    await hold(page).dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true }); await page.mouse.up(); await released(page);
  }
});

test("an interrupted upload exposes progress and cancellation without sending", async ({ page, hub, chat }) => {
  await page.route("**/api/uploads", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_temporary_failure" }) }));
  await mode(page); await press(page); await recorded(page); await page.mouse.up();
  await expect(page.getByText("连接中断，等待恢复…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消上传", exact: true }).click();
  await expect(page.locator(".audio-draft audio")).toHaveCount(1); await released(page);
  expect(await count(hub, chat)).toBe(0);
});

test("trusted Chromium touch capture supports hold, slide cancellation and release", async ({ page, context, browserName, hub, chat }) => {
  test.skip(browserName !== "chromium", "Trusted touch injection is available through Chromium's test protocol only.");
  await mode(page); const touch = await context.newCDPSession(page);
  try {
    for (const cancel of [true, false]) {
      const box = (await hold(page).boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await recorded(page);
      if (cancel) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 110 }] });
        await expect(page.locator(".hold-voice")).toHaveClass(/is-cancelling/);
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await released(page);
      await expect.poll(() => count(hub, chat)).toBe(cancel ? 0 : 1);
    }
  } finally { await touch.detach(); }
});

async function pressMic(page: Page) {
  const box = (await page.getByRole('button', { name: '录制语音', exact: true }).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y); await page.mouse.down(); return point;
}

test('small mic tap switches modes without recording; long hold shows waveform and sends only voice', async ({ page, hub, chat }, info) => {
  await mode(page); expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(0);
  await page.getByRole('button', { name: '切换到键盘', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '消息', exact: true }); await draft.fill('稍后再发的文字');
  await pressMic(page); await recorded(page);
  await expect(page.locator('.mic-hold-panel')).toBeVisible();
  const wave = page.getByRole('img', { name: '实时录音波形' });
  await expect.poll(() => wave.getAttribute('data-level').then(Number)).toBeGreaterThan(0.1);
  await page.screenshot({ path: info.outputPath('mic-shortcut-waveform.png') });
  await page.mouse.up(); await released(page); await expect.poll(() => count(hub, chat)).toBe(1);
  await expect(page.locator('.mic-hold-panel')).toHaveCount(0); await expect(hold(page)).toHaveCount(0);
  await expect(draft).toHaveValue('稍后再发的文字');
  expect((await hub.store.snapshot('owner', chat)).messages.find(m => m.authorType === 'user')!.blocks.map(b => b.type)).toEqual(['audio']);
});

test('small mic slide, interrupted permission, background and navigation cancel without sending', async ({ page, hub, chat }) => {
  const point = await pressMic(page); await recorded(page); await page.mouse.move(point.x, point.y - 100);
  await expect(page.locator('.mic-hold-panel')).toContainText('松开取消'); await page.mouse.up(); await released(page);
  expect(await count(hub, chat)).toBe(0);
  await page.evaluate(() => { (window as any).__mic.mode = 'pending'; });
  await pressMic(page); await expect(page.getByText('等待麦克风权限…', { exact: true })).toBeVisible(); await page.mouse.up();
  await page.evaluate(() => (window as any).__mic.resolve()); await released(page);
  await page.evaluate(() => { (window as any).__mic.mode = 'ok'; });
  await pressMic(page); await recorded(page);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.mouse.up(); await released(page); await page.evaluate(() => { delete (document as any).visibilityState; });
  await pressMic(page); await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
  await page.mouse.up(); await expect(page.locator('.mobile-home').filter({ visible: true })).toBeVisible();
  await page.waitForTimeout(500); expect(await count(hub, chat)).toBe(0);
  expect(await page.evaluate(() => (window as any).__mic.calls)).toBe(3);
});

test('small mic trusted touch cancels by sliding and keeps the waveform below the header', async ({ page, context, browserName, hub, chat }, info) => {
  test.skip(browserName !== 'chromium', 'Trusted touch injection is Chromium-only.');
  const touch = await context.newCDPSession(page);
  try {
    for (const size of [{width:390,height:844},{width:740,height:390}]) {
      await page.setViewportSize(size);
      await page.getByRole('textbox',{name:'消息',exact:true}).fill('这是保留的长草稿。'.repeat(40));
      const box = (await page.getByRole('button',{name:'录制语音',exact:true}).boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]}); await recorded(page);
      const panel = (await page.locator('.mic-hold-panel').boundingBox())!, header = (await page.locator('.conversation-header').filter({visible:true}).boundingBox())!;
      expect(panel.y).toBeGreaterThanOrEqual(header.y + header.height);
      await page.screenshot({path:info.outputPath(`mic-touch-${size.width}.png`)});
      await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-100}]});
      await expect(page.locator('.mic-hold-panel')).toContainText('松开取消');
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await released(page);
      expect(await count(hub,chat)).toBe(0);
    }
  } finally { await touch.detach(); }
});

for (const entry of ['small mic', 'wide hold button'] as const) test(`${entry} keeps the waveform panel fixed while permission and metering become ready`, async ({ page, hub, chat }, info) => {
  if (entry === 'wide hold button') await mode(page);
  await page.evaluate(() => { (window as any).__mic.mode = 'pending'; });
  if (entry === 'small mic') await pressMic(page); else await press(page);
  await expect(page.getByText('等待麦克风权限…', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const mic = (window as any).__mic;
    // A delayed AudioContext resume must not insert a line into the panel.
    await mic.contexts[0].suspend();
    const frames: { top: number; height: number; waveTop: number; composerTop: number }[] = [];
    const probe = { frames, frame: 0 };
    (window as any).__voiceLayout = probe;
    const sample = () => {
      const panel = document.querySelector('.hold-voice-panel'), wave = panel?.querySelector('svg'), composer = document.querySelector('.composer-wrap');
      if (panel && wave && composer) { const r = panel.getBoundingClientRect(); frames.push({ top: r.top, height: r.height, waveTop: wave.getBoundingClientRect().top, composerTop: composer.getBoundingClientRect().top }); }
      probe.frame = requestAnimationFrame(sample);
    };
    sample(); mic.resolve();
  });
  await expect(page.getByText('音量指示暂不可用', { exact: true })).toBeVisible();
  await recorded(page);
  await page.evaluate(() => (window as any).__mic.contexts[0].resume());
  await expect(page.getByText('音量指示暂不可用', { exact: true })).toBeHidden();
  await expect.poll(() => page.getByRole('img', { name: '实时录音波形' }).getAttribute('data-level').then(Number)).toBeGreaterThan(0.1);
  const frames = await page.evaluate(() => { const probe = (window as any).__voiceLayout; cancelAnimationFrame(probe.frame); return probe.frames as { top: number; height: number; waveTop: number; composerTop: number }[]; });
  await info.attach('recording-layout', { body: JSON.stringify(frames), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('stable-recording.png') });
  // Cancel the held capture before assertions: this check must never send.
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up(); await released(page);
  expect(await count(hub, chat)).toBe(0);
  expect(frames.length).toBeGreaterThan(5);
  for (const metric of ['top', 'height', 'waveTop', 'composerTop'] as const) {
    const values = frames.map(frame => frame[metric]);
    expect(Math.max(...values) - Math.min(...values), `${metric} moved during recorder startup`).toBeLessThanOrEqual(1);
  }
});
