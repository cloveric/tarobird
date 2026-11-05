import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { sendSharedItem, sharedFile, sharedItemSchema, type SharedItem, type ShareBridge, type ShareDelivery } from "../src/share-controller.js";

const item: SharedItem = { id: "884b9026-9029-4a6b-ad36-cd40b6f9a241", createdAt: Date.now(), text: "从系统分享的内容", files: [{ name: "report.txt", type: "text/plain", size: 5 }] };
const delivery: ShareDelivery = { hubKey: "trusted-hub", deviceId: "device_one", conversationId: "conv_one", text: item.text };
type ShareWindow = { shareCalls: unknown[]; sharePrepares: unknown[]; shareFixture: { hold(): void; held(): boolean; release(): void; add(text: string): void; restore(): void } };
function fixture() {
  let current = structuredClone(item); let removed = 0; let removalFails = false;
  const native: ShareBridge = {
    list: async () => ({ items: [current] }),
    prepare: async ({ delivery }) => { current.delivery ??= delivery; return structuredClone(current); },
    readChunk: async ({ offset, length }) => ({ data: btoa("hello".slice(offset, offset + length)) }),
    remove: async () => { if (removalFails) throw new Error("disk_busy"); removed++; }, setMaxFileBytes: async () => undefined, clear: async () => undefined,
  };
  return { native, current: () => current, removed: () => removed, failRemoval: (value: boolean) => { removalFails = value; } };
}
test("system shares persist their recipient before upload and retain the draft after failures", async () => {
  const f = fixture(); let sends = 0;
  await expect(sendSharedItem(f.native, item, delivery, async () => { expect(f.current().delivery).toEqual(delivery); throw new Error("offline"); }, async () => { sends++; })).rejects.toThrow("offline");
  expect(f.removed()).toBe(0); expect(sends).toBe(0);
  await expect(sendSharedItem(f.native, item, { ...delivery, conversationId: "conv_other" }, async () => "unused", async () => undefined)).rejects.toThrow("destination_changed");
  await expect(sendSharedItem(f.native, item, { ...delivery, deviceId: "device_other" }, async () => "unused", async () => undefined)).rejects.toThrow("destination_changed");
  await sendSharedItem(f.native, item, delivery, async (file) => { expect(await (await file.readChunk(0, 5)).text()).toBe("hello"); return "attachment_one"; }, async (frame) => { expect(frame).toMatchObject({ clientMsgId: `share_${item.id}`, conversationId: "conv_one", text: item.text, attachments: ["attachment_one"] }); sends++; });
  expect(sends).toBe(1); expect(f.removed()).toBe(1);
});
test("a lost cleanup receipt retries the same idempotency key after reload", async () => {
  const f = fixture(); const frames: unknown[] = []; f.failRemoval(true);
  const upload = async () => "attachment_one", send = async (frame: unknown) => { frames.push(frame); };
  await expect(sendSharedItem(f.native, item, delivery, upload, send)).rejects.toThrow("disk_busy");
  f.failRemoval(false); const restored = sharedItemSchema.parse((await f.native.list()).items[0]);
  await sendSharedItem(f.native, restored, restored.delivery!, upload, send);
  expect(frames).toHaveLength(2); expect(frames[0]).toEqual(frames[1]); expect(f.removed()).toBe(1);
});
test("group shares pin reply Bots by value; a retry can neither add, drop nor reorder them", async () => {
  const f = fixture(); const frames: unknown[] = []; const send = async (frame: unknown) => { frames.push(frame); };
  const topic: ShareDelivery = { ...delivery, conversationId: "topic_one", mentions: ["bot_alpha", "bot_beta"] };
  await expect(sendSharedItem(f.native, item, topic, async () => { throw new Error("offline"); }, send)).rejects.toThrow("offline");
  expect(f.current().delivery).toEqual(topic);
  for (const changed of [{ ...topic, mentions: ["bot_beta", "bot_alpha"] }, { ...topic, mentions: ["bot_alpha"] }, { ...delivery, conversationId: "topic_one" }]) await expect(sendSharedItem(f.native, item, changed, async () => "unused", send)).rejects.toThrow("destination_changed");
  // prepare returns structured clones: equal mentions are distinct arrays and must still match.
  const restored = sharedItemSchema.parse((await f.native.list()).items[0]);
  await sendSharedItem(f.native, restored, restored.delivery!, async () => "attachment_one", send);
  expect(frames).toEqual([{ v: 1, type: "message.send", clientMsgId: `share_${item.id}`, conversationId: "topic_one", text: item.text, attachments: ["attachment_one"], mentions: ["bot_alpha", "bot_beta"] }]);
  expect(f.removed()).toBe(1);
});
test("legacy pins without mentions retry unchanged and never gain mentions", async () => {
  const f = fixture(); const frames: unknown[] = []; const send = async (frame: unknown) => { frames.push(frame); };
  f.current().delivery = structuredClone(delivery); const legacy = sharedItemSchema.parse((await f.native.list()).items[0]);
  await expect(sendSharedItem(f.native, legacy, { ...delivery, mentions: ["bot_alpha"] }, async () => "unused", send)).rejects.toThrow("destination_changed");
  expect(f.current().delivery).toEqual(delivery); expect(frames).toEqual([]);
  await sendSharedItem(f.native, legacy, legacy.delivery!, async () => "attachment_one", send);
  expect(frames).toEqual([{ v: 1, type: "message.send", clientMsgId: `share_${item.id}`, conversationId: "conv_one", text: item.text, attachments: ["attachment_one"] }]);
  expect(frames[0]).not.toHaveProperty("mentions");
});
test("file reads are bounded and detect truncation, over-sized responses and invalid ranges", async () => {
  const f = fixture(); const large = { ...item, files: [{ ...item.files[0]!, size: 3 * 1024 * 1024 + 15 }] }; const lengths: number[] = [];
  f.native.readChunk = async ({ length }) => { lengths.push(length); return { data: Buffer.alloc(length, 65).toString("base64") }; };
  const source = sharedFile(f.native, large, 0); expect((await source.readChunk(0, large.files[0]!.size)).size).toBe(large.files[0]!.size); expect(lengths).toEqual([1048576,1048576,1048576,15]);
  await expect(source.readChunk(-1, 3)).rejects.toThrow("invalid");
  await expect(source.readChunk(0, large.files[0]!.size + 1)).rejects.toThrow("invalid");
  f.native.readChunk = async () => ({ data: btoa("x") }); await expect(source.readChunk(0, 5)).rejects.toThrow("file_changed");
  f.native.readChunk = async () => ({ data: "A".repeat(100) }); await expect(source.readChunk(0, 5)).rejects.toThrow("invalid");
});

