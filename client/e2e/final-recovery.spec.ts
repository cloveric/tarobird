import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { gatewayCrashFixture } from "../../tests/helpers/gateway-crash-fixture.js";
import { readDeliveryObligationContent, readDeliveryObligations } from "../../src/state/delivery-obligation-store.js";
import { recoveredReplyMarker } from "../../src/core/delivery-recovery.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  await selectConversation(page, "长回复恢复验收");
}
async function cached(page: Page, id: string) {
  return page.evaluate(async ({id,databaseName}) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    try {
      const value = await new Promise<{ status: string; blocks: unknown[] } | undefined>((resolve, reject) => { const request = db.transaction("messages").objectStore("messages").get(id); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      if (!value) return null;
      const bytes = new TextEncoder().encode(JSON.stringify(value.blocks)), digest = await crypto.subtle.digest("SHA-256", bytes);
      return { status: value.status, bytes: bytes.length, hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    } finally { db.close(); }
  }, {id,databaseName:await singleHostCacheName(page)});
}
test("a killed process recovers a full long reply to both devices before retiring its interrupted input", async ({ browser }, info) => {
  test.setTimeout(60000);
  const root = await mkdtemp(path.join(os.tmpdir(), "client-final-recovery-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const text = "# 长回复恢复验收\n\n" + "恢复正文".repeat(90000) + Array.from({ length: 10 }, (_, i) => `\n\n### 校验 ${i + 1}\n\n| 项目 | 结果 |\n| --- | --- |\n| 表格 ${i + 1} | 完整 |`).join("") + "\n\n$$x^2+y^2=z^2$$\n\nLONG_LEDGER_END";
  const responseFile = path.join(root, "response.txt"); await writeFile(responseFile, text);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','长文助手',?)", [hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha"], "长回复恢复验收", "create");
  const options = { stateDir, responseFile, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret };
  let fixture = gatewayCrashFixture({ ...options, crash: true });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), errors: string[] = [];
  for (const page of [desktop, phone]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    await expect.poll(() => fixture.messages, { timeout: 15000 }).toContain("ready");
    await pair(desktop, hub); await pair(phone, hub);
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("请生成长报告"); await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => fixture.messages, { timeout: 15000 }).toContain("before-publish");
    const obligation = (await readDeliveryObligations(stateDir))[0]!;
    expect(obligation.contentRef?.bytes).toBeGreaterThan(1024 * 1024);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(digest(await readDeliveryObligationContent(stateDir, obligation))).toBe(digest(text));
    expect(JSON.stringify(await hub.store.snapshot("owner", c.id))).not.toContain("LONG_LEDGER_END");
    await fixture.kill(); fixture = gatewayCrashFixture({ ...options, crash: false });
    await expect.poll(() => fixture.messages, { timeout: 15000 }).toContain("boot-complete");
    await expect.poll(async () => (await hub.store.pendingForBot("alpha")).length).toBe(0);
    const matches = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => blocksText(m.blocks).includes("LONG_LEDGER_END")); expect(matches).toHaveLength(1);
    const message = matches[0]!, body = JSON.stringify(message.blocks), expected = { status: "complete", bytes: Buffer.byteLength(body), hash: createHash("sha256").update(body).digest("hex") };
    // Shared TaroCub presentation intentionally normalizes headings and simple
    // math. The saved original above stays exact; only display uses these rules.
    const displayed = text.replace(/^#{1,6} (.+)$/gm, "**$1**").replace("$$x^2+y^2=z^2$$", "x^2+y^2=z^2");
    expect(digest(blocksText(message.blocks))).toBe(digest(`${recoveredReplyMarker("zh")}\n\n${displayed}`)); expect(fixture.messages).not.toContain("engine");
    for (const [page, name] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await expect.poll(() => cached(page, message.id), { timeout: 20000 }).toEqual(expected);
      const article = page.locator(`[data-message-id="${message.id}"]`);
      await expect(article.locator("table")).toHaveCount(10, { timeout: 20000 }); await expect(article.getByText("x^2+y^2=z^2", { exact: true })).toBeVisible(); await expect(article).toContainText("♻️");
      await article.getByText("LONG_LEDGER_END", { exact: true }).scrollIntoViewIfNeeded(); await expect(article.getByText("LONG_LEDGER_END", { exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`final-recovery-${name}.png`) });
    }
    await fixture.kill(); fixture = gatewayCrashFixture({ ...options, crash: false }); await expect.poll(() => fixture.messages, { timeout: 15000 }).toContain("boot-complete");
    expect((await hub.store.snapshot("owner", c.id)).messages.filter((m) => blocksText(m.blocks).includes("LONG_LEDGER_END"))).toHaveLength(1);
    for (const page of [desktop, phone]) await expect.poll(() => cached(page, message.id)).toEqual(expected);
    expect(fixture.messages).not.toContain("engine"); expect(errors).toEqual([]);
    await info.attach("durable-final-recovery", { body: JSON.stringify({ storedBytes: expected.bytes, hash: expected.hash, devices: 2, tables: 10, formulas: 1, injectedFault: "SIGKILL before publication", repeatedBootCopies: 1 }), contentType: "application/json" });
  } finally { await fixture.kill(); await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
