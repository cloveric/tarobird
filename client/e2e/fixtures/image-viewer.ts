import { preparePairing } from "./pairing-invite.js";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./mobile.js";

export async function imageViewerFixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-gestures-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('photo','图片助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["photo"], "图片手势", "photos");
    await page.goto(hub.url);
    const originals: Buffer[] = [], images = [];
    for (const [title, width, height, color] of [["第一张", 1600, 900, "#b23432"], ["第二张", 1200, 1200, "#28774a"], ["长图", 720, 7200, "#254eb2"], ["另一条消息", 800, 600, "#873fc1"]] as const) {
      const bytes = Buffer.from(await page.evaluate(({width,height,color}) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "white"; ctx.font = "40px sans-serif"; ctx.fillText(`${width} × ${height}`, 30, 70);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, {width,height,color}), "base64");
      originals.push(bytes);
      const id = await hub.attachments.importForBot("photo", { conversationId: chat.id, name: title + ".png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      images.push({ type: "image" as const, attachmentId: id, title });
    }
    const batch = await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "text", text: "同一气泡的三张图" }, { type: "card", elements: images.slice(0, 3).map(image => ({ type: "image", attachmentId: image.attachmentId, text: image.title })) }] });
    const separate = await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [images[3]!] });
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    return { originals, batch, separate, hub, chat, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
