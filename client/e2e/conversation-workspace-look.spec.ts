// What a person saw wrong in the workspace rail on 2026-11-22, one test per thing. The states the real Host
// cannot be driven into quickly are given as a replaced /bot-comms, /tasks or /queue answer.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { closeHub, comms, item, LONG_BOT, LONG_TITLE_ZH, makeHub, mockComms, newPage, openConv, pair, setTheme, tr, type Fixture, type Locale } from "./fixtures/workspace-rail.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const rail = (page: Page) => page.locator("aside.conversation-workspace-rail");
async function ready(browser: Parameters<typeof newPage>[0], locale: Locale, width: number, before?: (page: Page, f: Fixture) => Promise<void>) {
  const f = await makeHub(locale), L = tr(locale);
  const { context, page, errors } = await newPage(browser, locale, { width, height: 900 });
  await before?.(page, f);
  await pair(page, f, locale);
  await openConv(page, f.mainTitle);
  const trigger = page.getByRole("button", { name: L("会话工作区"), exact: true });
  const open = async () => { if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click(); await expect(rail(page)).toBeVisible(); };
  const done = async () => { expect(errors).toEqual([]); await context.close(); await closeHub(f); };
  return { f, L, context, page, trigger, open, done };
}
/** WCAG contrast of an element's text against its own background. */
const contrast = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (color: string) => { const [r, g, b] = color.match(/[\d.]+/g)!.map(Number); return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!); };
  const style = getComputedStyle(node), a = luminance(style.color), b = luminance(style.backgroundColor);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

test("the conversation title keeps its room just above 1100px while the rail is open", async ({ browser }) => {
  const { page, trigger, open, done } = await ready(browser, "en", 1101);
  try {
    await open();
    const title = page.locator(".host-workspace:not([hidden]) .conversation-header .chat-identity>span[title]");
    // "Wo…" was 39px here; the whole title is 239px.
    expect((await title.boundingBox())!.width).toBeGreaterThan(100);
    await expect(trigger.locator(".workspace-rail-trigger-label")).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(trigger.locator(".workspace-rail-trigger-label")).toBeVisible();
    expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  } finally { await done(); }
});

test("Bot messages: both ends of a long route, whole cards to a page, plain status words, readable approval in the dark theme", async ({ browser }) => {
  const { page, L, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.main, comms(f.ids.main, [
      item(1, { status: "needs_approval", sourceBotName: LONG_BOT, targetBotName: "Reviewer-Security-Auditor-与合规审查-Bot", canJumpToTarget: true, targetConversationId: f.ids.revConv,
        pendingApproval: { messageId: "msg_pending_1", title: "请求执行命令审批", detail: "psql -h db.example -f migrate.sql" } }),
      item(2, { status: "running", delivery: "queued" }), item(3, { status: "steered", delivery: "steered", replyExcerpt: undefined }),
      item(4, { status: "queued", delivery: "fell_back_to_queue", replyExcerpt: undefined }), item(5, { status: "failed", delivery: "not_delivered", replyExcerpt: "错误：目标 Bot 离线。" }),
      item(6, { status: "cancelled", replyExcerpt: undefined }), item(7, { status: "uncertain", delivery: "steer_uncertain", replyExcerpt: undefined }),
      item(8), item(9), item(10),
    ]));
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    const cards = rail(page).locator(".workspace-comm-card");
    // As many whole cards as the rail is tall: nothing is cut at the bottom edge, and the pager is in view.
    const fits = () => rail(page).locator(".workspace-body").evaluate(node => {
      const edge = node.getBoundingClientRect().bottom, last = [...node.querySelectorAll(".workspace-comm-card")].at(-1)!.getBoundingClientRect().bottom;
      return { cut: last > edge, pager: node.querySelector(".workspace-pager")!.getBoundingClientRect().bottom <= edge, scrolls: node.scrollHeight > node.clientHeight };
    });
    await expect(cards).toHaveCount(5);
    await expect(rail(page).locator(".workspace-pager")).toContainText("1 / 2");
    // Polled: a page that gave a card back settles one layout later than the count.
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    // A taller rail holds more, still whole. (Four was the fixed number before; it left this rail half empty.)
    await page.setViewportSize({ width: 1440, height: 1300 });
    // The count first: the page of five also fits the taller rail until the rail's new height is applied.
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(8);
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    await page.setViewportSize({ width: 1440, height: 640 });
    await expect.poll(() => cards.count()).toBeLessThanOrEqual(4);
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(cards).toHaveCount(5);
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    // The sender, the arrow and the receiver are all on screen, each name shortened rather than one end lost.
    const route = await cards.first().locator(".workspace-comm-route").evaluate(node => {
      const box = node.getBoundingClientRect(), parts = [...node.children].map(child => child.getBoundingClientRect());
      // The names share the row; the arrow between them keeps its own width.
      return { inside: parts.every(part => part.right <= box.right + 0.5), names: [parts[0]!.width > 40, parts[2]!.width > 40], arrow: parts[1]!.width > 8 };
    });
    expect(route).toEqual({ inside: true, names: [true, true], arrow: true });
    // Both source and target Bots show their real Avatars in Bot-to-Bot comms.
    await expect(cards.first().locator(".workspace-comm-route .profile-avatar")).toHaveCount(2);
    if (process.env.WORKSPACE_RAIL_UI_SHOTS) await rail(page).screenshot({ path: `${process.env.WORKSPACE_RAIL_UI_SHOTS}/comms-fixed.png` });
    await expect(cards.first().locator(".workspace-comm-route > .workspace-comm-bot").last()).toHaveAttribute("title", "Reviewer-Security-Auditor-与合规审查-Bot");
    await expect(rail(page).locator(".workspace-comm-status")).toContainText(["等你同意", "正在处理", "已顺带告诉对方", "排队等回复", "失败了"]);
    await expect(cards.nth(1).locator(".workspace-comm-sub")).toContainText("按顺序排队送达");
    await expect(cards.nth(3).locator(".workspace-comm-sub")).toContainText("没赶上这轮，已排到下一轮");
    // A failed item's text is not a reply.
    await cards.nth(4).getByRole("button", { name: "展开详情" }).click();
    await expect(cards.nth(4).locator(".workspace-comm-expanded-label")).toContainText(["出了什么错"]);
    await cards.nth(4).getByRole("button", { name: "收起" }).click();
    await rail(page).getByRole("button", { name: "下一页" }).click();
    await expect(rail(page).locator(".workspace-comm-status")).toContainText(["已取消", "没收到回音", "已回复"]);
    await rail(page).getByRole("button", { name: "上一页" }).click();
    expect(await contrast(page, "aside.conversation-workspace-rail .workspace-jump-btn.is-alert")).toBeGreaterThan(4.5);
    await setTheme(page, "dark");
    // White on the dark theme's light orange was about 2:1.
    expect(await contrast(page, "aside.conversation-workspace-rail .workspace-jump-btn.is-alert")).toBeGreaterThan(4.5);
    // The Workspace entry's approval count; the Files entry has its own (non-alert) count.
    expect(await contrast(page, ".host-workspace:not([hidden]) .workspace-rail-trigger:not(.files-trigger) .workspace-rail-trigger-badge")).toBeGreaterThan(4.5);
    if (process.env.WORKSPACE_RAIL_UI_SHOTS) await rail(page).screenshot({ path: `${process.env.WORKSPACE_RAIL_UI_SHOTS}/comms-fixed-dark.png` });
  } finally { await done(); }
});

