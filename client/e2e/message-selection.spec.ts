import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-selection-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','选择测试助手','fixture')");
  const chat = await hub.store.createConversation("owner", ["alpha"], "气泡选区", "selection");
  const { message: user } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "question", text: "只选择这条气泡里的全部文字。\n\n第二段包含 **重点文字**，也应该被选中。", attachments: [] });
  const reply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [
    { type: "card", title: "本条回复", elements: [{ type: "markdown", text: "回复第一段。\n\n回复第二段。" }] },
    { type: "card", title: "另一张卡片", elements: [{ type: "markdown", text: "不要连带选择这张卡片。" }] },
  ] });
  const now = Date.now();
  const run = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", extra: { nativeRun: { version: 1, id: "selection_run", revision: 1, phase: "done", startedAt: now, updatedAt: now, endedAt: now, count: 0, completed: 0, failed: 0, truncated: false } }, elements: [{ type: "markdown", text: "已完成" }, { type: "markdown", id: "answer", text: "运行回复的第一段。\n\n运行回复的第二段。" }] }] });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
  return { hub, chat, user: page.locator(`[data-message-id="${user.id}"]`), reply: page.locator(`[data-message-id="${reply.id}"]`), run: page.locator(`[data-message-id="${run.id}"]`), close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

async function selectedWithin(surface: Locator) {
  return surface.evaluate(element => {
    const selection = document.getSelection();
    return { text: selection?.toString().trim(), inside: !!selection?.rangeCount && element.contains(selection.anchorNode) && element.contains(selection.focusNode) };
  });
}

test("double-click selects the entire user bubble, without the next reply or composer", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const bubble = f.user.locator(".message-blocks");
    await expect(bubble.locator("p")).toHaveCount(2);
    const expected = (await bubble.innerText()).trim();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("输入框里的草稿不能被选中");
    await bubble.locator("p").first().dblclick();
    await expect.poll(() => selectedWithin(bubble)).toEqual({ text: expected, inside: true });
    await page.screenshot({ path: info.outputPath("user-bubble-selected.png") });
    // A background update must not move selection to the newly rendered reply.
    await f.hub.store.publishBotMessage("alpha", { conversationId: f.chat.id, blocks: [{ type: "text", text: "这是刚到的新回复。" }] });
    await expect(page.getByText("这是刚到的新回复。", { exact: true })).toBeVisible();
    await expect.poll(() => selectedWithin(bubble)).toEqual({ text: expected, inside: true });
    const selected = await page.evaluate(() => document.getSelection()!.toString());
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedSelection = text; } } }));
    await bubble.locator("p").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制所选文本", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedSelection)).toBe(selected);
  } finally { await f.close(); }
});

test("reply cards and native answers each own their text selection", async ({ page }) => {
  const f = await fixture(page);
  try {
    const card = f.reply.locator(".rich-card").first();
    await card.locator("p").first().dblclick();
    // innerText and Selection serialize block-boundary newlines differently.
    await expect.poll(async () => { const selected = await selectedWithin(card); return { ...selected, text: selected.text?.replace(/\s+/g, " ") }; }).toEqual({ text: (await card.innerText()).trim().replace(/\s+/g, " "), inside: true });
    const answer = f.run.locator(".native-run-prose");
    await answer.locator("p").first().dblclick();
    await expect.poll(() => selectedWithin(answer)).toEqual({ text: (await answer.innerText()).trim(), inside: true });
    expect((await selectedWithin(answer)).text).not.toMatch(/已完成|查看运行过程|本轮改动/);
  } finally { await f.close(); }
});

