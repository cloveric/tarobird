import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { RunJournal } from "../../src/hub/run-journal.js";
import { hashSecret } from "../../src/hub/auth.js";
import { networkId } from "../../src/hub/private-network.js";
import { networkManifestSchema } from "../../src/client-protocol/private-network.js";
import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const english = JSON.parse(await readFile(path.resolve("src/locales/en.json"), "utf8")) as Record<string, string>;
const reviewDir = process.env.WORKSPACE_RAIL_UI_SHOTS;

async function shot(page: Page, info: { outputPath(name: string): string }, name: string) {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (reviewDir) await page.screenshot({ path: path.join(reviewDir, `${name}.png`) });
}

async function noHorizontalOverflow(page: Page, selector?: string) {
  if (selector) {
    expect(await page.locator(selector).first().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function insertBotMessage(hub: HubServer, botId: string, conversationId: string, replyTo: string, blocks: unknown[], status: "complete" | "streaming" = "complete") {
  const message = await hub.store.publishBotMessage(botId, {
    conversationId,
    replyTo,
    blocks: blocks as never,
    status,
  });
  return message.id;
}

for (const locale of ["zh", "en"] as const) for (const phone of [false, true]) {
  test(`conversation workspace rail, bot-to-bot comms and coexistence · ${phone ? "phone" : "desktop"} · ${locale}`, async ({ browser }, info) => {
    const L = (key: string) => locale === "en" ? (english[key] ?? key) : key;
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-rail-ui-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      locale: locale === "en" ? "en-US" : "zh-CN",
      serviceWorkers: "block",
      ...(phone ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const tag = `${phone ? "phone" : "desktop"}-${locale}`;

    try {
      await hub.profile.update({ name: "Example Studio Host", revision: 0 });
      for (const [id, name, engine, model] of [
        ["bot_arch", "Architect", "claude", "claude-sonnet-4-6"],
        ["bot_rev", "Reviewer", "codex", "gpt-5.4"],
        ["bot_res", "Researcher", "pi", "gemini-2.5-pro"],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)",
          [id, name, hashSecret(randomBytes(16).toString("hex")), engine, model],
        );
      }
      const nonce = randomBytes(32).toString("base64url");
      const manifest = networkManifestSchema.parse({
        v: 2,
        id: networkId(hub.auth.publicKey, nonce),
        name: "ExampleNet",
        authorityKey: hub.auth.publicKey,
        genesisNonce: nonce,
        revision: 1,
        hosts: [{ publicKey: hub.auth.publicKey, name: "Example Studio Host", routes: [], protocol: 2, state: "active", revoked: false }],
        devices: [],
        revokedMembers: [],
        blockedBindings: [],
      });
      const membership = { manifest, signature: hub.auth.signNetworkManifest(manifest) };
      await hub.store.db.run(
        "INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
        [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })],
      );
      const guard = async () => undefined;
      await hub.botMessages.grant({ sourceHost: "Example Studio Host", sourceBot: "bot_arch", targetBot: "bot_rev" }, guard);
      await hub.botMessages.grant({ sourceHost: "Example Studio Host", sourceBot: "bot_arch", targetBot: "bot_res" }, guard);

      // Main conversation
      const mainTitle = locale === "en" ? "Workspace Rail Implementation" : "会话工作区开发";
      const mainChat = await hub.store.createConversation("owner", ["bot_arch"], mainTitle, "main-workspace-chat");
      const { message: userMsg } = await hub.store.sendMessage("owner", {
        conversationId: mainChat.id,
        clientMsgId: "cm_main_1",
        text: locale === "en" ? "Coordinate review and benchmark summary." : "请协调评审并汇总基准测试结果。",
        attachments: [],
        mentions: ["bot_arch"],
        previewUrl: null,
      });
      const runId = "run_ws_demo_1";
      const runStart = Date.now() - 12_000;
      const runEnd = Date.now() - 2_000;
      await hub.store.db.run(
        "INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,'owner',?,18420,'text/markdown','workspace-rail-spec.md','att_spec_1.blob',1,?)",
        ["att_spec_1", mainChat.id, "a".repeat(64), runEnd - 1000],
      );
      await hub.store.db.run(
        "INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,'owner',?,4280,'application/json','layout-benchmark.json','att_bench_2.blob',1,?)",
        ["att_bench_2", mainChat.id, "b".repeat(64), runEnd],
      );
      const runMsgId = await insertBotMessage(hub, "bot_arch", mainChat.id, userMsg.id, [
        {
          type: "card",
          title: locale === "en" ? "Workspace implementation" : "工作区实现完成",
          elements: [{ type: "markdown", text: locale === "en" ? "Updated the workspace rail and added live Bot-to-Bot comms tracking." : "已完成会话工作区侧栏并接入实时 Bot 间通信追踪。" }],
          extra: {
            nativeRun: {
              version: 1,
              id: runId,
              revision: 2,
              phase: "done",
              startedAt: runStart,
              updatedAt: runEnd,
              endedAt: runEnd,
              count: 2,
              completed: 2,
              failed: 0,
              truncated: false,
              model: "claude-sonnet-4-6",
            },
            runChanges: {
              v: 1,
              runId,
              revision: 2,
              files: 2,
              edits: 2,
              additions: 14,
              deletions: 3,
              unavailable: 0,
              partial: false,
              childEdits: 0,
            },
          },
        },
        { type: "file", attachmentId: "att_spec_1", name: "workspace-rail-spec.md", size: 18420, mime: "text/markdown" },
        { type: "file", attachmentId: "att_bench_2", name: "layout-benchmark.json", size: 4280, mime: "application/json" },
      ]);
      await new RunJournal(hub.store).write("bot_arch", {
        conversationId: mainChat.id,
        messageId: runMsgId,
        runId,
        entries: [
          {
            seq: 1,
            revision: 1,
            kind: "tool",
            status: "done",
            at: runStart + 2000,
            endedAt: runStart + 5000,
            name: "edit_file",
            changes: [
              {
                path: "client/src/ConversationWorkspace.tsx",
                diff: [
                  "@@ -12,6 +12,14 @@ export function ConversationWorkspace({",
                  "   const [tab, setTab] = useState<WorkspaceTab>(\"overview\");",
                  "-  const [expanded, setExpanded] = useState(false);",
                  "+  const [expandedComms, setExpandedComms] = useState<ReadonlySet<string>>(() => new Set());",
                  "+  const needsApproval = comms?.summary.needsApproval ?? 0;",
                  "+  const activeComms = comms?.summary.active ?? 0;",
                  "+  const artifactsCount = diffMessages.length + workbenchItems.length + files.length;",
                  "+  const toggleCommExpand = (itemId: string) => {",
                  "+    setExpandedComms(prev => {",
                  "+      const next = new Set(prev);",
                  "+      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);",
                  "+      return next;",
                  "+    });",
                  "+  };",
                ].join("\n"),
              },
            ],
          },
          {
            seq: 2,
            revision: 2,
            kind: "tool",
            status: "done",
            at: runStart + 6000,
            endedAt: runEnd,
            name: "edit_file",
            changes: [
              {
                path: "src/hub/bot-messages.ts",
                diff: [
                  "@@ -958,4 +958,8 @@ export class BotMessages {",
                  "-  // legacy outgoing trace",
                  "-  // no live status join",
                  "+  async listConversationComms(userId: string, conversationId: string, guard?: Guard) {",
                  "+    const ownHost = await this.ownSource();",
                  "+    return this.store.db.serial(async () => {",
                  "+      await guard?.(); await this.store.requireMember(userId, conversationId);",
                ].join("\n"),
              },
            ],
          },
        ],
      });
      await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [userMsg.id, "bot_arch"]);

      // Bot-to-Bot delegation #1: Architect -> Reviewer (pending approval card!)
      const revTarget = await hub.botMessages.local(
        { operation: "resolve", host: "Example Studio Host", bot: "bot_rev", requestId: randomUUID(), contextMessage: userMsg.id, data: {} },
        "bot_arch",
        guard,
      ) as { conversationId: string };
      const revSent = await hub.botMessages.local(
        { operation: "send", host: "Example Studio Host", bot: "bot_rev", conversation: revTarget.conversationId, requestId: "req-ui-rev", contextMessage: userMsg.id, data: { text: locale === "en" ? "Run the full regression suite and verify auth checks." : "运行完整回归测试并检查鉴权逻辑。" } },
        "bot_arch",
        guard,
      ) as { messageId: string };
      await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [revSent.messageId, "bot_rev"]);
      await insertBotMessage(hub, "bot_rev", revTarget.conversationId, revSent.messageId, [{
        type: "card",
        title: locale === "en" ? "Approve shell command" : "请求执行命令审批",
        elements: [
          { type: "markdown", text: "npm run test:regression -- --reporter=verbose" },
          { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "perm-ui-1", decision: "allow_once" } },
        ],
      }], "streaming");

      // Bot-to-Bot delegation #2: Architect -> Researcher (completed with reply!)
      const resTarget = await hub.botMessages.local(
        { operation: "resolve", host: "Example Studio Host", bot: "bot_res", requestId: randomUUID(), contextMessage: userMsg.id, data: {} },
        "bot_arch",
        guard,
      ) as { conversationId: string };
      const resSent = await hub.botMessages.local(
        { operation: "send", host: "Example Studio Host", bot: "bot_res", conversation: resTarget.conversationId, requestId: "req-ui-res", contextMessage: userMsg.id, data: { text: locale === "en" ? "Summarize layout benchmark numbers." : "整理布局基准数据。" } },
        "bot_arch",
        guard,
      ) as { messageId: string };
      await insertBotMessage(hub, "bot_res", resTarget.conversationId, resSent.messageId, [
        { type: "text", text: locale === "en" ? "Verified: 320px rail adds 0ms layout shift and fits 1360px cleanly." : "已验证：320px 侧栏无布局抖动，1360px 下三栏比例舒适。" },
      ], "complete");
      await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [resSent.messageId, "bot_res"]);

      // Pair & open app
      await page.goto(hub.url);
      if (locale === "en") {
        const invitation = await fixtureInvitation(hub);
        await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
        await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
        await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
      } else {
        await page.getByLabel("主机名称", { exact: true }).fill("Example Studio Host");
        await preparePairing(page, hub);
      }
      await page.getByRole("button", { name: L("配对此设备"), exact: true }).click();
      await hub.auth.approve(await page.getByLabel(L("配对码"), { exact: true }).innerText(), "local-owner");
      await page.getByLabel(L("配对码"), { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page);

      // Select the main conversation
      if (phone) {
        const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
        await home.getByRole("navigation", { name: L("主导航") }).getByRole("button", { name: new RegExp(`^${L("消息")}`) }).click();
        await home.locator(".mh-row").filter({ has: page.getByText(mainTitle, { exact: true }) }).click();
      } else {
        await page.locator(".conversation-row").filter({ has: page.getByText(mainTitle, { exact: true }) }).click();
      }
      await expect(page.getByRole("heading", { name: mainTitle, exact: true, level: 1 })).toBeVisible();

      // On phone viewports, the Conversation Workspace entry and rail stay hidden to keep mobile clean.
      const trigger = page.getByRole("button", { name: L("会话工作区"), exact: true });
      if (phone) {
        await expect(trigger).toHaveCount(0);
        await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);
        expect(errors).toEqual([]);
        return;
      }

      // Desktop: Workspace trigger is closed by default and shows the amber approval alert badge ("1").
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger.locator(".workspace-rail-trigger-badge.is-alert")).toHaveText("1");

      // Open Workspace Rail
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const container = page.locator("aside.conversation-workspace-rail");
      await expect(container).toBeVisible();
      // Light rail does NOT trigger desktop side-panel window expansion.
      await expect(page.locator(".app-shell")).not.toHaveClass(/has-side-panel/);

      // Overview tab: Waiting for you + Who is helping you + Doing now + Bot-to-Bot (with avatars) + What was made,
      // fitting cleanly in a single desktop viewport (zero vertical overflow!)
      await expect(container).toContainText("Example Studio Host");
      await expect(container).toContainText("Claude Sonnet 4.6");
      await expect(container).toContainText("Architect");
      await expect(container).toContainText("Reviewer");
      await expect(container).toContainText(L("等你确认"));
      await expect(container).toContainText(L("等你同意"));
      await expect(container).toContainText("Researcher");
      await expect(container).toContainText(L("已回复"));
      await expect(container).toContainText("workspace-rail-spec.md");
      // Bot-to-Bot comms is the ONE block with Bot avatars; Who is helping you has no Bot avatar.
      await expect(container.locator(".workspace-env-card .profile-avatar")).toHaveCount(0);
      await expect(container.locator(".workspace-comm-card").first().locator(".workspace-comm-route .profile-avatar")).toHaveCount(2);
      // First-use "?" help popover opens and closes cleanly.
      const whoHelp = container.getByRole("button", { name: L("说明：{0}").replace("{0}", L("谁在帮你")) });
      await whoHelp.click();
      await expect(container.locator(".ws-help-popover")).toBeVisible();
      await container.getByRole("button", { name: L("关闭说明") }).click();
      await expect(container.locator(".ws-help-popover")).toHaveCount(0);

      await noHorizontalOverflow(page, phone ? ".conversation-workspace-sheet" : ".conversation-workspace-rail");
      if (!phone) {
        const fitsWithoutScroll = await container.locator(".workspace-body").evaluate(node => node.scrollHeight <= node.clientHeight + 1);
        expect(fitsWithoutScroll).toBe(true);
      }
      await shot(page, info, `${tag}-overview`);

      // Expand details inline on the completed comm
      const expandButtons = container.getByRole("button", { name: L("展开详情"), exact: true });
      await expandButtons.last().click();
      await expect(container).toContainText(locale === "en" ? "Verified: 320px rail" : "已验证：320px 侧栏");

      // Switch to Bot Comms tab and filter
      await container.getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
      await expect(container.getByRole("button", { name: new RegExp(L("进行中 / 等你同意")) })).toBeVisible();
      await container.getByRole("button", { name: new RegExp(L("进行中 / 等你同意")) }).click();
      await expect(container.locator(".workspace-comm-card")).toHaveCount(1);
      await expect(container).toContainText("Reviewer");
      await shot(page, info, `${tag}-comms`);

      // Switch to Files tab — verify both recorded run diff trigger and conversation files appear
      await container.getByRole("tab", { name: new RegExp(`^${L("文件")}`) }).click();
      // The tabs name the panel they show, and the panel is labelled by the selected tab.
      const filesTab = container.getByRole("tab", { name: new RegExp(`^${L("文件")}`) });
      await expect(container.getByRole("tabpanel")).toHaveAttribute("id", (await filesTab.getAttribute("aria-controls"))!);
      await expect(container.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await filesTab.getAttribute("id"))!);
      await expect(container).toContainText("workspace-rail-spec.md");
      await expect(container).toContainText("layout-benchmark.json");
      // The turn's changes are listed by file name, each with its own counts, on desktop and phone alike.
      const diffButton = container.getByRole("button", { name: /ConversationWorkspace\.tsx \+11 -1.*bot-messages\.ts \+4 -2/ });
      await expect(diffButton).toBeVisible();
      await noHorizontalOverflow(page, phone ? ".conversation-workspace-sheet" : ".conversation-workspace-rail");
      if (!phone) {
        const filesFitWithoutScroll = await container.locator(".workspace-body").evaluate(node => node.scrollHeight <= node.clientHeight + 1);
        expect(filesFitWithoutScroll).toBe(true);
      }
      await shot(page, info, `${tag}-files`);

      // Click the recorded run diff trigger from inside Workspace Rail to open RunDiffViewer
      await diffButton.click();
      const diffDialog = page.getByRole("dialog").filter({ hasText: "ConversationWorkspace.tsx" });
      await expect(diffDialog).toBeVisible();
      await expect(diffDialog).toContainText("bot-messages.ts");
      await shot(page, info, `${tag}-diff`);
      await page.keyboard.press("Escape");
      await expect(diffDialog).toBeHidden();

      // Desktop mutual exclusion: opening Workbench hides Workspace Rail; closing Workbench restores it!
      if (!phone) {
        const workbenchBtn = page.getByRole("button", { name: L("工作台"), exact: true });
        await workbenchBtn.click();
        await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);
        await workbenchBtn.click();
        await expect(page.locator("aside.conversation-workspace-rail")).toBeVisible();
        // The rail opened in front of the Workbench hands it back when the rail closes.
        await workbenchBtn.click();
        await expect(workbenchBtn).toHaveAttribute("aria-expanded", "true");
        await trigger.click();
        await expect(container).toBeVisible();
        await expect(workbenchBtn).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Escape");
        await expect(container).toHaveCount(0);
        await expect(workbenchBtn).toHaveAttribute("aria-expanded", "true");
        await workbenchBtn.click();
        await expect(workbenchBtn).toHaveAttribute("aria-expanded", "false");
        await trigger.click();
        await expect(container).toBeVisible();
      }

      if (!phone) {
        // A narrow desktop window gives the reading column the sidebar's room, as the details panel does,
        // and the header entry is its icon so the title stays readable.
        await page.setViewportSize({ width: 900, height: 900 });
        await expect(container).toBeVisible();
        await expect(page.locator(".app-shell > .sidebar")).toBeHidden();
        await expect(trigger.locator(".workspace-rail-trigger-label")).toBeHidden();
        const narrow = await page.evaluate(() => ({ main: document.querySelector("main")!.getBoundingClientRect().width, title: document.querySelector(".conversation-header .chat-identity>span[title]")!.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth - innerWidth }));
        expect(narrow.main).toBeGreaterThanOrEqual(480); expect(narrow.title).toBeGreaterThanOrEqual(60); expect(narrow.overflow).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1360, height: 900 });
        await expect(page.locator(".app-shell > .sidebar")).toBeVisible(); await expect(trigger.locator(".workspace-rail-trigger-label")).toBeVisible();
        // The rail has no Stop control of its own; stopping stays with the tasks dialog.
        await expect(container.locator(".workspace-stop-btn")).toHaveCount(0);
      }

      // Jump directly to the approval collaboration conversation, with the files narrowed to this one's changes.
      await container.getByRole("tab", { name: new RegExp(`^${L("文件")}`) }).click();
      await container.getByRole("button", { name: new RegExp(`^${L("代码改动")}`) }).click();
      await container.getByRole("tab", { name: new RegExp(L("总览")) }).click();
      await container.getByRole("button", { name: L("去批准"), exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Architect");
      // The other conversation has no changes: its files page starts from "all", not from an empty filter.
      await container.getByRole("tab", { name: new RegExp(`^${L("文件")}`) }).click();
      await expect(container.getByRole("button", { name: new RegExp(`^${L("代码改动")}`) })).toHaveCount(0);
      await expect(container.getByRole("button", { name: new RegExp(`^${L("全部")}`) })).toHaveAttribute("aria-pressed", "true");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
