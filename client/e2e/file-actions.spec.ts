import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import { createServer } from "./fixtures/vite.js";

test("cancel responds while its cache lookup stalls and stale lookups cannot replace a newer action", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/download-cancel.html");
    const button = page.getByRole("button", { name: "另存为 cancel.bin", exact: true }), status = page.getByRole("status");
    await button.click(); await page.getByRole("button", { name: "取消下载", exact: true }).click();
    await expect(status).toHaveText("下载已取消"); await expect(button).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).cancelFixture.lookups.length)).toBe(1);
    await button.click(); await expect.poll(() => page.evaluate(() => (window as any).cancelFixture.calls)).toBe(2);
    await page.getByRole("button", { name: "取消下载", exact: true }).click(); await expect(status).toHaveText("下载已取消");
    await page.evaluate(() => (window as any).cancelFixture.lookups[0]({ offset: 8388608 }));
    await expect(status).toHaveText("下载已取消");
    await button.click(); await expect.poll(() => page.evaluate(() => (window as any).cancelFixture.calls)).toBe(3);
    await page.evaluate(() => (window as any).cancelFixture.lookups[1]({ offset: 8388608 }));
    await expect(status).toHaveText("下载中 0%");
    await page.getByRole("button", { name: "取消下载", exact: true }).click();
    await page.evaluate(() => (window as any).cancelFixture.lookups[2](undefined)); await expect(status).toHaveText("下载已取消");
  } finally { await page.close(); await server.close(); }
});