test("a slow read says it is reading, and a failed one says so with a retry button", async ({ browser }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let fail = false;
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await page.route(`**/api/conversations/${f.ids.main}/bot-comms`, async route => {
      if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      await held; await route.fallback();
    });
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-empty")).toContainText("正在读取…");
    release();
    await expect(rail(page).locator(".workspace-comm-card")).toHaveCount(2);
    // Another conversation whose first read fails.
    fail = true;
    await page.route(`**/api/conversations/${f.ids.empty}/bot-comms`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
    await openConv(page, "空白对话");
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-empty")).toContainText("暂时读不到 Bot 之间的往来，可以点一下重试。");
    await expect(rail(page).locator(".workspace-empty").getByRole("button", { name: "重试" })).toBeVisible();
  } finally { await done(); }
});

test("overview: a message being handled is not in line, subagents show helper count without avatars, hidden tasks are counted, sizes match, a group names the rest", async ({ browser }) => {
  const { page, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await page.route(`**/api/conversations/${f.ids.main}/tasks*`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ supported: true, tasks: [
      ...[1, 2, 3].map(n => ({ id: `t${n}`, label: `后台任务 ${n}`, kind: "shell", mode: "background", status: "running", canStop: false, updatedAt: Date.now() })),
      { id: "sub1", label: "查接口", kind: "subagent", mode: "background", status: "running", canStop: false, updatedAt: Date.now() },
      { id: "sub2", label: "跑单测", kind: "subagent", mode: "background", status: "running", canStop: false, updatedAt: Date.now() },
    ] }) }));
  });
  try {
    await open();
    const live = rail(page).getByRole("region", { name: "任务", exact: true });
    // The Host says this message is "dispatched": it belongs in the Replying row, not a queue row.
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["请协调评审并汇总基准测试结果。"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["正在回复 · Architect"]);
    await expect(live.locator(".workspace-queue-row")).toHaveCount(0);
    await expect(live).not.toContainText("队列第");
    // Subagents appear as a plain-language helper count with NO avatars.
    await expect(live.locator(".workspace-helper-row")).toContainText("请了 2 个小帮手");
    await expect(live.locator(".workspace-helper-row .profile-avatar")).toHaveCount(0);
    await expect(live.locator(".workspace-more-hint")).toHaveText("还有 1 个后台任务");
    // Grouped sections: one rounded container per list, rows split by hairlines, no card border per row.
    const grouped = await live.locator(".workspace-list").first().evaluate(list => {
      const style = getComputedStyle(list), rows = [...list.children].map(node => getComputedStyle(node));
      return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, gap: style.rowGap,
        firstTop: rows[0]!.borderTopWidth, nextTops: rows.slice(1).map(row => row.borderTopWidth), sides: rows.map(row => row.borderLeftWidth) };
    });
    expect(grouped).toMatchObject({ border: "1px", radius: "10px", gap: "0px", firstTop: "0px" });
    expect(grouped.nextTops.every(width => width === "1px")).toBe(true);
    expect(grouped.sides.every(width => width === "0px")).toBe(true);
    const chatSize = await page.locator(".file-card-meta small").first().innerText();
    expect(chatSize).toBe("17.99 KiB");
    await expect(rail(page).getByRole("region", { name: "产物与改动", exact: true })).toContainText(chatSize);
    await openConv(page, "发布群");
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).locator(".workspace-env-bot")).toContainText("5 位 Bot");
    await expect(rail(page).locator(".workspace-chip", { hasText: "+2" })).toHaveCount(1);
    expect(f.ids.group).toBeTruthy();
  } finally { await done(); }
});

test("jumping to a conversation that is gone stays here and says why", async ({ browser }) => {
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.main, comms(f.ids.main, [item(1, { canJumpToTarget: true, targetConversationId: "gw_gone_0000", targetConversationTitle: "已删除的协作" })]));
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await rail(page).getByRole("button", { name: "去看看" }).click();
    await expect(page.getByText("协作对话已不存在，或当前不可访问。")).toBeVisible();
    await expect(page.getByRole("heading", { name: f.mainTitle, exact: true, level: 1 })).toBeVisible();
    await expect(rail(page)).toBeVisible();
    await expect(page.getByText("conversation_forbidden")).toHaveCount(0);
  } finally { await done(); }
});

test("a jump leaves the keyboard in the conversation that opened, and a full list says it is not everything", async ({ browser }) => {
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.empty, comms(f.ids.empty, Array.from({ length: 60 }, (_, index) => item(index + 1))));
  });
  try {
    await open();
    // The real item of this fixture: Architect asked Researcher, who has replied.
    await rail(page).getByRole("button", { name: "去看看" }).last().click();
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(f.mainTitle);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".composer"))).toBe(true);
    // Sixty is all the Host returns: the list says so, and a shorter one does not.
    await openConv(page, "空白对话");
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-more-hint")).toHaveText("这里最多显示最近 60 条，更早的往来不在其中。");
    await openConv(page, f.mainTitle);
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-comm-card")).toHaveCount(2);
    await expect(rail(page).locator(".workspace-more-hint")).toHaveCount(0);
  } finally { await done(); }
});