test("code, editable cards and ordinary drag selection keep their native behavior", async ({ page }) => {
  const f = await fixture(page);
  try {
    const message = await f.hub.store.publishBotMessage("alpha", { conversationId: f.chat.id, blocks: [{ type: "card", elements: [
      { type: "markdown", text: "Outside prose stays outside.\n\n```text\nalpha beta gamma\n```" },
      { type: "input", actionId: "note", text: "备注" },
    ] }] });
    const card = page.locator(`[data-message-id="${message.id}"] .rich-card`);
    await expect(card.locator("code")).toHaveText("alpha beta gamma\n");
    await card.locator("code").dblclick({ position: { x: 8, y: 8 } });
    const code = await selectedWithin(card.locator("code")); expect(code.inside).toBe(true); expect(code.text).toBe("alpha");
    const field = card.getByRole("textbox", { name: "备注", exact: true });
    await field.fill("delta epsilon zeta"); await field.dblclick({ position: { x: 16, y: 16 } });
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe("delta");
    const paragraph = card.locator("p").first(), bounds = (await paragraph.boundingBox())!;
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + 58, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up();
    const dragged = await selectedWithin(paragraph); expect(dragged.inside).toBe(true); expect(dragged.text?.length).toBeGreaterThan(0); expect(dragged.text?.length).toBeLessThan((await paragraph.innerText()).length);
  } finally { await f.close(); }
});

test("double-clicking an expanded table cannot select its parent chat bubble through the portal", async ({ page }) => {
  const f = await fixture(page);
  try {
    const table = "| Column | Value |\n|---|---|\n" + Array.from({ length: 20 }, (_, index) => `| row${index} | alpha beta gamma |`).join("\n");
    const message = await f.hub.store.publishBotMessage("alpha", { conversationId: f.chat.id, blocks: [{ type: "text", text: `Outside the table.\n\n${table}` }] });
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await row.getByRole("button", { name: "展开表格", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "表格", exact: true });
    const cell = dialog.locator("td").nth(1);
    const point = await cell.locator(".markdown-table-cell").evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const rect = range.getBoundingClientRect(); return { x: rect.x + 8, y: rect.y + rect.height / 2 };
    });
    await page.mouse.dblclick(point.x, point.y);
    const selected = await selectedWithin(dialog);
    expect(selected.inside).toBe(true); expect(selected.text).toMatch(/^(alpha|beta|gamma)$/);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await row.locator(".card-text p").first().dblclick();
    const selection = await selectedWithin(row.locator(".rich-card"));
    expect(selection.inside).toBe(true); expect(selection.text).toContain("row19");
  } finally { await f.close(); }
});

test("dragging over a message toolbar copies only the bubble text", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const bubble = f.user.locator(".message-blocks"), prose = bubble.locator("p");
    await expect(prose).toHaveCount(2);
    const expected = (await bubble.innerText()).trim();
    const end = await prose.last().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const rect = range.getBoundingClientRect(); return { x: rect.right + 1, y: rect.y + rect.height / 2 };
    });
    const toolbar = (await f.user.locator(".message-actions").boundingBox())!;
    await page.mouse.move(end.x, end.y); await page.mouse.down();
    await page.mouse.move(toolbar.x + 1, toolbar.y + toolbar.height / 2, { steps: 20 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toBe(expected);
    await page.screenshot({ path: info.outputPath("drag-over-toolbar.png") });
    // Exercise the browser's real clipboard serialization and App paste path.
    await page.keyboard.press("ControlOrMeta+C");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V");
    await expect(composer).toHaveValue(expected);
    // The labels remain actual operable buttons.
    await f.user.getByRole("button", { name: "引用回复", exact: true }).click();
    await expect(page.locator(".reply-preview")).toBeVisible();
    await expect(composer).toHaveValue(expected);
  } finally { await f.close(); }
});

