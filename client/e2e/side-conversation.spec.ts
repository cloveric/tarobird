import { preparePairing } from "./fixtures/pairing-invite.js";
import { microphone } from "./fixtures/microphone.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, enterMobileChat } from "./fixtures/mobile.js";

async function setup(supported = true, attachments: { images: boolean; files: "any" | "text" } | null = { images: true, files: "any" }, options: { toolAccess?: boolean; delivery?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "side-ui-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Codex',?,'codex')", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "同步机制优化", "side_main");
  await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "已经完成增量同步：只传输发生变化的消息。\n\n下一步验证临时侧边对话，确认主任务继续执行，临时问答关闭后清除。" }] });
  const image = path.join(stateDir, "workspace", "side-overview.png");
  await mkdir(path.dirname(image), { recursive: true });
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64"));
  const receipts: unknown[] = [];
  const transcripts: string[] = [];
  const sideFiles: { name: string; kind: string; bytes: string; text?: string }[][] = [];
  const sideCalls: string[] = [], mainCalls: string[] = [], disposed: string[] = [], openTools: string[] = []; let sequence = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime({ transcribeMedia: async file => { const data = await readFile(file); if (!data.length) throw Error("empty recording"); transcripts.push(file); return "侧边录音转写完成"; } }), bridge: {
    handleAuthorizedMessage: async input => { mainCalls.push(input.text); return { text: "主对话正常回复" }; },
    // `toolAccess` emulates a Codex side that can inherit configured tools when asked.
    sideCapability: (input?: { tools?: "inherited" }) => ({ context: supported ? "native" : "none", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: false, attachments: attachments ? { ...attachments, paths: attachments.images || attachments.files === "any" } : undefined, ...(options.toolAccess && input?.tools === "inherited" ? { toolAccess: "inherited" as const, ...(options.delivery ? { delivery: true as const } : {}) } : {}) }),
    openSideSession: async (input?: { tools?: "inherited" }) => {
      openTools.push(input?.tools ?? "none");
      const nativeId = `temporary_${++sequence}`; let history = 0;
      return { nativeId, dispose: async () => { disposed.push(nativeId); }, send: async ({ text, attachments: files, appPlatformTools, onEngineEvent, abortSignal }) => {
        sideCalls.push(text); history++;
        if (text === "发送侧边图片") {
          if (!appPlatformTools) throw Error("missing side receiver");
          const call = { name: "app_send_file", arguments: { path: image, kind: "image", caption: "侧边头像总览" }, sessionId: nativeId, callId: "image-one", abortSignal };
          receipts.push(await appPlatformTools.call(call)); receipts.push(await appPlatformTools.call(call));
          return { text: "已发送到侧边，可点开查看。" };
        }
        const received = await Promise.all((files ?? []).map(async file => ({ name: file.name, kind: file.kind, bytes: (await readFile(file.path)).toString("base64") }))); sideFiles.push(received);
        if (text === "慢回答") {
          await onEngineEvent({ type: "assistant_text", text: "正在检查边界条件…", delta: true });
          await new Promise<void>(resolve => { if (abortSignal.aborted) resolve(); else abortSignal.addEventListener("abort", () => resolve(), { once: true }); });
          abortSignal.throwIfAborted();
        }
        const answer = received.length ? `已读取附件：${received.map(file => file.name).join("、")}` : text === "长内容" ? "下面是需要重点验证的场景：\n\n" + Array.from({ length: 12 }, (_, i) => `${i + 1}. 关闭窗口后，临时问题与回复都应从侧边面板移除。`).join("\n") + "\n\n```typescript\nconst temporaryConversation = await openSideSession({ parentConversationId: 'main', ephemeral: true, sandbox: 'read-only' });\n```\n\n| 检查项 | 结果 |\n|---|---|\n| 主对话历史 | 保持完整 |\n| 临时上下文 | 继承当前对话 |" : history === 1 ? "**增量同步**只补充发生变化的消息，因此离线后的恢复更快。\n\n- 主对话可以继续收发。\n- 侧边问题不会写入主对话。\n\n可以接着问一个细节。" : "第二轮继续沿用临时上下文。重点检查取消、断线恢复与权限变更。";
        await onEngineEvent({ type: "assistant_text", text: answer.slice(0, 20), delta: true });
        await new Promise(resolve => setTimeout(resolve, 120));
        return { text: answer, usage: { inputTokens: 10, outputTokens: 20 } };
      } };
    },
  } });
  const gates: { open?: () => Promise<void>; beforeAsk?: () => Promise<void>; ask?: () => Promise<void> } = {}, call = gateway.onCall!;
  gateway.onCall = async (method, params) => { if (method === "side.ask") await gates.beforeAsk?.(); const result = await call(method, params); if (method === "side.ask") await gates.ask?.(); if (method === "side.open") await gates.open?.(); return result; };
  const changeEngine = async (engine: string, available: boolean) => {
    supported = available;
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "zh" }));
    await hub.store.botStatus("alpha", { engine });
    await (hub as unknown as { broadcastBotStatus(id: string): Promise<void> }).broadcastBotStatus("alpha");
  };
  return { root, stateDir, hub, chat, receipts, transcripts, sideCalls, sideFiles, mainCalls, disposed, openTools, openedCount: () => sequence, gates, changeEngine, offline: () => gateway.disconnect(), close: async () => { await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
test("main and side composers align at rest and after a multiline draft shrinks", async ({ page }, info) => {
  const f = await setup();
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    const input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    const main = page.locator(".conversation-main .composer"), side = panel.locator(".side-composer");
    const geometry = () => page.evaluate(() => {
      const read = (selector: string) => { const box = document.querySelector(selector)!.getBoundingClientRect(); return { height: box.height, bottom: box.bottom }; };
      return { main: read(".conversation-main .composer"), side: read(".side-composer"), mainSend: read(".conversation-main .send-button"), sideSend: read(".side-composer .send-button") };
    });
    for (const width of [1280, 1600]) for (const fontSize of [14, 20]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.locator("#font-size").fill(String(fontSize));
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect(input).toBeVisible();
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.main.bottom - g.side.bottom); }).toBeLessThanOrEqual(1);
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.main.height - g.side.height); }).toBeLessThanOrEqual(1);
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.mainSend.bottom - g.sideSend.bottom); }).toBeLessThanOrEqual(1);
      await expect(input).toHaveCSS("font-size", "13px");
      await input.fill("一行追问");
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.main.height - g.side.height); }).toBeLessThanOrEqual(1);
      const short = (await side.boundingBox())!.height;
      await input.fill("一段多行的侧边问题\n".repeat(18));
      await expect.poll(async () => (await side.boundingBox())!.height).toBeGreaterThan(short);
      await expect(panel.getByRole("button", { name: "发送侧边问题", exact: true })).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.main.bottom - g.side.bottom); }).toBeLessThanOrEqual(1);
      await input.fill("");
      await expect.poll(async () => { const g = await geometry(); return Math.abs(g.main.height - g.side.height); }).toBeLessThanOrEqual(1);
      await panel.locator(".side-footnote").waitFor({ state: "visible" });
      await input.fill("保留追问"); await input.press("Escape");
      await expect(main.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
      await input.fill("");
      await info.attach(`composer-geometry-${width}-${fontSize}`, { body: JSON.stringify(await geometry()), contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`composers-${width}-${fontSize}.png`), animations: "disabled" });
    }
  } finally { await page.close(); await f.close(); }
});