test("keyboard: opening moves into the rail, arrows change tab, Escape closes and returns to the entry", async ({ browser }) => {
  const { page, L, trigger, done } = await ready(browser, "zh", 1440);
  try {
    if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByRole("tab", { name: L("总览") })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const commsTab = rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) });
    await expect(commsTab).toBeFocused();
    await expect(commsTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(rail(page).getByRole("tab", { name: new RegExp(L("文件")) })).toHaveAttribute("aria-selected", "true");
    // One Tab leaves the tab row for the tab's own content, not for the next tab.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).not.toBe("tab");
    await page.keyboard.press("Escape");
    await expect(rail(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // A rail that comes back with the page does not take the focus from where the person was.
    await trigger.click();
    await page.reload();
    await expect(rail(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.conversation-workspace-rail"))).toBe(false);
  } finally { await done(); }
});

test("the entry rests without a frame, like the header buttons beside it, and shows its edge only while the rail is open", async ({ browser }) => {
  const { trigger, open, done } = await ready(browser, "zh", 1400);
  try {
    const edge = () => trigger.evaluate(node => getComputedStyle(node).borderTopColor);
    expect(await edge()).toBe("rgba(0, 0, 0, 0)");
    await open();
    await expect.poll(edge).not.toBe("rgba(0, 0, 0, 0)");
  } finally { await done(); }
});

/** The colour a theme token resolves to, as a computed colour string. */
const token = (page: Page, name: string) => page.evaluate(value => {
  const probe = document.body.appendChild(document.createElement("span")); probe.style.color = `var(${value})`;
  const colour = getComputedStyle(probe).color; probe.remove(); return colour;
}, name);

test("a turn's changes are listed by file name with baseline-aligned green and red counts and ratio bar; the reply's own entry stays 本轮改动", async ({ browser }) => {
  const { page, open, done } = await ready(browser, "zh", 1400);
  try {
    await open();
    const row = rail(page).locator(".workspace-diff-row");
    await expect(row.locator(".workspace-diff-summary-text")).toHaveText("2 个文件已更改");
    await expect(row.locator(".workspace-diff-summary-counts")).toHaveText("+14-3");
    await expect(row.locator(".workspace-diff-bar .is-add")).toBeVisible();
    await expect(row.locator(".workspace-diff-bar .is-del")).toBeVisible();
    // The names are the Hub's record of that run (two edits in the fixture's journal), not the totals on the card.
    await expect(row.locator(".workspace-diff-name")).toHaveText(["ConversationWorkspace.tsx", "bot-messages.ts"]);
    await expect(row.locator(".workspace-diff-name").first()).toHaveAttribute("title", "client/src/ConversationWorkspace.tsx");
    await expect(row.locator(".workspace-diff-counts").first().locator("span")).toHaveText(["+2", "-1"]);
    await expect(row.locator(".workspace-diff-counts").last().locator("span")).toHaveText(["+1", "-1"]);
    const countsMetrics = await row.locator(".workspace-diff-counts").first().evaluate(node => {
      const style = getComputedStyle(node);
      const spans = [...node.querySelectorAll("span")].map(span => {
        const box = span.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(span);
        const textBox = range.getBoundingClientRect();
        return { color: getComputedStyle(span).color, top: box.top, bottom: box.bottom, height: box.height, textTop: textBox.top, textBottom: textBox.bottom };
      });
      return { alignItems: style.alignItems, fontVariantNumeric: style.fontVariantNumeric, spans };
    });
    expect(countsMetrics.alignItems).toBe("baseline");
    expect(countsMetrics.fontVariantNumeric).toBe("tabular-nums");
    expect(countsMetrics.spans.map(s => s.color)).toEqual([await token(page, "--green"), await token(page, "--red")]);
    expect(countsMetrics.spans[0]!.color).not.toBe(countsMetrics.spans[1]!.color);
    expect(Math.abs(countsMetrics.spans[0]!.top - countsMetrics.spans[1]!.top)).toBeLessThan(0.5);
    expect(Math.abs(countsMetrics.spans[0]!.height - countsMetrics.spans[1]!.height)).toBeLessThan(0.5);
    expect(Math.abs(countsMetrics.spans[0]!.textBottom - countsMetrics.spans[1]!.textBottom)).toBeLessThan(0.5);
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    // On the reply itself the entry carries no counts and no names.
    const reply = page.locator(".host-workspace:not([hidden])").getByRole("region", { name: "运行回复", exact: true });
    await expect(reply.getByRole("button", { name: "本轮改动", exact: true })).toBeVisible();
    await expect(reply.getByRole("button", { name: /改动 \d+ 个文件|\+\d+/ })).toHaveCount(0);
    await row.getByRole("button").click();
    await expect(page.getByRole("dialog", { name: "本轮改动", exact: true })).toBeVisible();
  } finally { await done(); }
});

test("when the names cannot be read, the saved totals stand in, still green and red", async ({ browser }) => {
  const { page, open, done } = await ready(browser, "zh", 1400, async page => {
    await page.route("**/api/messages/*/changes?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  });
  try {
    await open();
    const row = rail(page).locator(".workspace-diff-row");
    await expect(row.locator(".workspace-diff-name")).toHaveText(["改动 2 个文件"]);
    await expect(row.locator(".workspace-diff-counts span")).toHaveText(["+14", "-3"]);
    expect(await row.locator(".workspace-diff-counts span").evaluateAll(spans => spans.map(span => getComputedStyle(span).color))).toEqual([await token(page, "--green"), await token(page, "--red")]);
  } finally { await done(); }
});

test("Replying row names the answered message, avoids duplicate queue rows, advances when done, and lists each replying Bot in a group", async ({ browser }) => {
  const { page, f, open, done } = await ready(browser, "zh", 1440);
  try {
    // Direct chat: send 1st message (being answered), then 2nd and 3rd queued behind it.
    const m1 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-1", text: "第一条：正在处理中的长消息内容", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const m2 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-2", text: "第二条：排在前面的消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const m3 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-3", text: "第三条：排在后面的消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [f.ids.userMsg, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [m1.id, "bot_arch"]);
    const reply1 = await f.hub.store.publishBotMessage("bot_arch", { conversationId: f.ids.main, replyTo: m1.id, blocks: [{ type: "text", text: "正在分析第一条…" }], status: "streaming" });
    await open();
    const live = rail(page).getByRole("region", { name: "任务", exact: true });
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["第一条：正在处理中的长消息内容"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["正在回复 · Architect"]);
    await expect(live.locator(".workspace-queue-row")).toHaveCount(2);
    await expect(live.locator(".workspace-queue-row .workspace-item-title")).toHaveText(["第二条：排在前面的消息", "第三条：排在后面的消息"]);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位", "队列第 2 位"]);

    // First reply finishes and second message moves into Replying; queue shrinks to 1.
    await f.hub.store.publishBotMessage("bot_arch", { id: reply1.id, conversationId: f.ids.main, replyTo: m1.id, blocks: [{ type: "text", text: "第一条已完成。" }], status: "complete" });
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [m1.id, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [m2.id, "bot_arch"]);
    await f.hub.store.publishBotMessage("bot_arch", { conversationId: f.ids.main, replyTo: m2.id, blocks: [{ type: "text", text: "正在处理第二条…" }], status: "streaming" });
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["第二条：排在前面的消息"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["正在回复 · Architect"]);
    await expect(live.locator(".workspace-queue-row")).toHaveCount(1);
    await expect(live.locator(".workspace-queue-row .workspace-item-title")).toHaveText(["第三条：排在后面的消息"]);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位"]);

    // Group chat: two Bots replying concurrently show one row each with Bot + answered message.
    const g1 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.group, clientMsgId: "g-1", text: "请架构师核对接口设计", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const g2 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.group, clientMsgId: "g-2", text: "请审查员检查回归用例", attachments: [], mentions: ["bot_rev"], previewUrl: null })).message;
    await f.hub.store.publishBotMessage("bot_arch", { conversationId: f.ids.group, replyTo: g1.id, blocks: [{ type: "text", text: "核对中…" }], status: "streaming" });
    await f.hub.store.publishBotMessage("bot_rev", { conversationId: f.ids.group, replyTo: g2.id, blocks: [{ type: "text", text: "检查中…" }], status: "streaming" });
    await openConv(page, "发布群");
    await expect(live.locator(".workspace-replying-row")).toHaveCount(2);
    await expect(live.locator(".workspace-replying-row").filter({ hasText: "正在回复 · Architect" }).locator(".workspace-item-title")).toHaveText("请架构师核对接口设计");
    await expect(live.locator(".workspace-replying-row").filter({ hasText: "正在回复 · Reviewer" }).locator(".workspace-item-title")).toHaveText("请审查员检查回归用例");
  } finally { await done(); }
});

for (const locale of ["zh", "en"] as const) {
  test(`group discussion Replying row shows the topic instead of hardcoded Chinese scheduler input (${locale})`, async ({ browser }) => {
    const { page, f, L, open, done } = await ready(browser, locale, 1440);
    try {
      const groupTitle = locale === "en" ? "Release group" : "发布群";
      const topicText = locale === "en" ? "Review staged rollout checklist before shipping" : "发布前核对灰度检查清单";
      const settings = await f.hub.store.groupSettings("owner", f.ids.group);
      const botIds = settings.group.botIds;
      await f.hub.store.updateGroup("owner", f.ids.group, {
        title: settings.group.title,
        botIds,
        expectedTitle: settings.group.title,
        expectedBotIds: botIds,
        expectedRevision: settings.revision,
        policy: { mode: "sequential", botOrder: botIds, maxRounds: 2 },
      });
      const updated = await f.hub.store.groupSettings("owner", f.ids.group);
      const started = await f.hub.groupDiscussions.start("owner", f.ids.group, {
        requestId: `gd-req-${locale}`,
        revision: updated.revision,
        text: topicText,
        participants: ["bot_arch", "bot_rev"],
      });
      const inputMessageId = started.run!.steps[0]!.inputMessageId!;
      const topicMessageId = started.run!.topicMessageId!;
      await f.hub.store.publishBotMessage("bot_arch", {
        conversationId: f.ids.group,
        replyTo: inputMessageId,
        blocks: [{ type: "text", text: locale === "en" ? "Drafting analysis..." : "正在分析…" }],
        status: "streaming",
      });

      await openConv(page, groupTitle);
      await open();
      const live = rail(page).getByRole("region", { name: L("任务"), exact: true });
      await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
      await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText([topicText]);
      await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText([
        locale === "en" ? "Replying · Architect" : "正在回复 · Architect",
      ]);
      await expect(live).not.toContainText("轮流讨论");
      await expect(live).not.toContainText("请 Architect");

      // Deleting the topic message falls back to localized "Replying" + Bot name, never raw scheduler text.
      await f.hub.store.deleteMessages("owner", f.ids.group, { messageIds: [topicMessageId] });
      await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText([
        locale === "en" ? "Replying" : "正在回复",
      ]);
      await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["Architect"]);
      await expect(live).not.toContainText("轮流讨论");
      await expect(live).not.toContainText("请 Architect");
    } finally { await done(); }
  });
}

test("going offline clears live Replying rows for both dispatched and streaming replies, and marks queued rows offline", async ({ browser }) => {
  const { context, page, f, open, done } = await ready(browser, "zh", 1440);
  try {
    await f.hub.store.sendMessage("owner", {
      conversationId: f.ids.main,
      clientMsgId: "offline-q-2",
      text: "离线测试的排队消息",
      attachments: [],
      mentions: ["bot_arch"],
      previewUrl: null,
    });
    await open();
    const live = rail(page).getByRole("region", { name: "任务", exact: true });
    // Initially dispatched (no streaming Bot message yet) + 1 queued item.
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["请协调评审并汇总基准测试结果。"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["正在回复 · Architect"]);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位"]);

    // Drop offline: dispatched Replying row (with green online dot) clears; queued item stays marked offline.
    await context.setOffline(true);
    for (const client of (f.hub as unknown as { clients: Set<{ ws: { terminate(): void } }> }).clients) client.ws.terminate();
    await expect(live.locator(".workspace-replying-row")).toHaveCount(0);
    await expect(live.locator(".status-dot.online")).toHaveCount(0);
    await expect(live.locator(".workspace-queue-row .workspace-item-title")).toHaveText(["离线测试的排队消息"]);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位 · 离线"]);

    // Reconnect and also verify dropping offline during an active streaming reply does not let dispatchedItems take over.
    await context.setOffline(false);
    await waitForClientOnline(page);
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位"]);

    await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.main,
      replyTo: f.ids.userMsg,
      blocks: [{ type: "text", text: "正在流式输出…" }],
      status: "streaming",
    });
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["请协调评审并汇总基准测试结果。"]);

    await context.setOffline(true);
    for (const client of (f.hub as unknown as { clients: Set<{ ws: { terminate(): void } }> }).clients) client.ws.terminate();
    await expect(live.locator(".workspace-replying-row")).toHaveCount(0);
    await expect(live.locator(".status-dot.online")).toHaveCount(0);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位 · 离线"]);
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await done();
  }
});