test("selected-text copy omits code and table controls while retaining rich message content", async ({ page, context, browserName }) => {
  // Headless Chromium prompts for async Clipboard API writes by default.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await fixture(page);
  try {
    const table = "| 项目 | 值 |\n|---|---|\n" + Array.from({ length: 14 }, (_, index) => `| 条目${index} | value${index} |`).join("\n");
    const message = await f.hub.store.publishBotMessage("alpha", { conversationId: f.chat.id, blocks: [{ type: "text", text: `正文开头。正文中的“复制”和“停止”也要保留。\n\n\`\`\`js\nconst answer = 42;\n  keepIndent();\n\`\`\`\n\n${table}\n\n[来源链接](https://example.com)\n\n正文结尾。` }] });
    const row = page.locator(`[data-message-id="${message.id}"]`), card = row.locator(".rich-card");
    await expect(card.getByRole("button", { name: "展开表格", exact: true })).toBeVisible();
    await card.locator("p").first().dblclick();
    const selected = (await selectedWithin(card)).text!;
    expect(selected).not.toMatch(/^(复制|已复制|展开表格|左右滑动查看|js)$/m);
    for (const text of ["正文中的“复制”和“停止”也要保留。", "const answer = 42;\n  keepIndent();", "条目13", "value13", "来源链接", "正文结尾。"]) expect(selected).toContain(text);
    await card.locator("p").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制所选文本", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V");
    await expect.poll(async () => (await composer.inputValue()).trim()).toBe(selected);
  } finally { await f.close(); }
});

test("a multi-message selection omits author metadata and run controls, but keeps answer text", async ({ page }) => {
  const f = await fixture(page);
  try {
    const messages = (await f.hub.store.snapshot("owner", f.chat.id)).messages;
    const runId = await f.run.getAttribute("data-message-id");
    const run = messages.find(message => message.id === runId)!;
    const block = run.blocks[0];
    if (block.type !== "card") throw new Error("Expected a run card fixture");
    const nativeRun = block.extra?.nativeRun;
    if (!nativeRun || typeof nativeRun !== "object" || Array.isArray(nativeRun)) throw new Error("Expected native run metadata");
    await f.hub.store.publishBotMessage("alpha", { id: run.id, conversationId: f.chat.id, replyTo: messages[0]!.id, blocks: [{ ...block, extra: { ...block.extra, nativeRun: { ...nativeRun, phase: "stopped" } } }] });
    await expect(f.user.locator("[data-reply-state=stopped]")).toBeVisible();
    await expect(f.run.locator(".native-run-prose p")).toHaveCount(2);
    await f.user.locator("p").first().click();
    await page.evaluate(() => {
      const rows = document.querySelectorAll("article[data-message-id]");
      const range = document.createRange(); range.setStartBefore(rows[0]!); range.setEndAfter(rows[rows.length - 1]!);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    const text = await page.evaluate(() => getSelection()!.toString());
    expect(text).not.toMatch(/选择测试助手|引用|转发|\d+:\d+|已完成|已停止|查看运行过程|本轮改动/);
    for (const content of ["只选择这条气泡里的全部文字。", "回复第二段。", "运行回复的第二段。"]) expect(text).toContain(content);
    await page.keyboard.press("ControlOrMeta+C");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V");
    // WebKit omits the trailing block separator when serializing the clipboard.
    await expect.poll(async () => (await composer.inputValue()).trim()).toBe(text.trim());
  } finally { await f.close(); }
});

async function listReply(page: Page, f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const message = await f.hub.store.publishBotMessage("alpha", { conversationId: f.chat.id, blocks: [{ type: "text", text }] });
  const card = page.locator(`[data-message-id="${message.id}"] .rich-card`);
  await expect(card.locator("li").first()).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  return card;
}
async function copySelection(page: Page) {
  await page.evaluate(() => {
    (window as any).listCopy = undefined;
    document.addEventListener("copy", event => { (window as any).listCopy = { text: event.clipboardData?.getData("text/plain"), html: event.clipboardData?.getData("text/html"), handled: event.defaultPrevented }; }, { once: true });
  });
  await page.keyboard.press("ControlOrMeta+C");
  return page.evaluate(() => (window as any).listCopy as { text: string; html: string; handled: boolean });
}
async function selectItems(items: Locator, first: number, last: number) {
  await items.evaluateAll((nodes, { first, last }) => {
    const range = document.createRange(); range.setStart(nodes[first]!, 0); range.setEnd(nodes[last]!, nodes[last]!.childNodes.length);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  }, { first, last });
}

test("complete selected list items keep original numbers in keyboard, rich paste and context-menu copying", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "1. 第一项\n2. 第二项\n3. 第三项 **重点**\n4. 第四项 [来源](https://example.com)");
    const items = card.locator("li"); await expect(items).toHaveCount(4);
    await selectItems(items, 2, 3);
    const value = await copySelection(page);
    expect(value.handled).toBe(true); expect(value.text).toBe("3. 第三项 重点\n4. 第四项 来源");
    expect(value.html).toContain('<ol start="3">'); expect(value.html).toContain('<li value="4">');
    expect(value.html).toContain("<strong>重点</strong>"); expect(value.html).toContain('href="https://example.com"');
    expect(value.html).not.toMatch(/message-actions|复制|转发|button|data-message-id/);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue(value.text);
    // Exercise a real rich clipboard consumer without changing the product UI.
    await page.evaluate(() => { const editor = document.createElement("div"); editor.id = "rich-copy-target"; editor.contentEditable = "true"; document.body.append(editor); editor.focus(); });
    await page.keyboard.press("ControlOrMeta+V");
    const editor = page.locator("#rich-copy-target"); await expect(editor.locator("ol")).toHaveAttribute("start", "3");
    await expect(editor).toContainText("第三项 重点"); await expect(editor.locator("strong,b")).toContainText("重点");
    await editor.evaluate(el => el.remove());
    await selectItems(items, 2, 3);
    await items.nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制所选文本", exact: true }).click();
    await composer.fill(""); await composer.click(); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue(value.text);
    // Copy-message still returns the original Markdown, not this projection.
    await page.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async text => { await write(text); (window as any).rawCopyCompleted = text; };
    });
    await card.click({ button: "right" }); await page.getByRole("menuitem", { name: "复制消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).rawCopyCompleted)).toContain("**重点**");
    await composer.fill(""); await page.keyboard.press("ControlOrMeta+V");
    await expect.poll(() => composer.inputValue()).toContain("**重点**");
  } finally { await f.close(); }
});

