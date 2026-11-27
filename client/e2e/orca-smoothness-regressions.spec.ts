import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, waitForClientOnline, selectConversation } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

test("message headers preserve duplicate-bot disambiguation suffixes and deleted-bot labels", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orca-bot-labels-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    const botA = "bot_dup_aaa111";
    const botB = "bot_dup_bbb222";
    const botDel = "bot_old_ccc333";
    await hub.store.db.run(
      "INSERT INTO bots(id,name,secret_hash,online) VALUES(?,'研究助手','f',1),(?,'研究助手','f',1),(?,'旧助手','f',1)",
      [botA, botB, botDel],
    );
    const group = await hub.store.createConversation("owner", [botA, botB, botDel], "同名与已删群", "dup-group");
    await hub.store.publishBotMessage(botA, { conversationId: group.id, blocks: [{ type: "text", text: "来自一号" }], status: "complete" });
    await hub.store.publishBotMessage(botB, { conversationId: group.id, blocks: [{ type: "text", text: "来自二号" }], status: "complete" });
    await hub.store.publishBotMessage(botDel, { conversationId: group.id, blocks: [{ type: "text", text: "来自旧助手" }], status: "complete" });
    await hub.store.db.run("UPDATE bots SET deleted_at=?, online=0 WHERE id=?", [Date.now(), botDel]);

    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await showDisconnectedBots(page);

    await selectConversation(page, group.title);
    await expect(page.locator(".message-meta strong")).toHaveCount(3);
    const headers = await page.locator(".message-meta strong").allTextContents();
    expect(headers).toEqual([
      "研究助手 · aaa111",
      "研究助手 · bbb222",
      "旧助手（已删除）",
    ]);
  } finally {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global-event-hub honors preventDefault() on active touchstart and passive-to-active upgraded wheel listeners", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html");
    const result = await page.evaluate(async () => {
      const modulePath = "/src/global-event-hub.ts";
      const mod = await import(/* @vite-ignore */ modulePath) as typeof import("../src/global-event-hub.js");

      const offWheelPassive = mod.addGlobalListener(window, "wheel", () => {}, { capture: true, passive: true });
      const offWheelActive = mod.addGlobalListener(window, "wheel", (event) => {
        event.preventDefault();
      }, { capture: true, passive: false });
      const wheelEvent = new WheelEvent("wheel", { cancelable: true, bubbles: true, deltaY: 10 });
      window.dispatchEvent(wheelEvent);

      const offTouchActive = mod.addGlobalListener(document, "touchstart", (event) => {
        event.preventDefault();
      }, { passive: false });
      const touchEvent = new Event("touchstart", { cancelable: true, bubbles: true });
      document.dispatchEvent(touchEvent);

      offWheelActive();
      // After downgrading back to passive, calling preventDefault in the remaining passive listener is ignored.
      const offWheelPassivePrevent = mod.addGlobalListener(window, "wheel", (event) => {
        event.preventDefault();
      }, { capture: true, passive: true });
      const passiveWheelEvent = new WheelEvent("wheel", { cancelable: true, bubbles: true, deltaY: 10 });
      window.dispatchEvent(passiveWheelEvent);

      offWheelPassive();
      offWheelPassivePrevent();
      offTouchActive();

      return {
        wheelPrevented: wheelEvent.defaultPrevented,
        touchPrevented: touchEvent.defaultPrevented,
        downgradedWheelPrevented: passiveWheelEvent.defaultPrevented,
      };
    });

    expect(result).toEqual({
      wheelPrevented: true,
      touchPrevented: true,
      downgradedWheelPrevented: false,
    });
  } finally {
    await server.close();
  }
});