test("deleted replyTo is never misattributed to another dispatched item, and queue polling stays serialized and scoped across switches", async ({ browser }) => {
  let holdMainQueue = false;
  let activeMainQueue = 0;
  let maxActiveMainQueue = 0;
  let emptyQueueRequests = 0;
  let emptyQueueAborts = 0;
  const { page, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    page.on("requestfailed", req => {
      if (req.url().includes(`/api/conversations/${f.ids.empty}/queue`)) emptyQueueAborts++;
    });
    await page.route("**/api/conversations/*/queue*", async route => {
      const url = route.request().url();
      if (url.includes(`/api/conversations/${f.ids.empty}/queue`)) {
        emptyQueueRequests++;
        await route.continue();
        return;
      }
      if (holdMainQueue && url.includes(`/api/conversations/${f.ids.main}/queue`)) {
        activeMainQueue++;
        maxActiveMainQueue = Math.max(maxActiveMainQueue, activeMainQueue);
        await new Promise(resolve => setTimeout(resolve, 2600));
        activeMainQueue--;
        await route.continue().catch(() => undefined);
        return;
      }
      await route.continue();
    });
  });
  try {
    // Bug 4: replyTo points at deleted m1 while unrelated m2 is dispatched -> must never show m2's text.
    const m1 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "del-1", text: "即将删除的原消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const m2 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "del-2", text: "另一条不相关的已下发消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [f.ids.userMsg, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [m1.id, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [m2.id, "bot_arch"]);
    await f.hub.store.deleteMessages("owner", f.ids.main, { messageIds: [m1.id] });
    await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.main,
      replyTo: m1.id,
      blocks: [{ type: "text", text: "仍在流式回复已删消息…" }],
      status: "streaming",
    });

    await open();
    const live = rail(page).getByRole("region", { name: "任务", exact: true });
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["正在回复"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["Architect"]);
    await expect(live).not.toContainText("另一条不相关的已下发消息");

    // Bug 3: slow /queue responses (>2s) do not pile up concurrent requests from the workspace poller.
    holdMainQueue = true;
    await page.waitForTimeout(4500);
    holdMainQueue = false;
    // PromptQueue + ConversationWorkspace are at most 1 in-flight request each (never piling up every 2s).
    expect(maxActiveMainQueue).toBeLessThanOrEqual(2);

    // Bug 5: switching from a busy direct chat to a group chat or empty direct chat never leaks stale items
    // or aborts/duplicates the target conversation's initial /queue read.
    await openConv(page, "发布群");
    await expect(live.locator(".workspace-replying-row")).toHaveCount(0);
    await expect(live.locator(".workspace-queue-row")).toHaveCount(0);
    await openConv(page, f.mainTitle);
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    emptyQueueRequests = 0;
    emptyQueueAborts = 0;
    await openConv(page, "空白对话");
    await expect(live.locator(".workspace-idle-strip")).toBeVisible();
    await page.waitForTimeout(400);
    expect(emptyQueueAborts).toBe(0);
    // 1 initial read from PromptQueue + 1 initial read from ConversationWorkspace (no duplicate/abort).
    expect(emptyQueueRequests).toBeLessThanOrEqual(2);
  } finally { await done(); }
});