// Real isolated Hub, renderer and shipped SDKs; platform dialogs/files are
// controlled doubles. This does not certify a physical native container.
test.use({ serviceWorkers: "block" });
const name = "阅读方案.txt", title = "文件操作验收";
test("document cards group file details and actions across desktop and narrow pane widths", async ({ page }, info) => {
  test.setTimeout(90_000);
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    for (const [width, palette, theme, viewport, locale = "zh", sample = "archive"] of [[440, "white-violet", "light", 1360], [440, "mono", "light", 1360, "zh", "presentation"], [320, "mono", "dark", 1360, "zh", "presentation"], [320, "white-violet", "light", 1360], [240, "white-violet", "light", 1360], [240, "white-violet", "light", 1360, "en"], [320, "white-violet", "dark", 1360], [320, "cli", "dark", 1360], [320, "sage", "light", 1360], [358, "white-violet", "light", 390], [288, "white-violet", "light", 320]] as const) {
      const english = locale === "en", receipt = english ? "Saved" : "已保存";
      const filename = sample === "presentation" ? "淘通项目汇报_更新1-9月.pptx" : "project-handoff-20261019.zip";
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/saved-file-layout.html?width=${width}&palette=${palette}&theme=${theme}&locale=${locale}&sample=${sample}`);
      await page.evaluate(() => document.fonts.ready);
      const initialPreview = viewport > 760 ? await page.getByRole('button', { name: english ? 'Preview' : '预览', exact: true }).boundingBox() : null;
      await page.getByRole("button", { name: english ? `Save ${filename} as` : `另存为 ${filename}`, exact: true }).click();
      const saved = page.getByRole("status"), open = page.getByRole("button", { name: english ? "Open file" : "打开文件", exact: true }), reveal = page.getByRole("button", { name: english ? "Show in folder" : "打开文件位置", exact: true });
      await expect(saved).toHaveText(receipt);
      const a = (await open.boundingBox())!, b = (await reveal.boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
      expect(b.x - a.x - a.width).toBeLessThanOrEqual(8);
      if (viewport > 760) {
        const toolbar = page.locator('.file-card-toolbar'), preview = toolbar.getByRole('button', { name: english ? 'Preview' : '预览', exact: true });
        await expect(preview).toBeVisible();
        expect(await saved.evaluate(node => getComputedStyle(node).color)).toBe(await page.locator('.file-status-message>svg').evaluate(node => getComputedStyle(node).color));
        expect(await page.locator('.file-card-identity').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (width === 440) {
          const statusBox = (await page.locator('.file-status-message').boundingBox())!, sizeBox = (await page.locator('.file-card-meta>small').boundingBox())!, previewBox = (await preview.boundingBox())!;
          expect(Math.abs(statusBox.y + statusBox.height / 2 - sizeBox.y - sizeBox.height / 2)).toBeLessThanOrEqual(1);
          expect(statusBox.x - sizeBox.x - sizeBox.width).toBeGreaterThanOrEqual(0);
          expect(statusBox.x - sizeBox.x - sizeBox.width).toBeLessThanOrEqual(8);
          expect(Math.abs(previewBox.y - a.y)).toBeLessThanOrEqual(1);
          expect(previewBox.x).toBe(initialPreview!.x);
          expect(previewBox.y).toBe(initialPreview!.y);
        }
      }
      expect(await page.locator(".file-status").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.locator(".file-delivery").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect((await page.locator(".file-delivery").boundingBox())!.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (viewport < 760) { expect(a.height).toBeGreaterThanOrEqual(44); expect(b.width).toBeGreaterThanOrEqual(44); }
      await open.click(); await reveal.click(); await expect(saved).toHaveText(receipt);
      expect(await page.evaluate(() => (window as any).savedLayout.calls.filter((c: string) => c === "open_saved_file" || c === "reveal_saved_file"))).toEqual(["open_saved_file", "reveal_saved_file"]);
      await page.mouse.move(0, 0);
      await page.locator(".file-delivery").screenshot({ path: info.outputPath(`saved-footer-${width}-${palette}-${theme}-${locale}.png`) });
      if (width === 240 && !english) {
        await page.evaluate(() => { (window as any).savedLayout.failDownload = true; });
        await page.getByRole("button", { name: "预览", exact: true }).click();
        await expect(page.getByRole("alert")).toHaveText("测试下载失败：当前连接已中断，请检查网络后重试。");
        expect(await page.getByRole('alert').evaluate(node => getComputedStyle(node).color)).toBe(await page.locator('.file-status-message').evaluate(node => getComputedStyle(node).color));
        await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
        await expect(open).toBeEnabled(); await expect(reveal).toBeEnabled();
        expect(await page.locator(".file-status").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await page.locator(".file-card-identity").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await page.locator('.file-delivery').screenshot({ path: info.outputPath('document-error-narrow.png') });
      }
    }
  } finally { await page.close(); await server.close(); }
});
test("own document cards retain their width with or without a caption", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    for (const width of [700, 240]) for (const caption of ['none', 'text']) {
      await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/saved-file-layout.html?author=user&width=${width}&caption=${caption}&palette=mono`);
      const card = page.getByRole('region', { name: 'project-handoff-20261019.zip', exact: true });
      const assertFits = async () => {
        const geometry = await card.evaluate(node => {
          const box = node.getBoundingClientRect(), message = node.closest('.message')!.getBoundingClientRect();
          return { width: box.width, inside: box.left >= message.left - 1 && box.right <= message.right + 1,
            contentsFit: [...node.querySelectorAll<HTMLElement>('.file-card-identity,.file-card-toolbar')].every(el => el.scrollWidth <= el.clientWidth + 1) };
        });
        expect(geometry.width).toBeGreaterThanOrEqual(Math.min(width, 300) - 1);
        expect(geometry.inside).toBe(true); expect(geometry.contentsFit).toBe(true);
      };
      await assertFits();
      await card.getByRole('button', { name: '另存为 project-handoff-20261019.zip', exact: true }).click();
      await expect(card.getByRole('status')).toHaveText('已保存');
      await assertFits();
      await card.getByRole('button', { name: '打开文件', exact: true }).click();
      await card.getByRole('button', { name: '打开文件位置', exact: true }).click();
      expect(await page.evaluate(() => (window as any).savedLayout.calls.filter((c: string) => c === 'open_saved_file' || c === 'reveal_saved_file'))).toEqual(['open_saved_file', 'reveal_saved_file']);
      await card.screenshot({ path: info.outputPath(`own-file-${width}-${caption}.png`) });
    }
  } finally { await page.close(); await server.close(); }
});
async function fixture(page: Page, run: () => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-actions-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品搭档','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], title, "files");
    const bytes = Buffer.from("阅读方案：打开可以预览，另存为交给当前设备。\n");
    const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: conversation.id, name, size: bytes.length, mime: "text/plain", sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "请查看这份阅读方案。" }, { type: "file", name, size: bytes.length, mime: "text/plain", attachmentId }], status: "complete" });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await enterMobileChat(page, title); await run();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
