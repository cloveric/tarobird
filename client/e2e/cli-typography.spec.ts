import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

const text = `## 核对结果 / Review

已核对 **3 项记录**，保留原始金额与备注。Next: review totals.

| 项目 Item | 金额 Amount | 备注 Notes |
| --- | ---: | --- |
| 酒店 Hotel | 1,041.28 | 已核对来源，待确认是否为退款。 |
| 电费 Utilities | 81.70 | 单独列入本月账本，保留原始日期。 |

使用 \`ledger.csv\` 查看明细。[查看来源](https://example.com/ledger)

> 待确认 / Pending：这两笔记录暂不合并。

\`\`\`js
// 核对金额 / Check totals
const status = "ready";
function total() { return 1122.98; }
\`\`\`
`;

for (const width of [390, 1360]) test(`CLI bilingual reading size, fonts and contrast stay consistent (${width}px)`, async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width, height: 1000 });
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-type-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('type','终端助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["type"], "账单核对 / Review", "type");
    const card = await hub.store.publishBotMessage("type", { conversationId: chat.id, blocks: [{ type: "card", title: "核对完成", elements: [{ type: "markdown", text }] }] });
    const plain = await hub.store.publishBotMessage("type", { conversationId: chat.id, blocks: [{ type: "text", text }] });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page);
    for (const [size, mode] of [[14, "light"], [14, "system"], [12, "dark"], [20, "dark"]] as const) {
      await openSettings(page);
      await page.getByLabel("字号", { exact: true }).focus();
      await page.getByLabel("字号", { exact: true }).press("Home");
      for (let step = 12; step < size; step++) await page.getByLabel("字号", { exact: true }).press("ArrowRight");
      await page.getByLabel("主题", { exact: true }).selectOption(mode);
      await page.locator('input[name="color-palette"][value="cli"]').check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("#theme")).toHaveCount(0);
      const preview = page.locator('.palette-preview[data-palette="cli"] .xp-pane');
      await expect(preview).toHaveCount(1); await expect(preview).toHaveAttribute("data-mode", "dark");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tarocub-appearance")!).theme)).toBe(mode);
      await closeSettings(page); await selectConversation(page, chat.title);
      // Old light/system choices and live OS changes cannot bring back light CLI.
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        expect(await page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--bg").trim())).toBe("#0c0c0c");
      }
      if (size === 14) { await page.reload(); await waitForClientOnline(page); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); await selectConversation(page, chat.title); }

      await page.evaluate(() => document.fonts.ready);
      for (const message of [card, plain]) {
        const row = page.locator(`[data-message-id="${message.id}"]`);
        await row.scrollIntoViewIfNeeded();
        await expect(row.locator(".markdown > .markdown-chunk > p").first()).toHaveCSS("font-size", `${size}px`);
        const tableSize = width > 760 ? Math.max(12, Number((size * .92).toFixed(2))) : size;
        await expect(row.locator("td").first()).toHaveCSS("font-size", `${tableSize}px`);
        await expect(row.locator("th").first()).toHaveCSS("font-size", `${tableSize}px`);
        await expect(row.locator("pre code")).toHaveCSS("font-size", `${size}px`);
        await expect(row.locator(".markdown h2")).toHaveCSS("font-size", `${size}px`);
        const metrics = await row.locator(".markdown").first().evaluate(el => {
          const style = getComputedStyle(el), c = document.createElement("canvas").getContext("2d")!;
          c.font = `${style.fontSize} ${style.fontFamily}`;
          return { family: style.fontFamily,
            latinLoaded: document.fonts.check(`${style.fontSize} "JetBrains Mono"`, "Wi01") && document.fonts.check(`600 ${style.fontSize} "JetBrains Mono"`, "Wi01"),
            cjkLoaded: document.fonts.check(`${style.fontSize} "Sarasa Term SC"`, "中英"),
            han: c.measureText("中英").width, wide: c.measureText("WW00").width, narrow: c.measureText("iiii").width };
        });
        expect(metrics.family).toMatch(/^"?JetBrains Mono"?,/); expect(metrics.latinLoaded).toBe(true); expect(metrics.cjkLoaded).toBe(true);
        expect(metrics.wide).toBeCloseTo(metrics.narrow, 1);
        expect(metrics.wide / (size * 4)).toBeCloseTo(.6, 2); // Sarasa's old Latin cell was .5em.
        expect(metrics.han).toBeCloseTo(size * 2, 1); // Chinese retains its original size.
      }
      const row = page.locator(`[data-message-id="${plain.id}"]`);
      const colors = await row.evaluate(row => {
        const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
        const lum = (c: number[]) => c.slice(0, 3).map(v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
        const bg = (e: Element): number[] => {
          const c = rgb(getComputedStyle(e).backgroundColor), underneath = e.parentElement ? bg(e.parentElement) : [255, 255, 255], alpha = c[3] ?? 1;
          return c.slice(0, 3).map((v, i) => v * alpha + underneath[i] * (1 - alpha));
        };
        return [".markdown > .markdown-chunk > p", "h2", "th", "td", "a", "p > code", "blockquote", ".hljs-keyword", ".hljs-string", ".hljs-title", ".hljs-comment"].map(selector => {
          const e = row.querySelector(selector)!; const fg = lum(rgb(getComputedStyle(e).color)), back = lum(bg(e));
          return { selector, color: getComputedStyle(e).color, ratio: (Math.max(fg, back) + .05) / (Math.min(fg, back) + .05) };
        });
      });
      for (const color of colors) expect(color.ratio, `${mode}: ${color.selector}`).toBeGreaterThanOrEqual(4.5);
      expect(new Set(colors.map(c => c.color)).size).toBeGreaterThanOrEqual(4);
      expect(await page.locator(".message-scroll").evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      if (size === 14) await page.screenshot({ path: info.outputPath(`cli-${mode}-${width}.png`), animations: "disabled" });
      // Expansion must use the same type scale as the transcript, not fixed px.
      if (width < 760) {
        await row.getByRole("button", { name: "展开表格", exact: true }).click();
        const reader = page.getByRole("dialog", { name: "表格", exact: true });
        await expect(reader.locator("td").first()).toHaveCSS("font-size", `${size}px`);
        await expect(reader.locator("th").first()).toHaveCSS("font-family", await row.locator("td").first().evaluate(e => getComputedStyle(e).fontFamily));
        await reader.getByRole("button", { name: "关闭表格", exact: true }).click();
      }
      await openSettings(page); await page.locator('input[name="color-palette"][value="mono"]').check();
      await expect(page.getByLabel("主题", { exact: true })).toHaveValue(mode);
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      await closeSettings(page);
    }
    await openSettings(page); await page.locator('input[name="color-palette"][value="mono"]').check(); await closeSettings(page);
    expect(await page.locator("html").evaluate(e => getComputedStyle(e).fontFamily)).not.toContain("Sarasa");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