test("Waiting for you block approves directly and Replying row deduplicates queued messages", async ({ browser }) => {
  const { page, f, open, done } = await ready(browser, "zh", 1440);
  try {
    // 1. Direct Approve from the highlighted amber Waiting for you block.
    await open();
    const waiting = rail(page).getByRole("region", { name: "等你确认", exact: true });
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText("Reviewer 想运行一条命令，需要你同意");
    await expect(waiting).toContainText("npm run test:regression");
    await waiting.getByRole("button", { name: "同意", exact: true }).click();
    await expect.poll(async () => {
      const row = await f.hub.store.db.get<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM action_deliveries");
      return row?.cnt ?? 0;
    }).toBeGreaterThanOrEqual(1);

    // 2. Direct chat queue deduplication (#93 coordination): dispatched message shows in Replying row, not queue row.
    const m1 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-1", text: "第一条：正在处理中的长消息内容", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const m2 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-2", text: "第二条：排在前面的消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    const m3 = (await f.hub.store.sendMessage("owner", { conversationId: f.ids.main, clientMsgId: "q-3", text: "第三条：排在后面的消息", attachments: [], mentions: ["bot_arch"], previewUrl: null })).message;
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [f.ids.userMsg, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [m1.id, "bot_arch"]);
    const reply1 = await f.hub.store.publishBotMessage("bot_arch", { conversationId: f.ids.main, replyTo: m1.id, blocks: [{ type: "text", text: "正在分析第一条…" }], status: "streaming" });
    const live = rail(page).getByRole("region", { name: "任务", exact: true });
    await expect(live.locator(".workspace-replying-row")).toHaveCount(1);
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["第一条：正在处理中的长消息内容"]);
    await expect(live.locator(".workspace-replying-row .workspace-item-meta")).toContainText(["正在回复 · Architect"]);
    await expect(live.locator(".workspace-queue-pill")).toHaveText("排队 2");
    await expect(live.locator(".workspace-queue-row")).toHaveCount(2);
    await expect(live.locator(".workspace-queue-row .workspace-item-title")).toHaveText(["第二条：排在前面的消息", "第三条：排在后面的消息"]);
    await expect(live.locator(".workspace-queue-row .workspace-item-meta")).toHaveText(["队列第 1 位", "队列第 2 位"]);

    await f.hub.store.publishBotMessage("bot_arch", { id: reply1.id, conversationId: f.ids.main, replyTo: m1.id, blocks: [{ type: "text", text: "第一条已完成。" }], status: "complete" });
    await f.hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [m1.id, "bot_arch"]);
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [m2.id, "bot_arch"]);
    await f.hub.store.publishBotMessage("bot_arch", { conversationId: f.ids.main, replyTo: m2.id, blocks: [{ type: "text", text: "正在处理第二条…" }], status: "streaming" });
    await expect(live.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["第二条：排在前面的消息"]);
    await expect(live.locator(".workspace-queue-row")).toHaveCount(1);
    await expect(live.locator(".workspace-queue-row .workspace-item-title")).toHaveText(["第三条：排在后面的消息"]);
  } finally { await done(); }
});