const card = (page: Page) => page.getByRole("region", { name, exact: true });
const save = (page: Page) => card(page).getByRole("button", { name: `另存为 ${name}`, exact: true });
async function desktopBridge(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    // This fixture doubles the native save API and IPC network boundary. Its
    // requests still reach the real isolated loopback Hub, never a public host.
    const requests = new Map<string, { abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> }>();
    w.fileActions = { calls: [] as string[], mode: "choose", writeError: false, quarantineError: false, opened: [] as string[], openError: false, revealed: [] as string[], revealError: false, holdReveal: false, selected: "/fixture/用户选的名字.txt" }; w.isTauri = true;
    w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      const state = w.fileActions; state.calls.push(command);
      switch (command) {
        case "net_document": return "file-actions-document";
        case "net_allocate": { if (args.kind !== "http") throw new Error("unexpected_socket"); const id = crypto.randomUUID(); requests.set(id, { abort: new AbortController() }); return id; }
        case "net_http_open": {
          const request = requests.get(args.id)!, input = args.input;
          if (input.origin !== location.origin) throw new Error("fixture_origin_escape");
          const response = await fetch(input.origin + input.path, { method: input.method, headers: input.headers, signal: request.abort.signal, redirect: "error", body: input.body == null ? undefined : Uint8Array.from(atob(input.body), c => c.charCodeAt(0)) });
          request.reader = response.body?.getReader(); return { status: response.status, headers: [...response.headers] };
        }
        case "net_http_read": { const result = await requests.get(args.id)?.reader?.read(); if (!result || result.done) { requests.delete(args.id); return new ArrayBuffer(0); } return result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength); }
        case "net_cancel": { const request = requests.get(args.id); requests.delete(args.id); request?.abort.abort(); await request?.reader?.cancel().catch(() => undefined); return; }
        case "plugin:dialog|save": return state.mode === "choose" ? new Promise(resolve => { state.choose = resolve; }) : state.selected;
        case "open_saved_file": state.opened.push(args.path); if (state.openError) throw "saved_file_unavailable"; return;
        case "reveal_saved_file":
          state.revealed.push(args.path); if (state.revealError) throw "saved_file_unavailable";
          if (state.holdReveal) return new Promise<void>(resolve => { state.reveal = resolve; });
          return;
        case "plugin:fs|open": return 7;
        case "quarantine_saved_file": if (state.quarantineError) throw "saved_file_quarantine_failed"; return;
        case "plugin:fs|ftruncate": return;
        case "plugin:fs|write":
          if (state.writeError) throw "No space left on device (os error 28)";
          return new Promise(resolve => { state.write = () => resolve(args.data.length); });
        case "plugin:resources|close": return;
        default: throw new Error(`unexpected_ipc:${command}`);
      }
    } };
  });
}
const calls = (page: Page) => page.evaluate(() => (window as any).fileActions.calls as string[]);
async function expectStatusFits(page: Page) {
  expect(await card(page).locator(".file-status").evaluate(status => {
    const own = status.getBoundingClientRect(), parent = status.parentElement!.getBoundingClientRect();
    return own.left >= parent.left && own.right <= parent.right && status.scrollWidth <= status.clientWidth + 1;
  })).toBe(true);
}

test("save phases distinguish selection, writing, cancellation and a confirmed saved file", async ({ page }, info) => {
  await fixture(page, async () => {
    await expect(card(page)).not.toContainText("0.00 MB");
    await desktopBridge(page); await save(page).click();
    await expect(card(page).getByRole("status")).toContainText(/保存位置/);
    await expect(card(page).getByRole("button", { name: "取消下载", exact: true })).toHaveCount(0);
    await expect(save(page)).toBeDisabled();
    await expect.poll(async () => (await calls(page)).filter(c => c === "plugin:dialog|save").length).toBe(1);
    await page.evaluate(() => (window as any).fileActions.choose(null));
    await expect(save(page)).toBeEnabled(); await expect(card(page).getByRole("status")).toContainText(/已取消/);
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0); expect(await calls(page)).not.toContain("plugin:fs|open");
    await page.evaluate(() => { (window as any).fileActions.mode = "save"; }); await save(page).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).fileActions.write)).toBe("function");
    await expect(card(page).getByRole("status")).toContainText(/保存/);
    await expect(card(page)).not.toContainText("下载中 100%");
    await expect(card(page).getByRole("button", { name: "取消下载", exact: true })).toHaveCount(0);
    await expectStatusFits(page);
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("desktop-saving.png") });
    await page.evaluate(() => (window as any).fileActions.write());
    await expect(card(page).getByRole("status")).toContainText("已保存");
    await expect.poll(async () => (await calls(page)).filter(c => c === "plugin:resources|close").length).toBe(1);
    await expect(save(page)).toBeEnabled();
    await card(page).getByRole("button", { name: "打开文件", exact: true }).click();
    expect(await page.evaluate(() => (window as any).fileActions.opened)).toEqual(["/fixture/用户选的名字.txt"]);
  });
});

