import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });

async function pair(page: Page, url: string, hub: HubServer) {
  await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}

test("a card input with only an action ID shows, validates and submits what the reader types", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "card-input-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const submits: Array<{ actionId: string; values: Record<string, unknown> }> = [];
  await page.routeWebSocket("**/ws", ws => {
    const upstream = ws.connectToServer();
    ws.onMessage(message => { if (typeof message === "string" && message.includes('"interaction.submit"')) submits.push(JSON.parse(message)); upstream.send(message); });
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','表单助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "卡片输入", "card_input");
    // Translated Feishu inputs carry an element_id as actionId and often no name.
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", elements: [
      { type: "input", actionId: "note_input", text: "备注", required: true },
      { type: "input", actionId: "owner_input", text: "负责人", extra: { default_value: "预设负责人" } },
      { type: "button", actionId: "submit_note", text: "提交备注", value: { kind: "note" }, extra: { form_action_type: "submit" } },
    ] }] });
    await pair(page, url, hub); await enterMobileChat(page, chat.title);
    const note = page.getByRole("textbox", { name: "备注", exact: true }), owner = page.getByRole("textbox", { name: "负责人", exact: true });
    await expect(owner).toHaveValue("预设负责人");
    await page.getByRole("button", { name: "提交备注", exact: true }).click();
    await expect(page.getByText("请填写所有必填项", { exact: true })).toBeVisible(); expect(submits).toHaveLength(0);
    await note.fill("今天完成复核"); await expect(note).toHaveValue("今天完成复核");
    await owner.fill("另一位负责人"); await expect(owner).toHaveValue("另一位负责人");
    await page.getByRole("button", { name: "提交备注", exact: true }).click();
    await expect.poll(() => submits.length).toBe(1);
    expect(submits[0]).toMatchObject({ actionId: "submit_note", values: { note_input: "今天完成复核", owner_input: "另一位负责人" } });
    expect(submits[0]!.values).not.toHaveProperty("");
    await expect(page.getByText("请填写所有必填项", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await hub.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