test("Waiting-for-you deduplicates incoming Agent Bus approvals, skips history-excluded cards, and handles Bot-to-Bot question forms without re-fetching", async ({ browser }) => {
  const fetches = new Map<string, number>();
  let resQuestionConv = "";
  const { page, f, open, done } = await ready(browser, "zh", 1280, async (page, f) => {
    const guard = async () => undefined;
    // Bug 3: a rolled-back (history-excluded) local approval card in mainChat must never appear in Waiting-for-you.
    const rolledBack = await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.main,
      replyTo: f.ids.userMsg,
      blocks: [{
        type: "card",
        title: "已回退审批",
        elements: [
          { type: "markdown", text: "rm -rf /tmp/old-build" },
          { type: "button", text: "Allow once", actionId: "act_rolled_back", value: { cctb_lark: "approval", requestId: "perm-rb-1", decision: "allow_once" } },
        ],
      }],
      status: "streaming",
    });
    const excludedMessage = { ...rolledBack, historyContext: { excludedBy: "op_rewind_1" }, version: rolledBack.version + 1 };
    await f.hub.store.db.run(
      "UPDATE messages SET history_json=?, version=? WHERE id=?",
      [JSON.stringify(excludedMessage.historyContext), excludedMessage.version, rolledBack.id],
    );
    await f.hub.store.db.run(
      "UPDATE events SET payload_json=? WHERE conversation_id=? AND kind='message.created' AND json_extract(payload_json,'$.id')=?",
      [JSON.stringify(excludedMessage), f.ids.main, rolledBack.id],
    );

    // Bug 1: incoming Agent Bus stage in revConv pointing at a local approval card in revConv.
    const now = Date.now();
    await f.hub.store.publishBotMessage("bot_rev", {
      conversationId: f.ids.revConv,
      blocks: [{
        type: "card",
        title: "阶段命令审批",
        elements: [
          { type: "markdown", text: "npm run lint" },
          { type: "button", text: "Allow once", actionId: "act_stage_allow", value: { cctb_lark: "approval", requestId: "perm-stage-1", decision: "allow_once" } },
        ],
      }],
      status: "streaming",
    });
    const runId = `abr_${randomUUID().slice(0, 12)}`;
    await f.hub.store.db.run(
      "INSERT INTO agent_bus_runs(id,workspace_id,owner_id,coordinator_id,conversation_id,message_id,snapshot_json,text,status,created_at) VALUES(?,?,?,?,?,?,?,?,'running',?)",
      [runId, "ab_ws_1", "owner", "bot_arch", f.ids.main, `msg_bus_${runId}`, JSON.stringify({ name: "发布协作" }), "协调代码评审", now - 5000],
    );
    await f.hub.store.db.run(
      "INSERT INTO agent_bus_stages(run_id,id,bot_id,conversation_id,status,message_id,started_at,finished_at,error,seq) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [runId, "stg_rev_1", "bot_rev", f.ids.revConv, "running", null, now - 4000, null, null, 1],
    );

    // Bug 2: Bot-to-Bot outgoing comm whose target card is an ask_user_question form (no allow_once).
    const qSent = await f.hub.botMessages.local(
      { operation: "send", host: "演示主机", bot: "bot_res", conversation: f.ids.resConv, requestId: "req-ui-q1", contextMessage: f.ids.userMsg, data: { text: "确认部署环境" } },
      "bot_arch",
      guard,
    ) as { messageId: string };
    await f.hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [qSent.messageId, "bot_res"]);
    await f.hub.store.publishBotMessage("bot_res", {
      conversationId: f.ids.resConv,
      replyTo: qSent.messageId,
      blocks: [{
        type: "card",
        title: "请选择部署环境",
        elements: [
          { type: "markdown", text: "选择 staging 或 production" },
          { type: "button", text: "提交回答", actionId: "act_q_submit", value: { cctb_lark: "ask_user_question", requestId: "ask-q-1", action: "form_submit" } },
        ],
      }],
      status: "streaming",
    });
    resQuestionConv = f.ids.resConv;

    page.on("request", req => {
      const m = req.url().match(/\/api\/conversations\/([^/?#]+)\/messages/);
      if (m && req.method() === "GET") {
        const id = decodeURIComponent(m[1]!);
        fetches.set(id, (fetches.get(id) ?? 0) + 1);
      }
    });
  });
  try {
    await open();
    const waiting = rail(page).getByRole("region", { name: "等你确认", exact: true });
    await expect(waiting).toBeVisible();
    // 3 valid remote items (Researcher question + Reviewer delegation + outgoing Agent Bus stage);
    // the rolled-back local card in mainChat is excluded (never 4!).
    await expect(waiting.locator(".workspace-waiting-count")).toHaveText("3");
    await expect(waiting).not.toContainText("已回退审批");

    const cards = waiting.locator(".workspace-waiting-card");
    const questionCard = cards.filter({ hasText: "请选择部署环境" });
    await expect(questionCard).toContainText("Researcher 想确认「请选择部署环境」，需要你回答");
    await expect(questionCard).not.toContainText("需要你同意");
    await expect(questionCard.getByRole("button", { name: "同意", exact: true })).toHaveCount(0);
    await expect(questionCard.getByRole("button", { name: "去看看", exact: true })).toBeVisible();

    const approvalCard = cards.filter({ hasText: /npm run (test:regression|lint)/ }).first();
    await expect(approvalCard.getByRole("button", { name: "同意", exact: true })).toBeEnabled();

    // Question lookup is cached (0 if already in local cache, at most 1 HTTP fetch):
    // refreshing workspace must never re-fetch resConv /messages.
    const resFetchesBefore = fetches.get(resQuestionConv) ?? 0;
    expect(resFetchesBefore).toBeLessThanOrEqual(1);
    const refreshBtn = rail(page).getByRole("button", { name: "刷新工作区", exact: true });
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled();
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled();
    await page.waitForTimeout(200);
    expect(fetches.get(resQuestionConv) ?? 0).toBe(resFetchesBefore);

    // Uncached remote lookup lacking allow_once fetches /messages exactly ONCE and caches the negative result across refreshes.
    await mockComms(page, f.ids.empty, comms(f.ids.empty, [
      item(1, {
        status: "needs_approval",
        canJumpToTarget: true,
        targetConversationId: resQuestionConv,
        pendingApproval: { messageId: "msg_uncached_no_allow", title: "审批确认", detail: "check target" },
      }),
    ]));
    const uncachedBase = fetches.get(resQuestionConv) ?? 0;
    await openConv(page, "空白对话");
    await expect.poll(() => fetches.get(resQuestionConv) ?? 0).toBe(uncachedBase + 1);
    await expect(waiting.locator(".workspace-waiting-card")).toHaveCount(1);
    await expect(waiting.getByRole("button", { name: "同意", exact: true })).toHaveCount(0);
    await expect(waiting.getByRole("button", { name: "去看看", exact: true })).toBeVisible();
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled();
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled();
    await page.waitForTimeout(200);
    expect(fetches.get(resQuestionConv) ?? 0).toBe(uncachedBase + 1);

    // Jump back to mainChat then to revConv: 2 local approval cards + 1 incoming Agent Bus stage -> count must stay 2
    // (no duplicate), and coordinator main/messages must never be fetched.
    await openConv(page, f.mainTitle);
    await expect(waiting.locator(".workspace-waiting-count")).toHaveText("3");
    fetches.set(f.ids.main, 0);
    await waiting.locator(".workspace-waiting-card").filter({ hasText: /npm run (test:regression|lint)/ }).first().getByRole("button", { name: "去看看", exact: true }).click();
    await expect(waiting.locator(".workspace-waiting-count")).toHaveText("2");
    await expect(waiting).not.toContainText("还有 1 件事在等你同意");
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled();
    await page.waitForTimeout(200);
    expect(fetches.get(f.ids.main) ?? 0).toBe(0);
  } finally { await done(); }
});

