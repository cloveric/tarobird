import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });
const visible = (page: Page) => page.locator('.host-workspace:not([hidden])');
const preview = (page: Page) => page.getByRole("dialog", { name: "文件预览", exact: true });
const hostId = (hub: HubServer) => `hub_${createHash("sha256").update(Buffer.from(hub.auth.publicKey, "base64")).digest("hex")}`;
async function navigate(page: Page, hub: HubServer, conversationId = "same_chat") {
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail })), { hostId: hostId(hub), conversationId });
  await expect(visible(page)).toHaveAttribute("data-active-host", hostId(hub));
  await expect(visible(page).getByRole("heading", { name: conversationId === "other_chat" ? "另一对话" : "附件对话", exact: true })).toBeVisible();
}
async function pair(page: Page, hub: HubServer, name: string, add = false) {
  if (add) await clickAppAction(page, "连接另一台主机", visible(page).getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(hub.url);
  await page.getByRole("textbox", { name: "主机名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(visible(page).locator(".connection-pill.online")).toBeAttached();
}
async function fixture(page: Page, run: (a: HubServer, b: HubServer) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-preview-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    for (const [hub, name] of [[a, "A"], [b, "B"]] as const) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','附件助手','fixture')");
      for (const [id, title] of [["same_chat", "附件对话"], ["other_chat", "另一对话"]]) {
        await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,'direct',?,'owner',1,?)", [id, title, id]);
        await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [id]);
        await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','bot',0)", [id]);
      }
      const pdf = await readFile(path.resolve("e2e/fixtures/pdf/reading.pdf"));
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");
      for (const [filename, mime, bytes] of [["reading.pdf", "application/pdf", pdf], ["delayed.txt", "text/plain", Buffer.from(`${name} private text`)], ["image.png", "image/png", image]] as const) {
        const attachmentId = await hub.attachments.importForBot("bot", { conversationId: "same_chat", name: filename, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
        await hub.store.publishBotMessage("bot", { id: filename.replaceAll(".", "_"), conversationId: "same_chat", blocks: filename === "image.png" ? [{ type: "image", attachmentId, title: `${name} 图片` }] : [{ type: "file", attachmentId, name: filename, mime, size: bytes.length }], status: "complete" });
      }
    }
    await pair(page, a, "主机 A"); await pair(page, b, "主机 B", true);
    await navigate(page, a); await run(a, b);
  } finally { await page.close(); await Promise.all([a.close(), b.close()]); await rm(root, { recursive: true, force: true }); }
}

for (const width of [1360, 390]) test(`notification host switch closes PDF/image previews and releases the PDF worker (${width}px)`, async ({ page }, info) => {
  // Pair using desktop controls, then exercise the intended viewport.
  await fixture(page, async (a, b) => {
    await page.setViewportSize({ width, height: 844 }); await navigate(page, a);
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("A unsent caption");
    await visible(page).getByRole("region", { name: "reading.pdf", exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible();
    expect(page.workers().filter(worker => /pdf\.worker/.test(worker.url()))).toHaveLength(1);
    await navigate(page, b);
    await expect(preview(page)).toHaveCount(0);
    await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
    await visible(page).getByRole("textbox", { name: "消息", exact: true }).fill("B remains writable");
    await page.screenshot({ path: info.outputPath(`after-pdf-switch-${width}.png`) });
    await navigate(page, a);
    await expect(visible(page).getByRole("textbox", { name: "消息", exact: true })).toHaveValue("A unsent caption");
    await expect(preview(page)).toHaveCount(0);
    await visible(page).getByRole("button", { name: "A 图片", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "图片预览", exact: true })).toBeVisible();
    await navigate(page, b); await expect(page.getByRole("dialog", { name: "图片预览", exact: true })).toHaveCount(0);
    await navigate(page, a); await expect(page.getByRole("dialog", { name: "图片预览", exact: true })).toHaveCount(0);
  });
});

test("a late preview download cannot reopen after leaving and returning to its host", async ({ page }) => {
  await fixture(page, async (a, b) => {
    let held = false, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    await page.route(`${a.url}/api/attachments/*`, async route => {
      if (route.request().method() === "GET") { held = true; await barrier; }
      await route.continue().catch(() => undefined);
    });
    try {
      const card = visible(page).getByRole("region", { name: "delayed.txt", exact: true });
      await card.getByRole("button", { name: "预览", exact: true }).click(); await expect.poll(() => held).toBe(true);
      await navigate(page, b); await navigate(page, a); release();
      await expect(card.getByRole("button", { name: "预览", exact: true })).toBeEnabled();
      await expect(preview(page)).toHaveCount(0);
      await card.getByRole("button", { name: "预览", exact: true }).click();
      await expect(preview(page).locator("pre")).toHaveText("A private text");
    } finally { release(); }
  });
});
