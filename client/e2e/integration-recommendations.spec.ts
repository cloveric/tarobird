import { test, expect } from "@playwright/test";
import path from "node:path";
import { blocksText } from "../../src/client-protocol/index.js";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

for (const choice of ["skip", "configure", "configure-delayed"] as const) test(`first local Bot recommendations are optional and scoped (${choice})`, async ({ page }, info) => {
  test.setTimeout(120_000);
  const fixture = await noviceNetworkFixture({ entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } });
  const local = fixture.hubs[1]!;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(fixture.origin + "__novice");
    await page.getByRole("button", { name: "将这台电脑设为主机", exact: true }).click();
    await waitForClientOnline(page);
    await clickAppAction(page, "新建 Bot");
    await page.getByLabel("Bot 名称", { exact: true }).fill("本机助手");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    const card = page.locator(".bot-created .integration-recommendations");
    await expect(card).toBeVisible();
    await expect(card.getByRole("checkbox")).toHaveCount(3);
    await expect(card.getByRole("checkbox").nth(0)).toBeChecked();
    await expect(card.getByRole("checkbox").nth(1)).toBeChecked();
    await expect(card.getByRole("checkbox").nth(2)).not.toBeChecked();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible();
    expect(await local.store.conversations("owner")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("first-local-bot-recommendations.png"), fullPage: true });
    if (choice === "skip") {
      await page.getByRole("button", { name: "跳过，开始对话", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
      const conversations = await local.store.conversations("owner"); expect(conversations).toHaveLength(1);
      expect((await local.store.snapshot("owner", conversations[0]!.id)).messages).toHaveLength(0);
      // It is a first-host suggestion, not a repeated step for every Bot.
      await clickAppAction(page, "新建 Bot");
      await page.getByLabel("Bot 名称", { exact: true }).fill("第二位助手");
      await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
      await expect(page.getByText("第二位助手 已创建", { exact: true })).toBeVisible();
      await expect(card).toHaveCount(0);
      await page.getByRole("button", { name: "开始对话", exact: true }).click();
    } else {
      // Deselection must control both the button and the actual prepared task.
      await card.getByRole("checkbox").nth(0).uncheck();
      await card.getByRole("checkbox").nth(1).uncheck();
      await expect(card.getByRole("button", { name: "让 Bot 协助配置", exact: true })).toBeDisabled();
      await card.getByRole("checkbox").nth(1).check();
      if (choice === "configure") await card.getByRole("checkbox").nth(2).check();
      if (choice === "configure-delayed") await card.getByRole("checkbox").nth(0).check();
      await card.getByRole("button", { name: "让 Bot 协助配置", exact: true }).click();
      const preview = page.getByRole("textbox", { name: "配置消息", exact: true });
      await expect(preview).toHaveValue(/Tavily \+ Brave/);
      if (choice === "configure") await expect(preview).toHaveValue(/通义听悟适配器/);
      if (choice === "configure-delayed") await expect(preview).toHaveValue(/Qwen3-ASR/);
      else await expect(preview).not.toHaveValue(/Qwen3-ASR/);
      await expect(preview).toHaveValue(/TAVILY_API_KEY \/ BRAVE_API_KEY/);
      await expect(preview).toHaveValue(/不要让我把密钥发到聊天里/);
      expect(await local.store.conversations("owner")).toHaveLength(0);
      const draft = await preview.inputValue();
      if (choice === "configure-delayed") await page.evaluate(async () => {
        const modulePath = "/src/storage.ts", { ClientCache } = await import(modulePath);
        const save = ClientCache.prototype.saveDraft, read = ClientCache.prototype.draft;
        const gate = (window as any).setupDraftGate = { id: "", emptyRead: false, release: undefined as undefined | (() => void), releaseRead: undefined as undefined | (() => void) };
        ClientCache.prototype.saveDraft = async function(id: string, text: string) {
          if (!gate.id) { gate.id = id; await new Promise<void>(resolve => { gate.release = resolve; }); }
          return save.call(this, id, text);
        };
        ClientCache.prototype.draft = async function(id: string) {
          const text = await read.call(this, id);
          if (id === gate.id && text === "" && !gate.emptyRead) {
            gate.emptyRead = true;
            await new Promise<void>(resolve => { gate.releaseRead = resolve; });
          }
          return text;
        };
      });
      await page.getByRole("button", { name: "打开配置对话", exact: true }).click();
      if (choice === "configure-delayed") {
        // First-chat discovery can select the conversation before its draft is saved.
        await expect.poll(() => page.evaluate(() => (window as any).setupDraftGate.emptyRead)).toBe(true);
        await page.evaluate(() => (window as any).setupDraftGate.release());
      }
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(draft);
      const conversations = await local.store.conversations("owner"); expect(conversations).toHaveLength(1);
      expect((await local.store.snapshot("owner", conversations[0]!.id)).messages).toHaveLength(0);
      if (choice === "configure-delayed") {
        const composer = page.getByRole("textbox", { name: "消息", exact: true });
        await expect(composer).toBeFocused();
        // An earlier empty read may finish even after the persisted handoff.
        await page.evaluate(async () => {
          (window as any).setupDraftGate.releaseRead();
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        await expect(composer).toHaveValue(draft);
        const confirmedText = draft + "\n请先检查，不要重复安装。";
        await composer.fill(confirmedText);
        await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
        await page.screenshot({ path: info.outputPath("first-config-draft-ready.png") });
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect.poll(async () => (await local.store.snapshot("owner", conversations[0]!.id)).messages.filter(message => message.authorType === "user").map(message => blocksText(message.blocks))).toEqual([confirmedText]);
        await expect(composer).toHaveValue("");
      }
    }
    // The permanent entry also works in the narrow layout after skipping.
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspacePage(page, "Skills 与 MCP");
    await page.locator(".capabilities-overview > summary").click();
    await page.getByText("语音与搜索建议（可选）", { exact: true }).click();
    const later = page.locator(".capabilities-panel .integration-recommendations");
    await expect(later).toBeVisible();
    await expect(later.getByRole("button", { name: "让 Bot 协助配置", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("later-setup-phone.png"), fullPage: true });
    await later.getByRole("checkbox").nth(1).uncheck();
    await later.getByRole("button", { name: "让 Bot 协助配置", exact: true }).click();
    const preview = page.getByRole("textbox", { name: "配置消息", exact: true });
    await expect(preview).toHaveValue(/Qwen3-ASR-0.6B/);
    await expect(preview).toHaveValue(/默认优先使用内置硬盘；空间不足或用户已指定外置存储时/);
    await expect(preview).toHaveValue(/Windows/);
    await expect(preview).not.toHaveValue(/TAVILY_API_KEY/);
    await page.getByRole("button", { name: "关闭配置消息", exact: true }).click();
    // Cancelling the preview creates no conversation or message, on either host.
    expect(await local.store.conversations("owner")).toHaveLength(choice === "skip" ? 2 : 1);
    expect(await fixture.hubs[0]!.store.conversations("owner")).toHaveLength(0);
    if (choice === "configure") {
      await later.getByRole("checkbox").nth(1).check();
      await page.evaluate(async () => {
        const modulePath = "/src/i18n.ts"; (await import(modulePath)).setLocale("en");
        document.documentElement.dataset.theme = "dark";
      });
      await expect(later.getByRole("heading", { name: "Voice and search recommendations", exact: true })).toBeVisible();
      const action = later.getByRole("button", { name: "Set up with Bot", exact: true });
      const foreground = await action.evaluate(button => {
        const probe = document.createElement("span"); probe.style.color = "var(--on-primary)";
        button.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
      });
      await expect(action).toHaveCSS("color", foreground);
      await page.screenshot({ path: info.outputPath("later-setup-english-dark.png"), fullPage: true, animations: "disabled" });
      await action.click();
      const english = page.getByRole("textbox", { name: "Setup message", exact: true });
      await expect(english).toHaveValue(/Qwen3-ASR-0.6B/);
      await expect(english).toHaveValue(/Tavily \+ Brave/);
      await expect(english).toHaveValue(/internal disk by default; use a mounted external disk when space is insufficient or the user has chosen external storage/);
    }
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});