test("share review requires an explicit recipient and send, preserving the pinned draft after failure", async ({ page }, info) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/share.html");
    await page.getByRole("button", { name: "待发送分享 (1)", exact: true }).click();
    await expect(page.getByRole("button", { name: "发送分享", exact: true })).toBeDisabled();
    await page.getByLabel("分享目标会话").selectOption("conv_one"); await page.getByLabel("分享内容", { exact: true }).fill("确认后的内容 <script>不应执行</script>");
    expect(await page.evaluate(() => (window as unknown as {shareCalls: unknown[]}).shareCalls)).toEqual([]);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(page.getByRole("dialog", { name: "收到的分享" })).toBeHidden();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(false);
    await page.getByRole("button", { name: "待发送分享 (1)", exact: true }).click();
    await expect(page.getByLabel("分享目标会话")).toHaveValue("conv_one");
    await expect(page.getByLabel("分享内容", { exact: true })).toHaveValue("确认后的内容 <script>不应执行</script>");
    await page.getByRole("button", { name: "发送分享", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("fixture_offline");
    await expect(page.getByLabel("分享目标会话")).toBeDisabled(); await expect(page.getByLabel("分享内容", { exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("share-retry-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "关闭", exact: true }).click(); await page.getByRole("button", { name: "待发送分享 (1)", exact: true }).click();
    await expect(page.getByLabel("分享内容", { exact: true })).toHaveValue("确认后的内容 <script>不应执行</script>");
    await page.getByRole("button", { name: "发送分享", exact: true }).click(); await expect(page.getByRole("dialog", { name: "收到的分享" })).toHaveCount(0);
    const calls = await page.evaluate(() => (window as unknown as {shareCalls: unknown[]}).shareCalls); expect(calls).toEqual([{ v: 1, type: "message.send", clientMsgId: `share_${item.id}`, conversationId: "conv_one", text: "确认后的内容 <script>不应执行</script>", attachments: [] }]);
  } finally { await server.close(); }
});
async function withShareFixture(page: Page, query: string, run: () => Promise<void>) {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  try { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/share.html" + query); await run(); } finally { await server.close(); }
}
const recorded = (page: Page) => page.evaluate(() => { const w = window as unknown as ShareWindow; return { prepares: w.sharePrepares, calls: w.shareCalls }; });

test("group and topic shares hide archived targets, require an explicit reply Bot and retry the pinned target and Bots", async ({ page }) => {
  await withShareFixture(page, "", async () => {
    await page.getByRole("button", { name: "待发送分享 (1)", exact: true }).click();
    const target = page.getByLabel("分享目标会话"), bots = page.getByRole("group", { name: "回复的 Bot" }), send = page.getByRole("button", { name: "发送分享", exact: true });
    await expect(target.locator("option")).toHaveText(["选择会话", "工作助手", "研发群", "研发群 / 发布"]);
    await target.selectOption("topic_open");
    await expect(page.getByText("请先选择回复的 Bot。")).toBeVisible(); await expect(send).toBeDisabled();
    await bots.getByRole("checkbox", { name: "Alpha" }).click(); await bots.getByRole("checkbox", { name: "Beta" }).click(); await bots.getByRole("checkbox", { name: "Alpha" }).click();
    await send.click(); await expect(page.getByRole("alert")).toContainText("fixture_offline");
    await expect(target).toBeDisabled(); await expect(target).toHaveValue("topic_open");
    await expect(bots.getByRole("checkbox", { name: "Beta" })).toBeChecked(); await expect(bots.getByRole("checkbox", { name: "Alpha" })).not.toBeChecked();
    for (const name of ["Alpha", "Beta"]) await expect(bots.getByRole("checkbox", { name })).toBeDisabled();
    await send.click(); await expect(page.getByRole("dialog", { name: "收到的分享" })).toHaveCount(0);
    const pin = { hubKey: "trusted-hub", deviceId: "device_one", conversationId: "topic_open", text: "来自系统分享的草稿", mentions: ["bot_beta"] };
    expect(await recorded(page)).toEqual({ prepares: [pin, pin], calls: [{ v: 1, type: "message.send", clientMsgId: `share_${item.id}`, conversationId: "topic_open", text: "来自系统分享的草稿", attachments: [], mentions: ["bot_beta"] }] });
  });
});
test("failed shares pinned to an archived chat or a topic of an archived group stay on device and never upload or enqueue", async ({ page }) => {
  await withShareFixture(page, "?scenario=archived", async () => {
    const pending = page.getByRole("button", { name: "待发送分享 (2)", exact: true }); await pending.click();
    const chat = page.locator("article.share-draft").nth(0), topic = page.locator("article.share-draft").nth(1);
    await expect(chat.getByLabel("分享目标会话").locator("option:checked")).toHaveText("旧助手 · 已归档");
    await expect(chat.getByRole("alert")).toHaveText("已归档，历史记录仍可查看。恢复后可继续讨论。");
    await expect(topic.getByLabel("分享目标会话").locator("option:checked")).toHaveText("旧群 / 复盘 · 已归档");
    await expect(topic.getByRole("alert")).toHaveText("这个群组已归档，请先恢复群组。");
    await expect(topic.getByRole("checkbox", { name: "Beta" })).toBeChecked(); await expect(topic.getByRole("checkbox", { name: "Beta" })).toBeDisabled();
    for (const draft of [chat, topic]) await expect(draft.getByRole("button", { name: "发送分享", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "关闭", exact: true }).click(); await expect(pending).toBeVisible();
    expect(await recorded(page)).toEqual({ prepares: [], calls: [] });
    // Restoring reopens the locked retry: the same topic and reply Bot, nothing re-chosen.
    await page.evaluate(() => (window as unknown as ShareWindow).shareFixture.restore()); await pending.click();
    await expect(chat.getByRole("button", { name: "发送分享", exact: true })).toBeEnabled();
    await topic.getByRole("button", { name: "发送分享", exact: true }).click();
    await expect(page.getByRole("button", { name: "待发送分享 (1)", exact: true })).toBeVisible();
    expect((await recorded(page)).calls).toEqual([{ v: 1, type: "message.send", clientMsgId: "share_5b3f0f86-7c1e-4f53-9d43-2f4c1e0a9b11", conversationId: "topic_closed", text: "话题分享", attachments: [], mentions: ["bot_beta"] }]);
  });
});
test("a slow older inbox read cannot resurrect a discarded share, and polling still applies newer reads", async ({ page }) => {
  await withShareFixture(page, "", async () => {
    const pending = page.getByRole("button", { name: "待发送分享 (1)", exact: true }); await expect(pending).toBeVisible();
    // Hidden pages skip the 2.5 s poll, so only the reads below race until visibility returns.
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); (window as unknown as ShareWindow).shareFixture.hold(); window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => (window as unknown as ShareWindow).shareFixture.held());
    await pending.click(); await page.getByRole("button", { name: "丢弃分享", exact: true }).click(); await expect(pending).toHaveCount(0);
    await page.evaluate(async () => { (window as unknown as ShareWindow).shareFixture.release(); await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    await expect(page.locator(".share-inbox-button")).toHaveCount(0);
    await page.evaluate(() => { delete (document as unknown as { visibilityState?: string }).visibilityState; (window as unknown as ShareWindow).shareFixture.add("轮询发现的新分享"); });
    await expect(pending).toBeVisible();
  });
});


test("a share pinned to another registered host offers switching and preserves the original delivery", async ({ page }) => {
  await withShareFixture(page, "?scenario=foreign", async () => {
    await page.getByRole("button", { name: "待发送分享 (1)", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "收到的分享", exact: true });
    await expect(dialog).toContainText("这条分享已指定发送到 Mac mini。内容和附件仍然保留。");
    await expect(dialog.getByRole("button", { name: "丢弃分享", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "发送分享", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "切换到 Mac mini", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { switchedShare?: string }).switchedShare)).toBe("conv_one");
    expect(await page.evaluate(() => (window as unknown as { shareFixture: { pending(): SharedItem[] } }).shareFixture.pending())).toMatchObject([{ delivery: { hubKey: "other-host", deviceId: "device_two", conversationId: "conv_one" } }]);
    expect(await recorded(page)).toEqual({ prepares: [], calls: [] });
  });
});

test("share review traps focus, ignores IME Escape, and restores its trigger without losing the draft", async ({ page }) => {
  await withShareFixture(page, "", async () => {
    const trigger = page.getByRole("button", { name: "待发送分享 (1)", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "收到的分享", exact: true });
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "丢弃分享", exact: true })).toBeFocused();
    const text = dialog.getByLabel("分享内容", { exact: true }); await text.fill("keep my draft");
    await text.dispatchEvent("keydown", { key: "Escape", isComposing: true }); await expect(dialog).toBeVisible();
    await text.dispatchEvent("keydown", { key: "Escape", keyCode: 229 }); await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    await trigger.click(); await expect(text).toHaveValue("keep my draft");
  });
});