test("Workspace rail fixes cross-host avatar isolation, queue dedup race, long Bot truncation, bottom help popover flip, file type badges, and group elapsed ticking", async ({ browser }) => {
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
  let raceMsgPayload: Record<string, unknown> | undefined;
  const { page, f, open, done } = await ready(browser, "zh", 1280, async (page, f) => {
    // Bug 4: upload a custom PNG avatar for local bot_arch; unpaired remote host with same botId must not show it.
    await f.hub.store.db.run(
      "INSERT OR REPLACE INTO profile_avatars(kind,target_id,revision,png) VALUES('bot','bot_arch',1,?)",
      [png1x1],
    );
    await mockComms(page, f.ids.empty, comms(f.ids.empty, [
      item(1, {
        direction: "incoming",
        crossHost: true,
        sourceHostId: "hub_unpaired_remote_host",
        sourceHostName: "RemoteMac",
        sourceBotId: "bot_arch",
        sourceBotName: "RemoteArch",
        targetBotId: "bot_ops",
        targetBotName: "运维小助手",
      }),
    ]));

    // Bug 8: text/plain .tsx code file + non-decodable image attachment shared in mainChat.
    const now = Date.now();
    await f.hub.store.db.run(
      "INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,?,?,1200,'text/plain','helper.tsx','att_helper_tsx.blob',1,?)",
      ["att_helper_tsx", f.ids.main, "owner", "c".repeat(64), now + 100],
    );
    await f.hub.store.db.run(
      "INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,?,?,2400,'image/png','broken.png','att_broken_png.blob',1,?)",
      ["att_broken_png", f.ids.main, "owner", "d".repeat(64), now + 200],
    );
    await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.main,
      replyTo: f.ids.userMsg,
      blocks: [
        { type: "file", attachmentId: "att_helper_tsx", name: "helper.tsx", size: 1200, mime: "text/plain" },
        { type: "image", attachmentId: "att_broken_png", name: "broken.png", size: 2400, mime: "image/png" },
      ],
      status: "complete",
    });
    await page.route("**/api/attachments/att_broken_png*", route => route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("not-a-valid-png"),
    }));

    // Bug 5: queue endpoint still reports state="queued" while a live streaming Bot reply for the same message exists.
    const raceInput = (await f.hub.store.sendMessage("owner", {
      conversationId: f.ids.main,
      clientMsgId: "race-q-1",
      text: "竞争条件测试消息",
      attachments: [],
      mentions: ["bot_arch"],
      previewUrl: null,
    })).message;
    raceMsgPayload = raceInput as unknown as Record<string, unknown>;
    await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.main,
      replyTo: raceInput.id,
      blocks: [{ type: "text", text: "正在流式回复…" }],
      status: "streaming",
    });
    await page.route(`**/api/conversations/${f.ids.main}/queue*`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        supported: true,
        items: [{ state: "queued", message: raceMsgPayload }],
      }),
    }));

    // Bug 9: streaming Bot reply in group chat so elapsed duration ticks without queue polling.
    await f.hub.store.publishBotMessage("bot_arch", {
      conversationId: f.ids.group,
      blocks: [{ type: "text", text: "群聊思考中…" }],
      status: "streaming",
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    await open();

    // Bug 5: message being streamed must NOT duplicate in queue rows or the "排队 N" pill.
    const doing = rail(page).getByRole("region", { name: "任务", exact: true });
    await expect(doing.locator(".workspace-replying-row .workspace-item-title")).toHaveText(["竞争条件测试消息"]);
    await expect(doing.locator(".workspace-queue-row")).toHaveCount(0);
    await expect(doing.locator(".workspace-queue-pill")).toHaveCount(0);

    // Bug 7: when bottom section header sits near the bottom of .workspace-body, "?" popover flips upward
    // so nothing is clipped below .workspace-body or faded by the 16px bottom mask.
    const madeHeaderBottom = await rail(page).evaluate(node =>
      node.querySelector('[aria-label="产物与改动"] .workspace-section-header')!.getBoundingClientRect().bottom,
    );
    await page.setViewportSize({ width: 1280, height: Math.max(620, Math.round(madeHeaderBottom + 50)) });
    const help = rail(page).getByRole("button", { name: "说明：产物与改动" });
    // Keep keyboard focus on the trigger while arranging the bottom-edge case. A pointer click
    // may scroll it back to the centre after Chromium settles the resized rail.
    await help.evaluate(button => button.focus({ preventScroll: true }));
    await expect.poll(() => help.evaluate(async button => {
      const body = button.closest<HTMLElement>(".workspace-body")!;
      const header = button.closest(".workspace-section-header")!;
      body.style.overflowAnchor = "none";
      body.scrollTop += header.getBoundingClientRect().bottom - (body.getBoundingClientRect().bottom - 40);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const gap = body.getBoundingClientRect().bottom - header.getBoundingClientRect().bottom;
      return gap >= 36 && gap <= 44;
    })).toBe(true);
    await page.keyboard.press("Enter");
    const popover = rail(page).locator(".ws-help-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toHaveClass(/is-up/);
    const popMetrics = await rail(page).evaluate(node => {
      const body = node.querySelector(".workspace-body")!.getBoundingClientRect();
      const pop = node.querySelector(".ws-help-popover")!.getBoundingClientRect();
      return { bodyTop: body.top, bodyBottom: body.bottom, popTop: pop.top, popBottom: pop.bottom };
    });
    expect(popMetrics.popBottom).toBeLessThanOrEqual(popMetrics.bodyBottom - 16);
    expect(popMetrics.popTop).toBeGreaterThanOrEqual(popMetrics.bodyTop);
    await rail(page).getByRole("button", { name: "关闭说明" }).click();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Bug 8: helper.tsx (text/plain) classifies as code; file rows show a type badge, never an image thumbnail.
    await rail(page).getByRole("tab", { name: /^文件/ }).click();
    const codeTile = rail(page).locator(".workspace-file-tile", { hasText: "helper.tsx" });
    await expect(codeTile.locator(".workspace-file-badge.is-code")).toHaveText("TSX");
    await expect(codeTile).toContainText("代码");
    const brokenTile = rail(page).locator(".workspace-file-tile", { hasText: "broken.png" });
    await expect(brokenTile.locator(".workspace-file-badge.is-img")).toHaveText("IMG");
    await expect(rail(page).locator(".workspace-file-tile img")).toHaveCount(0);

    // Bug 4: unpaired remote Bot with colliding botId="bot_arch" must not render local bot_arch's uploaded blob avatar.
    await openConv(page, "空白对话");
    await rail(page).getByRole("tab", { name: /^总览/ }).click();
    const remoteAvatar = rail(page).locator('.workspace-comm-card .profile-avatar[data-avatar="bot:hub_unpaired_remote_host:bot_arch"]');
    await expect(remoteAvatar).toBeVisible();
    expect(await remoteAvatar.locator("img").getAttribute("src")).not.toMatch(/^blob:/);

    // Bug 6: long Bot name truncates cleanly inside .workspace-env-card without horizontal overflow.
    await openConv(page, LONG_TITLE_ZH);
    const envOverflow = await rail(page).locator(".workspace-env-card").evaluate(card => {
      const bot = card.querySelector(".workspace-env-bot")!.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      return { scrollWidth: card.scrollWidth, clientWidth: card.clientWidth, botRight: bot.right, cardRight: box.right };
    });
    expect(envOverflow.scrollWidth).toBeLessThanOrEqual(envOverflow.clientWidth + 1);
    expect(envOverflow.botRight).toBeLessThanOrEqual(envOverflow.cardRight + 1);

    // Bug 9: group chat elapsed duration ticks live even without direct-chat queue polling.
    await openConv(page, "发布群");
    const groupMeta = rail(page).locator(".workspace-replying-row .workspace-item-meta").first();
    await expect(groupMeta).toContainText(/已做 \d+ 秒/);
    const firstText = await groupMeta.innerText();
    await expect.poll(async () => await groupMeta.innerText(), { timeout: 4000 }).not.toBe(firstText);
  } finally { await done(); }
});

test("the Bot communication pager still fits after a delayed local grants card arrives", async ({ browser }) => {
  let release!: () => void;
  const grantsReady = new Promise<void>(resolve => { release = resolve; });
  const { page, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.main, comms(f.ids.main, Array.from({ length: 20 }, (_, i) => item(i + 1, { status: "running" }))));
    await page.route("**/api/bot-messages/grants", async route => { await grantsReady; await route.continue(); });
  });
  try {
    await open();
    const panel = rail(page);
    await panel.getByRole("tab", { name: /^Bot 通信/ }).click();
    const pager = panel.locator(".workspace-pager");
    await expect(pager).toBeVisible();
    const room = () => pager.evaluate(node => node.closest(".workspace-body")!.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom);
    // Put the last row just above the bottom padding, so an async header needs another row's space.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ ...viewport, height: Math.round(viewport.height - await room() + 22) });
    await expect(pager).toBeInViewport();
    release();
    await expect(panel.locator(".workspace-mesh")).toBeVisible();
    await expect.poll(room).toBeGreaterThanOrEqual(0);
  } finally { release(); await done(); }
});