test("partial list selections do not invent numbers; complete middle items do", async ({ page }) => {
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "3. alpha beta\n4. middle **whole**\n5. gamma delta");
    const items = card.locator("li"); await expect(items).toHaveCount(3);
    await items.first().evaluate(el => {
      const text = el.firstChild!, range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 5);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(range);
    });
    const partial = await copySelection(page); expect(partial.handled).toBe(false);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue("pha");
    await items.evaluateAll(nodes => {
      const range = document.createRange(); range.setStart(nodes[0]!.firstChild!, 6); range.setEnd(nodes[2]!.firstChild!, 5);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(range);
    });
    const mixed = await copySelection(page); expect(mixed.text).toBe("beta\n4. middle whole\ngamma");
    expect(mixed.html).toContain('<ol start="4">'); expect(mixed.html.match(/<li /g)).toHaveLength(1);
    await composer.fill(""); await composer.click(); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue(mixed.text);
  } finally { await f.close(); }
});

test("nested lists retain paragraphs, code indentation and numbering without UI controls", async ({ page }) => {
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "前言\n\n7. 外层第一段\n\n   第二段\n\n   - 子项甲\n   - 子项乙\n\n8. 后一项\n\n   ```text\n   first\n     indented\n   ```\n\n结尾");
    await card.locator("p").first().dblclick();
    const value = await copySelection(page);
    expect(value.text).toContain("7. 外层第一段\n   \n   第二段\n   • 子项甲\n   • 子项乙");
    expect(value.text).toContain("8. 后一项\n   \n   first\n     indented");
    expect(value.text).toMatch(/^前言/); expect(value.text).toMatch(/结尾$/);
    expect(value.text).not.toMatch(/复制|已复制|\btext\b/);
    expect(value.html).toContain('<ol start="7">'); expect(value.html).toContain("<ul>"); expect(value.html).not.toMatch(/<button|<svg|class=/);
  } finally { await f.close(); }
});