test("saved file opens and reveals from preview or chat, preserves save success on failure and clears stale targets on a new save", async ({ page }, info) => {
  await fixture(page, async () => {
    await desktopBridge(page);
    await page.evaluate(() => { (window as any).fileActions.mode = "save"; });
    await card(page).getByRole("button", { name: "预览", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
    await preview.getByRole("button", { name: "另存为", exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).fileActions.write)).toBe("function");
    await expect(preview.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).fileActions.write());
    await expect(preview.getByRole("status")).toHaveText("已保存");
    await preview.getByRole("button", { name: "打开文件", exact: true }).click();
    await page.evaluate(() => { (window as any).fileActions.holdReveal = true; });
    await preview.getByRole("button", { name: "打开文件位置", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(preview.getByRole("button", { name: "正在定位…", exact: true })).toBeDisabled();
    await expect(preview.getByRole("button", { name: "正在定位…", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(preview.getByRole("button", { name: "打开文件", exact: true })).toBeDisabled();
    await expect(preview.getByRole("button", { name: "另存为", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).fileActions.revealed)).toEqual(["/fixture/用户选的名字.txt"]);
    await page.evaluate(() => { const state = (window as any).fileActions; state.holdReveal = false; state.reveal(); });
    await expect(preview.getByRole("button", { name: "打开文件位置", exact: true })).toBeEnabled();
    await expect(preview.getByRole("button", { name: "打开文件位置", exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath("saved-open-preview.png") });
    await preview.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(card(page).getByRole("status")).toHaveText("已保存");
    await page.evaluate(() => { (window as any).fileActions.openError = true; });
    await card(page).getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(card(page).getByRole("alert")).toContainText("无法打开已保存的文件");
    await expect(card(page).getByRole("status")).toHaveText("已保存");
    await page.evaluate(() => { (window as any).fileActions.openError = false; });
    await card(page).getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).fileActions.opened)).toEqual(Array(3).fill("/fixture/用户选的名字.txt"));
    await page.evaluate(() => { (window as any).fileActions.revealError = true; });
    await card(page).getByRole("button", { name: "打开文件位置", exact: true }).click();
    await expect(card(page).getByRole("alert")).toContainText("无法打开文件位置");
    await expect(card(page).getByRole("status")).toHaveText("已保存");
    await expect(card(page).getByRole("button", { name: "打开文件", exact: true })).toBeEnabled();
    await page.evaluate(() => { (window as any).fileActions.revealError = false; });
    await card(page).getByRole("button", { name: "打开文件位置", exact: true }).click();
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).fileActions.revealed)).toEqual(Array(3).fill("/fixture/用户选的名字.txt"));
    await page.screenshot({ path: info.outputPath("saved-reveal-chat.png") });
    await page.setViewportSize({ width: 320, height: 844 }); await expectStatusFits(page);
    expect(await card(page).getByRole("status").evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("saved-reveal-narrow.png") });
    await page.evaluate(() => { (window as any).fileActions.mode = "choose"; });
    await save(page).click();
    await expect(card(page).getByRole("status")).toContainText(/保存位置/);
    await page.evaluate(() => (window as any).fileActions.choose(null));
    await expect(card(page).getByRole("status")).toContainText(/已取消/);
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).fileActions.mode = "save"; });
    await page.evaluate(() => { (window as any).fileActions.quarantineError = true; });
    await save(page).click();
    await expect(card(page).getByRole("alert")).toHaveText("无法在此位置安全保存附件，请选择其他文件夹后重试。");
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
    await page.evaluate(() => { Object.assign((window as any).fileActions, { quarantineError: false, writeError: true, selected: "/fixture/failed.txt" }); });
    await save(page).click(); await expect(card(page).getByRole("alert")).toContainText("保存失败");
    await expect(card(page).getByRole("alert")).toContainText("所选位置可能留下不完整的文件");
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
  });
});