test("side file picker keeps attachment-only drafts on navigation and sends real bytes without a main message", async ({ page }, info) => {
  const f = await setup(), bytes = Buffer.from("PRIVATE-SIDE-FILE-438 only inside the attachment");
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "附件切换目标", "file_other");
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    const chooser = page.waitForEvent("filechooser"); await panel.getByRole("button", { name: "添加侧边附件", exact: true }).click();
    await (await chooser).setFiles({ name: "side-note.txt", mimeType: "text/plain", buffer: bytes });
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("side-note.txt");
    await input.press("Escape"); await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 480 }); await input.fill("较长的附件说明\n".repeat(18));
    await expect(panel.locator(".side-footnote")).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole("button", { name: "发送侧边问题", exact: true })).toBeInViewport({ ratio: 1 });
    await input.fill("");
    await selectConversation(page, other.title); await expect(panel).toHaveCount(0);
    await selectConversation(page, f.chat.title); await expect(panel).toBeVisible();
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("side-note.txt");
    await page.screenshot({ path: info.outputPath("side-attachment-draft.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("已读取附件：side-note.txt");
    expect(f.sideCalls).toEqual([""]); expect(f.sideFiles).toEqual([[{ name: "side-note.txt", kind: "text", bytes: bytes.toString("base64") }]]);
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toHaveCount(0);
    await expect(panel.locator(".side-question-attachments")).toContainText("side-note.txt");
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1); expect(f.mainCalls).toEqual([]);
    await page.screenshot({ path: info.outputPath("side-attachment-received.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await expect.poll(() => f.disposed.length).toBe(1);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toHaveCount(0);
    await expect(panel.locator(".side-exchange")).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

test("side mixed paste and drop stay separate from the main draft and reach the engine", async ({ page }) => {
  const f = await setup();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=";
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const main = page.getByRole("textbox", { name: "消息", exact: true }); await main.fill("主对话草稿保留");
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await input.evaluate((node, data) => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "看一下图片和文件");
      transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], "side-image.png", { type: "image/png" }));
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, png);
    await expect(input).toHaveValue("看一下图片和文件");
    await panel.evaluate(node => {
      const transfer = new DataTransfer(); transfer.items.add(new File(["Dropped side data"], "side-drop.txt", { type: "text/plain" }));
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("side-drop.txt");
    await expect(page.locator(".conversation-main .composer .attachment-draft")).toHaveCount(0); await expect(main).toHaveValue("主对话草稿保留");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("已读取附件：side-image.png、side-drop.txt");
    expect(f.sideCalls).toEqual(["看一下图片和文件"]);
    expect(f.sideFiles[0]).toEqual([{ name: "side-image.png", kind: "image", bytes: png }, { name: "side-drop.txt", kind: "text", bytes: Buffer.from("Dropped side data").toString("base64") }]);
    await expect(panel.locator(".side-question-attachments img")).toBeVisible();
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test("a delayed attachment receipt cannot clear a different conversation or its new side draft", async ({ page }) => {
  const f = await setup(); let release: (() => void) | undefined;
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "回执抵达时所在对话", "receipt_other");
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await panel.locator('input[type="file"]').setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from("pending bytes") });
    await input.fill("附件回执等待"); f.gates.ask = () => new Promise<void>(resolve => { release = resolve; });
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect.poll(() => f.sideCalls.length).toBe(1); await expect.poll(() => typeof release).toBe("function");
    await input.fill("A 后来写的新问题");
    await panel.locator('input[type="file"]').setInputFiles({ name: "next.txt", mimeType: "text/plain", buffer: Buffer.from("next bytes") });
    await selectConversation(page, other.title); await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    await input.fill("B 的草稿"); release!();
    await expect(input).toHaveValue("B 的草稿"); await expect(panel.locator(".side-exchange")).toHaveCount(0);
    await selectConversation(page, f.chat.title); await expect(input).toHaveValue("A 后来写的新问题");
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("next.txt");
    await expect(panel.getByRole("region", { name: "待发送的附件" })).not.toContainText("pending.txt");
    expect(f.sideCalls).toEqual(["附件回执等待"]); expect(f.sideFiles[0]?.[0]?.name).toBe("pending.txt");
    expect(f.disposed).toEqual([]);
  } finally { release?.(); await page.close(); await f.close(); }
});

test("native text-only side engines reject image drafts without disturbing existing text files", async ({ page }) => {
  const f = await setup(true, { images: false, files: "text" });
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("textbox", { name: "侧边问题", exact: true })).toBeVisible();
    await expect(panel.getByText("此引擎的侧边对话仅支持文本文件。", { exact: true })).toHaveCount(0);
    await panel.locator('input[type="file"]').setInputFiles({ name: "allowed.txt", mimeType: "text/plain", buffer: Buffer.from("allowed text") });
    await panel.locator('input[type="file"]').setInputFiles({ name: "unsupported.png", mimeType: "image/png", buffer: Buffer.from("image") });
    await expect(panel.getByRole("alert")).toContainText("此引擎的侧边对话暂不支持图片。");
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("allowed.txt");
    await expect(panel.getByRole("region", { name: "待发送的附件" })).not.toContainText("unsupported.png");
    expect(f.sideCalls).toEqual([]);
  } finally { await page.close(); await f.close(); }
});
test("switching conversations retains each side session, answer and unsent draft", async ({ page }, info) => {
  const f = await setup();
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "临时查看的另一个对话", "side_other");
    await page.setViewportSize({ width: 1196, height: 900 });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const trigger = page.getByRole("button", { name: "侧边对话", exact: true });
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    const input = page.getByRole("textbox", { name: "侧边问题", exact: true });
    await trigger.click(); await input.fill("A 的问题");
    await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("增量同步", { exact: true })).toBeVisible();
    await input.fill("A 尚未发送的草稿");
    await page.getByRole("textbox", { name: "消息", exact: true }).focus();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-navigation-1196.png") });
    await selectConversation(page, other.title); await expect(panel).toHaveCount(0);
    await trigger.click(); await input.fill("B 尚未发送的草稿");
    await selectConversation(page, f.chat.title);
    await expect(panel).toBeVisible(); await expect(input).toHaveValue("A 尚未发送的草稿");
    await expect(input).not.toBeFocused();
    await expect(panel.getByText("增量同步", { exact: true })).toBeVisible();
    // The panel can accept its draft while its native context is still preparing.
    // A fast B -> A navigation must preserve that pending open as well.
    expect(f.disposed).toEqual([]); await expect.poll(() => f.openedCount()).toBe(2);
    // A large desktop must use the available space, not stop at the old 600px cap.
    await page.setViewportSize({ width: 1800, height: 900 });
    const splitter = page.getByRole("separator", { name: "调整侧边对话宽度", exact: true });
    await splitter.press("Enter");
    const handle = (await splitter.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 520, handle.y + 100, { steps: 12 });
    await page.mouse.up();
    await expect(panel).toHaveCSS("width", "960px");
    await expect(splitter).toHaveAttribute("aria-valuenow", "960");
    await expect(input).toHaveValue("A 尚未发送的草稿");
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-expanded-1800.png") });
    // Resizing the window clamps the visible panel without losing the chosen width.
    await page.setViewportSize({ width: 950, height: 900 });
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThan(600);
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect(panel).toHaveCSS("width", "960px");
    await splitter.press("End");
    await expect(panel).toHaveCSS("width", "1072px");
    await expect(splitter).toHaveAttribute("aria-valuemax", "1072");
    await splitter.press("Shift+ArrowRight");
    await expect(panel).toHaveCSS("width", "1040px");
    await splitter.press("Home");
    await expect(panel).toHaveCSS("width", "320px");
    await splitter.dblclick();
    await expect(panel).toHaveCSS("width", "440px");
    for (const width of [950, 820, 761, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const navigation = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
      const sideWidth = page.getByRole("separator", { name: "调整侧边对话宽度", exact: true });
      await navigation.focus(); await navigation.press("End");
      await sideWidth.focus(); await sideWidth.press("End");
      await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        return { navigation: box(".sidebar"), main: box(".conversation-main"), side: box(".side-conversation"), viewport: innerWidth };
      });
      expect(boxes.navigation.width).toBeGreaterThanOrEqual(200);
      expect(boxes.main.width).toBeGreaterThanOrEqual(280);
      expect(boxes.side.width).toBeGreaterThanOrEqual(280);
      expect(boxes.navigation.right).toBeLessThanOrEqual(boxes.main.left + 1);
      expect(boxes.main.right).toBeLessThanOrEqual(boxes.side.left + 1);
      expect(boxes.side.right).toBeLessThanOrEqual(boxes.viewport + 1);
      const controls = await page.locator(".conversation-main .composer-toolbar button:visible").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { label: node.getAttribute("aria-label"), left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      for (let index = 0; index < controls.length; index++) {
        const control = controls[index]!;
        expect(control.left, control.label ?? "composer control").toBeGreaterThanOrEqual(boxes.main.left);
        expect(control.right, control.label ?? "composer control").toBeLessThanOrEqual(boxes.main.right);
        for (const otherControl of controls.slice(index + 1)) {
          const overlap = Math.min(control.right, otherControl.right) - Math.max(control.left, otherControl.left) > 1 && Math.min(control.bottom, otherControl.bottom) - Math.max(control.top, otherControl.top) > 1;
          expect(overlap, `${control.label} overlaps ${otherControl.label}`).toBe(false);
        }
      }
      await expect(panel.getByRole("button", { name: "关闭侧边对话", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole("button", { name: "发送侧边问题", exact: true })).toBeInViewport({ ratio: 1 });
      if (width === 761) await page.screenshot({ animations: "disabled", path: info.outputPath("side-navigation-761.png") });
      await selectConversation(page, other.title); await expect(input).toHaveValue("B 尚未发送的草稿");
      await selectConversation(page, f.chat.title); await expect(input).toHaveValue("A 尚未发送的草稿");
      await navigation.press("Enter"); await sideWidth.press("Enter");
    }
    expect(f.disposed).toEqual([]); expect(f.openedCount()).toBe(2);
    await selectConversation(page, other.title);
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await selectConversation(page, f.chat.title);
    await expect(panel).toBeVisible(); await expect(input).toHaveValue("A 尚未发送的草稿");
    await selectConversation(page, other.title);
    await expect(panel).toBeVisible(); await expect(input).toHaveValue("B 尚未发送的草稿");
    await expect(panel.locator(".side-exchange")).toHaveCount(0);
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await expect.poll(() => f.disposed.length).toBe(1);
    await selectConversation(page, f.chat.title);
    await expect(input).toHaveValue("A 尚未发送的草稿");
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await selectConversation(page, other.title); await expect(panel).toHaveCount(0);
    await selectConversation(page, f.chat.title); await expect(panel).toHaveCount(0);
    await expect.poll(() => f.disposed.length).toBe(2);
    await expect(trigger).toBeEnabled();
    await page.keyboard.press("Control+Shift+K");
    await expect(input).toBeFocused();
  } finally { await page.close(); await f.close(); }
});
test("returning to a side conversation restores its reading position", async ({ page }) => {
  const f = await setup();
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "阅读期间查看的对话", "reading_other");
    await page.setViewportSize({ width: 1196, height: 700 });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await panel.getByRole("textbox", { name: "侧边问题", exact: true }).fill("长内容");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator("table")).toBeVisible();
    await expect(panel.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    const log = panel.getByRole("log");
    await log.evaluate(node => { node.scrollTop = 120; node.dispatchEvent(new Event("scroll")); });
    await expect.poll(() => log.evaluate(node => node.scrollTop)).toBe(120);
    const position = await log.evaluate(node => node.scrollTop);
    await selectConversation(page, other.title); await expect(panel).toHaveCount(0);
    await selectConversation(page, f.chat.title); await expect(panel).toBeVisible();
    await expect.poll(async () => Math.abs(await log.evaluate(node => node.scrollTop) - position)).toBeLessThan(2);
    expect(f.disposed).toEqual([]); expect(f.openedCount()).toBe(1);
  } finally { await page.close(); await f.close(); }
});
test("a running side answer and its lease survive a visit to another conversation", async ({ page }) => {
  const f = await setup();
  let sideReads = 0;
  page.on("request", request => { if (request.method() === "GET" && /\/side\/side_/.test(request.url())) sideReads++; });
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "看一眼另一个对话", "side_visit");
    await page.setViewportSize({ width: 1196, height: 900 });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    const input = page.getByRole("textbox", { name: "侧边问题", exact: true });
    await input.fill("慢回答"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("正在检查边界条件…", { exact: true })).toBeVisible();
    await input.fill("等回答时写的新问题"); await selectConversation(page, other.title);
    await expect(panel).toHaveCount(0); expect(f.disposed).toEqual([]);
    const reads = sideReads;
    await expect.poll(() => sideReads, { timeout: 35_000 }).toBeGreaterThan(reads);
    await selectConversation(page, f.chat.title); await expect(panel).toBeVisible();
    await expect(input).toHaveValue("等回答时写的新问题");
    await expect(panel.getByText("正在检查边界条件…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "停止侧边回答", exact: true }).click();
    await expect(panel.getByText("已停止", { exact: true })).toBeVisible();
    expect(f.sideCalls).toEqual(["慢回答"]); expect(f.disposed).toEqual([]);
  } finally { await page.close(); await f.close(); }
});
test("temporary desktop panel preserves main draft, follows up, stops independently and clears on close", async ({ page }, info) => {
  const f = await setup(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 940 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const main = page.getByRole("textbox", { name: "消息", exact: true }); await main.fill("保留主输入框的草稿");
    const trigger = page.getByRole("button", { name: "侧边对话", exact: true }); await trigger.click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = page.getByRole("textbox", { name: "侧边问题", exact: true });
    await expect(input).toBeFocused(); await expect(panel.getByText("正在准备上下文…", { exact: true })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-empty-light.png") });
    await page.getByRole("button", { name: "解释上一条回复", exact: true }).click();
    expect(f.sideCalls).toEqual([]); await expect(main).toHaveValue("保留主输入框的草稿");
    await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("增量同步", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    await input.fill("还有哪些风险？"); await input.press("Enter"); await expect(panel.getByText("第二轮继续沿用临时上下文。重点检查取消、断线恢复与权限变更。", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-followup-light.png") });
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
    await panel.getByRole("button", { name: "插入主输入框", exact: true }).last().click();
    await expect(main).toHaveValue(/保留主输入框的草稿\n\n> 第二轮/); expect(f.mainCalls).toEqual([]);
    await input.fill("慢回答"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("正在检查边界条件…", { exact: true })).toBeVisible();
    await main.fill("主对话继续"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message").getByText("主对话正常回复", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "停止侧边回答", exact: true }).click(); await expect(panel.getByText("已停止", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click(); await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect.poll(() => f.disposed.length).toBe(1);
    await trigger.click(); await expect(panel.locator(".side-exchange")).toHaveCount(0);
    await input.fill("长内容"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect(panel.locator("pre")).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-long-dark.png") });
    for (const width of [1024, 820, 761]) {
      await page.setViewportSize({ width, height: 800 }); await expect(panel).toBeVisible();
      const boxes = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, window: innerWidth, panel: document.querySelector(".side-conversation")!.getBoundingClientRect().width, main: document.querySelector("main")!.getBoundingClientRect().width }));
      expect(boxes.body).toBeLessThanOrEqual(boxes.window); expect(boxes.panel).toBeGreaterThanOrEqual(280); expect(boxes.main).toBeGreaterThanOrEqual(280);
      await expect(page.locator(".sidebar")).toBeVisible();
      expect((await page.locator(".conversation-main>.conversation-header .chat-identity>span[title]").boundingBox())!.width).toBeGreaterThanOrEqual(60);
    }
    await page.screenshot({ animations: "disabled", path: info.outputPath("side-narrow-dark.png") });
    await page.setViewportSize({ width: 1440, height: 940 });
    const separator = page.getByRole("separator", { name: "调整侧边对话宽度", exact: true }); await separator.focus(); await separator.press("Home"); await expect(separator).toHaveAttribute("aria-valuenow", "320"); await separator.press("End"); await expect(separator).toHaveAttribute("aria-valuenow", (await separator.getAttribute("aria-valuemax"))!);
    await input.fill("草稿"); await input.press("Escape"); await expect(main).toBeFocused(); await expect(panel).toBeVisible();
    await page.reload(); await expect(panel).toHaveCount(0); expect(errors).toEqual([]);
    expect(await readFile(path.join(f.stateDir, "usage.json"), "utf8")).not.toContain("还有哪些风险");
    await expect(trigger).toBeVisible(); await f.offline(); await expect(trigger).toBeDisabled();
    await main.fill("/side 离线时保留这个问题"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("侧边对话需要 Bot 在线连接。", { exact: true })).toBeVisible(); await expect(main).toHaveValue("/side 离线时保留这个问题");
  } finally { await page.close(); await f.close(); }
});

test("desktop-only entry is absent on phones, groups and ADHD; slash entry stays local", async ({ browser }, info) => {
  const f = await setup(), desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    const group = await f.hub.store.createConversation("owner", ["alpha"], "单 Bot 群组", "side_group", { type: "group" });
    await pair(desktop, f.hub); await pair(phone, f.hub); await selectConversation(desktop, f.chat.title); await enterMobileChat(phone, f.chat.title);
    await expect(desktop.getByRole("button", { name: "侧边对话", exact: true })).toBeVisible(); await expect(phone.getByRole("button", { name: "侧边对话", exact: true })).toHaveCount(0);
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("/side 解释这个变化"); await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(desktop.getByRole("textbox", { name: "侧边问题", exact: true })).toHaveValue("解释这个变化"); expect(f.sideCalls).toEqual([]); expect(f.mainCalls).toEqual([]);
    await desktop.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await selectConversation(desktop, group.title); await expect(desktop.getByRole("button", { name: "侧边对话", exact: true })).toHaveCount(0);
    await selectConversation(desktop, f.chat.title);
    await desktop.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(desktop.locator(".adhd-grid")).toBeVisible(); await expect(desktop.locator(".side-trigger:visible")).toHaveCount(0); await expect(desktop.locator(".side-conversation")).toHaveCount(0);
    await desktop.screenshot({ animations: "disabled", path: info.outputPath("adhd-without-side-entry.png") });
  } finally { await desktopContext.close(); await phoneContext.close(); await f.close(); }
});

test("closing a running answer clears it and an uncertain response does not erase a newly typed question", async ({ page }) => {
  const f = await setup();
  let release: (() => void) | undefined;
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const input = page.getByRole("textbox", { name: "侧边问题", exact: true }); await input.fill("慢回答");
    // Hold the worker receipt at the real RPC boundary. This also exercises
    // WebKit when its service worker owns HTTP requests outside page routing.
    f.gates.ask = () => new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect.poll(() => f.sideCalls.length).toBe(1); await expect.poll(() => typeof release).toBe("function"); await input.fill("还没发送的新问题"); release!();
    await expect(page.getByText("正在检查边界条件…", { exact: true })).toBeVisible(); await expect(input).toHaveValue("还没发送的新问题");
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click(); await expect.poll(() => f.disposed.length).toBe(1);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click(); await expect(input).toHaveValue(""); await expect(page.locator(".side-exchange")).toHaveCount(0);
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
  } finally { release?.(); await page.close(); await f.close(); }
});

test("a fast stop received before the question still stops that side answer", async ({ page }) => {
  const f = await setup(); let release: (() => void) | undefined;
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click(); await page.getByRole("textbox", { name: "侧边问题", exact: true }).fill("慢回答");
    f.gates.beforeAsk = () => new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect.poll(() => typeof release).toBe("function");
    await page.getByRole("button", { name: "停止侧边回答", exact: true }).click(); release!();
    await expect(page.getByRole("complementary", { name: "侧边对话" }).getByText("已停止", { exact: true })).toBeVisible();
    // Cancellation may win during budget/admission checks, before the native
    // call starts. Either way the accepted exchange must end stopped once.
    expect(f.sideCalls.length).toBeLessThanOrEqual(1); expect(f.mainCalls).toEqual([]);
  } finally { release?.(); await page.close(); await f.close(); }
});