test("phone Select text keeps its original numbered text and native editing clipboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "3. 手机第三项\n4. 手机第四项");
    const row = card.locator("xpath=ancestor::article");
    await row.focus(); await page.keyboard.press("Enter");
    const actions = page.getByRole("dialog", { name: "消息操作", exact: true });
    await actions.getByRole("button", { name: "选择文本", exact: true }).click();
    const text = actions.getByRole("textbox", { name: "可选择的消息文本", exact: true });
    await expect(text).toHaveValue("3. 手机第三项\n4. 手机第四项");
    await text.selectText(); expect((await copySelection(page)).handled).toBe(false);
    await page.keyboard.press("Escape");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue("3. 手机第三项\n4. 手机第四项");
    await composer.fill("编辑中的 1. 普通文字"); await composer.selectText();
    expect((await copySelection(page)).handled).toBe(false);
    await composer.fill(""); await page.keyboard.press("ControlOrMeta+V"); await expect(composer).toHaveValue("编辑中的 1. 普通文字");
  } finally { await f.close(); }
});

test("list copies preserve table rows, formula text once, task state and cross-message content", async ({ page }) => {
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "3. 表格项\n\n   | 名称 | 值 |\n   |---|---|\n   | 甲 | 10 |\n\n4. 公式 $x = 1$\n\n- [x] 已处理\n- [ ] 未处理");
    await expect(card.locator(".katex")).toHaveCount(1);
    await card.locator("li").first().dblclick();
    const value = await copySelection(page);
    expect(value.text).toContain("名称\t值\n   甲\t10");
    expect(value.text.match(/x = 1/g)).toHaveLength(1); expect(value.text).toContain("4. 公式 x = 1");
    expect(value.text).toMatch(/• \[x\] +已处理/); expect(value.text).toMatch(/• \[ \] +未处理/);
    expect(value.html).not.toMatch(/<input|<annotation|<button|<svg/);
    const second = await listReply(page, f, "8. 下一条消息");
    const firstId = await card.locator("xpath=ancestor::article").getAttribute("data-message-id");
    await second.evaluate((element, id) => {
      const first = document.querySelector(`[data-message-id="${id}"] .rich-card`)!;
      const range = document.createRange(); range.setStartBefore(first); range.setEndAfter(element);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(range);
    }, firstId);
    const multiple = await copySelection(page);
    expect(multiple.text).toContain("3. 表格项"); expect(multiple.text).toContain("8. 下一条消息");
    expect(multiple.text).not.toMatch(/选择测试助手|引用|转发|\d\d:\d\d/);
  } finally { await f.close(); }
});

test("selection copies honor original counter resets and fall back to text if rich clipboard is unavailable", async ({ page }) => {
  const f = await fixture(page);
  try {
    const card = await listReply(page, f, "1. first\n2. second\n3. third");
    // Exercise browser list semantics that may also occur in historical cards.
    await card.locator("ol").evaluate((list: HTMLOListElement) => { list.start = 10; list.reversed = true; (list.children[1] as HTMLLIElement).value = 7; });
    const items = card.locator("li"); await selectItems(items, 0, 2);
    const value = await copySelection(page); expect(value.text).toBe("10. first\n7. second\n6. third");
    expect(value.html).toContain('<ol start="10" reversed="">');
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        write: async () => { throw new Error("Rich clipboard unavailable"); },
        writeText: async (text: string) => { (window as any).fallbackCopy = text; },
      } });
    });
    await selectItems(items, 0, 2); await items.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制所选文本", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).fallbackCopy)).toBe(value.text);
  } finally { await f.close(); }
});