test("preview shows save errors and all close actions stay usable during writing", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, async () => {
    await desktopBridge(page);
    await page.evaluate(() => { Object.assign((window as any).fileActions, { mode: "save", writeError: true }); });
    await card(page).getByRole("button", { name: `预览 ${name}`, exact: true }).click();
    const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
    await expect.poll(() => preview.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await preview.getByRole("button", { name: "另存为", exact: true }).click();
    await expect(preview.getByRole("alert")).toContainText(/保存失败/);
    await expect(preview.getByRole("button", { name: "另存为", exact: true })).toBeEnabled();
    const retryBounds = await preview.getByRole("button", { name: "重试", exact: true }).boundingBox();
    expect(retryBounds?.width).toBeGreaterThanOrEqual(44);
    expect(retryBounds?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath("phone-preview-save-error.png") });
    await page.evaluate(() => { (window as any).fileActions.writeError = false; });
    for (const close of ["button", "escape", "native"]) {
      if (!await preview.isVisible()) await card(page).getByRole("button", { name: `预览 ${name}`, exact: true }).click();
      await page.evaluate(() => { delete (window as any).fileActions.write; });
      await preview.getByRole("button", { name: "另存为", exact: true }).click();
      await expect.poll(() => page.evaluate(() => typeof (window as any).fileActions.write)).toBe("function");
      await expect(preview.getByRole("status")).toContainText(/保存/);
      await expect(preview.getByRole("button", { name: "另存为", exact: true })).toBeDisabled();
      if (close === "button") await preview.getByRole("button", { name: "关闭", exact: true }).click();
      else if (close === "escape") await page.keyboard.press("Escape");
      else expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
      await expect(preview).toHaveCount(0); await expect(card(page).getByRole("status")).toContainText(/保存/);
      await expect(card(page).getByRole("button", { name: `预览 ${name}`, exact: true })).toBeFocused();
      await page.evaluate(() => (window as any).fileActions.write()); await expect(save(page)).toBeEnabled();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test("browser download is a handoff, not an asserted disk save", async ({ page }) => {
  await fixture(page, async () => {
    const downloaded = page.waitForEvent("download"); await save(page).click();
    expect(await (await downloaded).failure()).toBeNull();
    await expect(card(page).getByRole("status")).toContainText(/浏览器/);
    await expect(card(page).getByRole("status")).not.toContainText("已保存");
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
  });
});

for (const width of [390, 320]) test(`phone save and share are separate, with truthful receipts (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await fixture(page, async () => {
    const english = width === 320;
    if (english) {
      const { openSettings, closeSettings } = await import("./fixtures/settings.js");
      const { mobileHome } = await import("./fixtures/mobile.js");
      await openSettings(page); await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
      await closeSettings(page, true);
      await mobileHome(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
      await enterMobileChat(page, title);
    }
    await page.evaluate(() => {
      const w = window as any, cap = w.Capacitor;
      w.phoneFileActions = { calls: [] as any[], holdPreparation: true }; w.androidBridge = {};
      cap.PluginHeaders = [
        { name: "Filesystem", methods: ["readdir", "mkdir", "writeFile", "appendFile", "getUri", "rmdir"].map(name => ({ name, rtype: "promise" })) },
        { name: "Share", methods: [{ name: "share", rtype: "promise" }] },
        { name: "TaroBotAttachmentSaver", methods: [{ name: "save", rtype: "promise" }] },
      ];
      cap.nativePromise = async (plugin: string, method: string, options: any) => {
        const state = w.phoneFileActions; state.calls.push({ plugin, method, options });
        if (plugin === "Filesystem") {
          if (method === "readdir") return { files: [] };
          if (method === "getUri") return { uri: `file:///fixture/${options.path}` };
          if (method === "appendFile" && state.holdPreparation) return new Promise(resolve => { state.prepare = () => { state.holdPreparation = false; resolve({}); }; });
          if (["mkdir", "writeFile", "appendFile", "rmdir"].includes(method)) return {};
        }
        if (plugin === "TaroBotAttachmentSaver") return new Promise((resolve, reject) => { state.save = resolve; state.rejectSave = reject; });
        if (plugin === "Share") return new Promise((resolve, reject) => { state.share = resolve; state.rejectShare = reject; });
        throw new Error(`unexpected_native:${plugin}.${method}`);
      };
    });
    await card(page).getByRole("button", { name: english ? `Preview ${name}` : `预览 ${name}`, exact: true }).click();
    const preview = page.getByRole("dialog", { name: english ? "File preview" : "文件预览", exact: true });
    const saveButton = preview.getByRole("button", { name: english ? "Save to device" : "保存到手机", exact: true });
    const shareButton = preview.getByRole("button", { name: english ? "Share attachment" : "分享附件", exact: true });
    await saveButton.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.prepare)).toBe("function");
    await expect(preview.getByRole("status")).toContainText(english ? /prepar/i : /准备/);
    await page.evaluate(() => (window as any).phoneFileActions.prepare());
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.save)).toBe("function");
    await expect(shareButton).toBeDisabled();
    expect(await page.evaluate(() => (window as any).phoneFileActions.calls.some((c: any) => c.plugin === "Share"))).toBe(false);
    await page.evaluate(() => (window as any).phoneFileActions.save({ saved: true, location: "Download/TaroBird/阅读方案.txt" }));
    await expect(preview.getByRole("status")).toHaveText(english ? "Saved to device" : "已保存到手机");
    await expect(preview.getByRole("button", { name: english ? "Open file" : "打开文件", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: english ? "Show in folder" : "打开文件位置", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(saveButton).toBeEnabled(); await expect(saveButton).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath(`saved-${width}.png`) });
    await page.evaluate(() => { delete (window as any).phoneFileActions.rejectSave; }); await saveButton.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.rejectSave)).toBe("function");
    await page.evaluate(() => (window as any).phoneFileActions.rejectSave(new Error("disk full")));
    await expect(preview.getByRole("alert")).toContainText(english ? /save/i : /保存失败/);
    await shareButton.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.rejectShare)).toBe("function");
    await expect(preview.getByRole("status")).toContainText(english ? /shar/i : /分享/);
    await page.evaluate(() => (window as any).phoneFileActions.rejectShare(new Error("Share canceled")));
    await expect(preview.getByRole("status")).toContainText(english ? /cancel|closed/i : /关闭/);
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await page.evaluate(() => { delete (window as any).phoneFileActions.share; }); await shareButton.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.share)).toBe("function");
    await page.evaluate(() => (window as any).phoneFileActions.share({ activityType: "fixture.receiver" }));
    await expect(preview.getByRole("status")).toContainText(english ? /shar/i : /分享/);
    await expect(preview.getByRole("status")).not.toContainText(english ? /saved/i : /已保存/);
    const bounds = await preview.locator("header button").evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    expect(bounds.every(b => b.width >= 44 && b.height >= 44)).toBe(true);
    // The three actions stay on one row inside the 12px inset, with Chinese and
    // English labels; each 44px target paints a 32px capsule.
    const actions = await preview.locator(".native-file-actions > button").evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, fill: getComputedStyle(button, "::before").height }; }));
    expect(actions).toHaveLength(3); expect(new Set(actions.map(action => action.top)).size).toBe(1);
    expect(actions.map(action => action.fill)).toEqual(["32px", "32px", "32px"]);
    expect(actions[0]!.left).toBeGreaterThanOrEqual(12); expect(actions[2]!.right).toBeLessThanOrEqual(width - 12);
    expect(actions.every((action, index) => !index || action.left >= actions[index - 1]!.right)).toBe(true);
    await preview.getByRole("button", { name: english ? "Close" : "关闭", exact: true }).click();
    await page.evaluate(() => { delete (window as any).phoneFileActions.save; });
    await card(page).getByRole("button", { name: english ? `Save ${name} to device` : `保存到手机 ${name}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).phoneFileActions.save)).toBe("function");
    await page.evaluate(() => (window as any).phoneFileActions.save({ saved: false }));
    await expect(card(page).getByRole("status")).toContainText(english ? /cancel/i : /取消保存/);
    await expectStatusFits(page);
  });
});
