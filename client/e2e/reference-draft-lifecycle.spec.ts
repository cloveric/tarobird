import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { messageAction } from "./fixtures/message-actions.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [1360, 390]) for (const phase of ["draft", "upload"]) test(`a quoted draft follows edits and retains text when its source is deleted during ${phase} (${width}px)`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quoted-draft-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_TEST_CLIENT_DIR ?? path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
  let releaseUpload = () => {};
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "引用草稿验收", "chat");
    const source = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "旧方案" }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, conversation.title);
    await messageAction(page, page.locator(`[data-message-id="${source.id}"]`), "引用回复");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("保留我的补充说明");
    await hub.store.publishBotMessage("alpha", { id: source.id, conversationId: conversation.id, blocks: [{ type: "text", text: "更新后的方案" }] });
    await expect(page.locator(".reply-preview")).toContainText("更新后的方案");
    if (phase === "upload") {
      await page.locator(".composer").evaluate(node => {
        const data = new DataTransfer(); data.items.add(new File(["保留附件内容"], "补充说明.txt", { type: "text/plain" }));
        node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      let uploadStarted = () => {};
      const started = new Promise<void>(resolve => { uploadStarted = resolve; });
      const gate = new Promise<void>(resolve => { releaseUpload = resolve; });
      const put = hub.attachments.putChunk.bind(hub.attachments);
      hub.attachments.putChunk = async (...args) => { uploadStarted(); await gate; return put(...args); };
      await page.getByRole("button", { name: "发送消息", exact: true }).click(); await started;
    }
    await hub.store.publishBotMessage("alpha", { id: source.id, conversationId: conversation.id, blocks: [], status: "deleted" });
    // Deletion clears the quote automatically, while typed text/files stay put.
    await expect(page.locator(".reply-preview")).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${source.id}"]`)).toHaveCount(0);
    releaseUpload();
    await expect(composer).toBeEnabled();
    if (phase === "upload") await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("补充说明.txt");
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await expect(composer).toHaveValue("保留我的补充说明");
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter(message => message.authorType === "user")).toHaveLength(0);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.filter(message => message.authorType === "user").length).toBe(1);
    const sent = (await hub.store.snapshot("owner", conversation.id)).messages.find(message => message.authorType === "user")!;
    expect(sent.replyTo).toBeUndefined();
    expect(sent.blocks).toContainEqual({ type: "text", text: "保留我的补充说明" });
    if (phase === "upload") {
      const file = sent.blocks.find(block => block.type === "file");
      expect(file?.type).toBe("file");
      if (file?.type !== "file") throw new Error("missing_retained_attachment");
      const stored = await hub.attachments.download({ userId: "owner" }, file.attachmentId);
      expect(await readFile(stored.path, "utf8")).toBe("保留附件内容");
    }
  } finally { releaseUpload(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