test("an unsupported engine has no entry and cannot accidentally journal a local side command", async ({ page }) => {
  const f = await setup(false);
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await expect(page.getByRole("button", { name: "侧边对话", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("/side 临时问题"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("当前视图或引擎不支持侧边对话。", { exact: true })).toBeVisible();
    expect(f.mainCalls).toEqual([]); expect(f.sideCalls).toEqual([]); expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test("closing and reopening before the open receipt arrives disposes the late handle first", async ({ page }) => {
  const f = await setup(); let release: (() => void) | undefined;
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    f.gates.open = () => new Promise<void>(resolve => { release = resolve; });
    const trigger = page.getByRole("button", { name: "侧边对话", exact: true }); await trigger.click(); await expect.poll(() => typeof release).toBe("function");
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click(); await trigger.click();
    f.gates.open = undefined; release!();
    await expect.poll(() => f.disposed.length).toBe(1);
    await page.getByRole("textbox", { name: "侧边问题", exact: true }).fill("重新打开后可用"); await expect(page.getByRole("button", { name: "发送侧边问题", exact: true })).toBeEnabled();
    await expect(page.locator(".side-inline-error")).toHaveCount(0); await expect(page.locator(".side-exchange")).toHaveCount(0);
  } finally { release?.(); await page.close(); await f.close(); }
});

test("changing the Bot engine closes its old side context and refreshes capability", async ({ page }) => {
  const f = await setup();
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const trigger = page.getByRole("button", { name: "侧边对话", exact: true }); await trigger.click();
    await expect(page.getByRole("textbox", { name: "侧边问题", exact: true })).toBeVisible();
    // The panel mounts before native preparation. This scenario must actually
    // own a context before changing engines can be expected to dispose it.
    await expect.poll(f.openedCount).toBe(1);
    await f.changeEngine("deepseek", false);
    await expect(trigger).toHaveCount(0); await expect(page.locator(".side-conversation")).toHaveCount(0);
    await expect.poll(() => f.disposed.length).toBe(1);
    await f.changeEngine("codex", true); await expect(trigger).toBeVisible(); await trigger.click();
    await expect(page.locator(".side-exchange")).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

test("a hidden side conversation can be revealed without clearing it or stealing passive return focus", async ({ page }) => {
  const f = await setup();
  try {
    await page.setViewportSize({ width: 1360, height: 900 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const trigger = page.getByRole("button", { name: "侧边对话", exact: true }), search = page.getByRole("button", { name: "搜索当前对话", exact: true });
    await trigger.click();
    const input = page.getByRole("textbox", { name: "侧边问题", exact: true });
    await input.fill("解释上下文"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(page.locator(".side-exchange .markdown")).toContainText("增量同步"); await input.fill("保留侧边草稿");
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click(); await expect(input).toBeHidden();
    await trigger.click(); await expect(input).toBeFocused(); await expect(input).toHaveValue("保留侧边草稿"); expect(f.disposed).toEqual([]);
    await search.click(); await expect(input).toBeHidden(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click(); await expect(input).toBeVisible(); await expect(input).toBeFocused(); await expect(input).toHaveValue("保留侧边草稿");
    await expect(page.locator(".side-exchange .markdown")).toContainText("增量同步"); expect(f.disposed).toEqual([]);
    await search.click(); await page.getByRole("button", { name: "关闭搜索", exact: true }).click();
    await expect(input).toBeVisible(); await expect(search).toBeFocused();
    await search.click(); await page.keyboard.press("Control+Shift+K");
    await expect(input).toBeVisible(); await expect(input).toHaveValue("保留侧边草稿"); expect(f.disposed).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test("side panel follows actual palette and compact-density preferences without persistent helper paragraphs", async ({ page }, info) => {
  const f = await setup();
  try {
    await page.setViewportSize({ width: 1440, height: 940 }); await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await f.changeEngine("claude", true); await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("textbox", { name: "侧边问题", exact: true })).toBeVisible();
    await expect(panel.getByText("侧边用量无法计入 Bot 预算，模型服务仍会计费。", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("切换对话会保留，关闭侧边即清除", { exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "侧边问题", exact: true }).fill("长内容"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click(); await expect(panel.locator("pre")).toBeVisible();
    for (const palette of ["mono", "white-orange", "cli"]) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByLabel("主题", { exact: true }).selectOption(palette === "mono" ? "light" : "dark");
      await page.locator(`input[name="color-palette"][value="${palette}"]`).check(); await page.getByRole("radio", { name: "紧凑", exact: true }).check();
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-palette", palette); await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
      await expect(panel).toBeVisible(); await expect(page.getByRole("textbox", { name: "侧边问题", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`side-${palette}-compact.png`) });
    }
  } finally { await page.close(); await f.close(); }
});

test("cancelling a side upload preserves every file and caption for one complete retry", async ({ page }) => {
  const f = await setup(); let release: (() => void) | undefined;
  const put = f.hub.attachments.putChunk.bind(f.hub.attachments);
  f.hub.attachments.putChunk = async (...args) => {
    const row = await f.hub.store.db.get<{ name: string }>("SELECT name FROM attachments WHERE id=?", [args[1]]);
    if (row?.name === "second.txt" && !release) await new Promise<void>(resolve => { release = resolve; });
    return put(...args);
  };
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await panel.locator('input[type="file"]').setInputFiles([
      { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("First file") },
      { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("Second file") },
    ]);
    await input.fill("两个文件一起分析"); await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect.poll(() => typeof release).toBe("function");
    await panel.getByRole("button", { name: "取消上传", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(input).toHaveValue("两个文件一起分析");
    await expect(panel.getByRole("region", { name: "待发送的附件" }).getByRole("listitem")).toHaveCount(2);
    expect(f.sideCalls).toEqual([]); release!();
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("已读取附件：first.txt、second.txt");
    expect(f.sideCalls).toEqual(["两个文件一起分析"]); expect(f.sideFiles[0]).toHaveLength(2);
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
  } finally { release?.(); await page.close(); await f.close(); }
});

test("workers without attachment capability keep text side questions usable", async ({ page }) => {
  const f = await setup(true, null);
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("button", { name: "添加侧边附件", exact: true })).toBeDisabled();
    await panel.getByRole("textbox", { name: "侧边问题", exact: true }).fill("旧主机纯文字问题");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("增量同步", { exact: true })).toBeVisible();
    expect(f.sideCalls).toEqual(["旧主机纯文字问题"]);
  } finally { await page.close(); await f.close(); }
});


test("native side attachment menu stays inside the viewport and opens the picker", async ({ page }, info) => {
  const f = await setup();
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    // Exercise the desktop WebView branch. OS capture itself is tested separately.
    await page.evaluate(() => Object.assign(window, { isTauri: true }));
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await panel.getByRole("button", { name: "添加侧边附件", exact: true }).click();
    const menu = page.getByRole("group", { name: "添加附件", exact: true });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await expect(menu.getByRole("button", { name: "上传附件", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "侧边问题", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "添加侧边附件", exact: true }).press("Enter");
    await expect(menu).toBeInViewport({ ratio: 1 });
    const chooser = page.waitForEvent("filechooser");
    await menu.getByRole("button", { name: "上传附件", exact: true }).click();
    await (await chooser).setFiles({ name: "native-menu.txt", mimeType: "text/plain", buffer: Buffer.from("native menu bytes") });
    await expect(panel.getByRole("textbox", { name: "侧边问题", exact: true })).toBeFocused();
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("native-menu.txt");
    await expect(page.locator(".conversation-main .attachment-draft")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("side-composer-parity.png"), animations: "disabled" });
    const field = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await panel.getByRole("button", { name: "移除 native-menu.txt", exact: true }).click();
    await expect(field).toBeFocused();
    await panel.getByRole("button", { name: "添加侧边附件", exact: true }).click();
    const cancelled = page.waitForEvent("filechooser"); await menu.getByRole("button", { name: "上传附件", exact: true }).click();
    await (await cancelled).element().dispatchEvent("cancel"); await expect(field).toBeFocused();
  } finally { await page.close(); await f.close(); }
});


test("side recording shares the microphone controls, retains finished audio only in its origin and transcribes before asking", async ({ page }, info) => {
  await microphone(page);
  const f = await setup(true, { images: false, files: "text" });
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "录音切换目标", "voice_other");
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    const mic = panel.getByRole("button", { name: "录制语音", exact: true });
    const mainMic = page.locator(".conversation-main").getByRole("button", { name: "录制语音", exact: true });
    await expect(mic).toBeEnabled(); await mic.click();
    await expect(panel.getByText("正在录音", { exact: true })).toBeVisible();
    await expect(mainMic).toBeDisabled();
    await expect(panel.getByRole("button", { name: "发送侧边问题", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 820, height: 700 });
    await expect(panel.getByRole("button", { name: "完成录音", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath("side-recording-compact.png"), animations: "disabled" });
    await page.waitForTimeout(1100); // Let the browser's actual audio encoder produce a chunk.
    await page.evaluate(() => { const recorder = (window as any).__mic.recorder as MediaRecorder, stopped = recorder.onstop!; recorder.onstop = event => { (window as any).releaseSideVoice = () => stopped.call(recorder, event); }; });
    await panel.getByRole("button", { name: "完成录音", exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).releaseSideVoice === "function");
    await selectConversation(page, other.title);
    await page.evaluate(() => (window as any).releaseSideVoice());
    await expect(page.locator(".conversation-main .attachment-draft")).toHaveCount(0);
    await selectConversation(page, f.chat.title);
    await expect(panel.locator("audio")).toBeVisible();
    await expect(mainMic).toBeEnabled();
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("已读取附件：voice-");
    expect(f.transcripts).toHaveLength(1); expect(f.sideFiles[0]?.[0]?.kind).toBe("text");
    expect(f.mainCalls).toEqual([]); expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toHaveLength(1);
    // Close invalidates a pending encoder even if the same side panel reopens.
    await mic.click(); await expect(panel.getByText("正在录音", { exact: true })).toBeVisible();
    await page.waitForTimeout(1100);
    await page.evaluate(() => { const recorder = (window as any).__mic.recorder as MediaRecorder, stopped = recorder.onstop!; delete (window as any).releaseSideVoice; recorder.onstop = event => { (window as any).releaseSideVoice = () => stopped.call(recorder, event); }; });
    await panel.getByRole("button", { name: "完成录音", exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).releaseSideVoice === "function");
    await panel.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await page.getByRole("button", { name: "侧边对话", exact: true }).click(); await expect(mic).toBeEnabled();
    await page.evaluate(() => (window as any).releaseSideVoice());
    await expect(panel.locator(".attachment-draft")).toHaveCount(0);
    // Native permission rejection is represented by the existing recorder error UI.
    await page.evaluate(() => { (window as any).__mic.mode = "deny"; }); await mic.click();
    await expect(panel.getByRole("alert")).toContainText("允许麦克风"); await expect(mainMic).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
  } finally { await page.close(); await f.close(); }
});


test("an older host rejecting tools and audio negotiation retains side attachments and text questions", async ({ browser }) => {
  // Service-worker fetches bypass page routing, particularly in WebKit.
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  const f = await setup(); let rejected = 0;
  try {
    await page.route(url => url.pathname.endsWith("/side"), route => {
      if (["tools", "audio"].some(key => new URL(route.request().url()).searchParams.has(key))) { rejected++; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unknown_parameter" }) }); }
      return route.continue();
    });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("button", { name: "添加侧边附件", exact: true })).toBeEnabled();
    await expect.poll(() => rejected).toBeGreaterThan(0);
    await panel.getByRole("textbox", { name: "侧边问题", exact: true }).fill("兼容旧主机");
    await expect(panel.getByRole("button", { name: "发送侧边问题", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "录制语音", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("增量同步"); expect(rejected).toBeGreaterThan(0);
  } finally { await context.close(); await f.close(); }
});

test("a transient capability failure retries the same negotiation instead of opening a side without tools", async ({ browser }) => {
  // Service-worker fetches bypass page routing, particularly in WebKit.
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  const f = await setup(true, { images: true, files: "any" }, { toolAccess: true }); const probes: string[] = []; let dropped = 0;
  try {
    await page.route(url => url.pathname.endsWith("/side"), route => {
      const request = route.request(); if (request.method() !== "GET") return route.continue();
      const params = new URL(request.url()).searchParams;
      // One dropped connection on the first full negotiation, as on a flaky route.
      if (params.has("tools") && !dropped) { dropped++; return route.abort("connectionreset"); }
      probes.push([...params.keys()].filter(key => key !== "botId").join("+"));
      return route.continue();
    });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("textbox", { name: "侧边问题", exact: true })).toBeVisible();
    await expect.poll(() => f.openTools).toEqual(["inherited"]);
    expect(dropped).toBe(1);
    // No probe after the failure dropped a requested opt-in.
    expect(probes.length).toBeGreaterThan(0); expect(probes.filter(probe => !probe.includes("tools") || !probe.includes("audio"))).toEqual([]);
  } finally { await context.close(); await f.close(); }
});

test("an older host rejecting only tool negotiation falls back one step and keeps side recording", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
  await microphone(page);
  const f = await setup(true, { images: true, files: "any" }, { toolAccess: true }); let rejected = 0;
  try {
    await page.route(url => url.pathname.endsWith("/side"), route => {
      const request = route.request();
      if (request.method() === "GET" && new URL(request.url()).searchParams.has("tools")) { rejected++; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unknown_parameter" }) }); }
      return route.continue();
    });
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("button", { name: "录制语音", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "添加侧边附件", exact: true })).toBeEnabled();
    await expect.poll(() => f.openTools).toEqual(["none"]);
    expect(rejected).toBeGreaterThan(0);
  } finally { await context.close(); await f.close(); }
});

test("Escape during a side recording in an empty panel keeps the recording instead of closing the panel", async ({ page }) => {
  await microphone(page);
  const f = await setup(true, { images: false, files: "text" });
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), input = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await panel.getByRole("button", { name: "录制语音", exact: true }).click();
    await expect(panel.getByText("正在录音", { exact: true })).toBeVisible();
    await page.waitForTimeout(1100); // Let the browser's actual audio encoder produce a chunk.
    // A caption field click keeps the side panel as the keyboard target.
    await input.click(); await input.press("Escape");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "完成录音", exact: true }).click();
    await expect(panel.locator(".attachment-draft audio")).toBeVisible();
    expect(f.disposed).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test("a side recording finished into a full draft is kept and the limit is reported before sending", async ({ page }) => {
  await microphone(page);
  const f = await setup(true, { images: false, files: "text" });
  try {
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), mic = panel.getByRole("button", { name: "录制语音", exact: true });
    await expect(mic).toBeEnabled();
    const chooser = page.waitForEvent("filechooser"); await panel.getByRole("button", { name: "添加侧边附件", exact: true }).click();
    await (await chooser).setFiles(Array.from({ length: 8 }, (_, i) => ({ name: `note-${i + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`note ${i + 1}`) })));
    await expect(panel.getByRole("region", { name: "待发送的附件" })).toContainText("note-8.txt");
    await mic.click(); await expect(panel.getByText("正在录音", { exact: true })).toBeVisible();
    await page.waitForTimeout(1100); // Let the browser's actual audio encoder produce a chunk.
    await panel.getByRole("button", { name: "完成录音", exact: true }).click();
    // The only copy of the speech stays in the draft; the limit is named instead of discarding it.
    await expect(panel.locator(".attachment-draft audio")).toBeVisible();
    await expect(panel.locator(".attachment-draft-file")).toHaveCount(9);
    await expect(panel.getByRole("alert")).toContainText("侧边问题最多添加 8 个附件。");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("侧边问题最多添加 8 个附件。");
    expect(f.sideCalls).toEqual([]);
    await panel.getByRole("button", { name: "移除 note-8.txt", exact: true }).click();
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("已读取附件：");
    expect(f.sideFiles.at(-1)).toHaveLength(8); expect(f.sideFiles.at(-1)?.at(-1)?.kind).toBe("text"); expect(f.transcripts).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});


test("side sends an image without approval, survives navigation and never publishes a main message", async ({ page }, info) => {
  const f = await setup(true, { images: true, files: "any" }, { toolAccess: true, delivery: true });
  try {
    const other = await f.hub.store.createConversation("owner", ["alpha"], "另一个对话", "output_other");
    const before = (await f.hub.store.snapshot("owner", f.chat.id)).messages;
    await pair(page, f.hub); await selectConversation(page, f.chat.title);
    const main = page.locator(".conversation-main").getByRole("textbox", { name: "消息", exact: true });
    await main.fill("主对话草稿保留");
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await panel.getByRole("textbox", { name: "侧边问题", exact: true }).fill("发送侧边图片");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    const picture = panel.locator(".side-output-attachments .attachment-image");
    await expect(picture).toHaveCount(1);
    await expect(panel).toContainText("侧边头像总览");
    await expect.poll(() => f.receipts.length).toBe(2);
    expect(f.receipts[0]).toEqual(f.receipts[1]);
    expect(JSON.parse((f.receipts[0] as { text: string }).text)).toMatchObject({ delivered: true, destination: "side" });
    await expect(picture.locator("img")).toHaveJSProperty("naturalWidth", 1);
    await selectConversation(page, other.title); await expect(panel).toHaveCount(0);
    await selectConversation(page, f.chat.title); await expect(picture).toBeVisible();
    await expect(main).toHaveValue("主对话草稿保留");
    await page.screenshot({ path: info.outputPath("side-delivered-image.png"), animations: "disabled" });
    await picture.locator("button").first().click();
    await expect(page.locator(".lightbox")).toBeVisible();
    await page.keyboard.press("Escape"); await expect(page.locator(".lightbox")).toHaveCount(0);
    expect((await f.hub.store.snapshot("owner", f.chat.id)).messages).toEqual(before);
    expect(f.mainCalls).toEqual([]);
    await panel.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    await expect(panel.locator(".side-output-attachments")).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});
