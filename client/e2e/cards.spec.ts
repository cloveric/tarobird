import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

test("actual AskUserQuestion, Kimi and config callbacks traverse client, Hub and shared handler", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cards-e2e-")); const stateDir = path.join(root, "instance"); const workspace = path.join(stateDir, "workspace"); await mkdir(workspace, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh", workspacePath: workspace }));
  let hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") }); const secret = randomBytes(32).toString("base64url"); let gateway: GatewayChannel | undefined;
  const decisions: unknown[] = [];
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','表单助手',?,'claude')", [hashSecret(secret)]);
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
      if (input.text.includes("文件预览")) return { text: "```file:验收.html\n<script>window.attachmentExecuted=true</script>\n原文保持完整\n```" };
      if (input.text.includes("图片批次")) {
        const paths = [path.join(workspace, "one.png"), path.join(workspace, "two.png")];
        for (const file of paths) await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64"));
        return { text: "```tool-call\n" + JSON.stringify({ name: "send.batch", payload: { images: paths.map((file, i) => ({ path: file, caption: `图 ${i + 1} · 本机图片` })) } }) + "\n```" };
      }
      const kimi = input.text.includes("Kimi");
      const decision = await input.onApprovalRequest?.({ engine: kimi ? "kimi" : "claude", toolName: "AskUserQuestion", toolInput: { questions: kimi ? [{ question: "选择 Kimi 选项", header: "Kimi 选择", options: [{ label: "红色" }, { label: "蓝色" }] }] : [
        { question: "使用哪种模式？", header: "模式", options: [{ label: "快速" }, { label: "细致" }] },
        { question: "选择两项功能", header: "功能", multiSelect: true, minSelections: 2, maxSelections: 2, options: [{ label: "搜索" }, { label: "导出" }, { label: "分享" }] },
      ] } }); decisions.push(decision); return { text: `表单处理完成 ${decisions.length}` };
    } } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await clickAppAction(page, "新建对话", page.getByRole("button", { name: "新建对话", exact: true }).last()); await page.getByPlaceholder("为这段对话起个名字").fill("真实表单验收"); await page.getByRole("dialog", { name: "新建对话", exact: true }).getByRole("checkbox", { name: /表单助手/ }).check(); await page.getByRole("button", { name: "创建对话", exact: true }).click();
    const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
    await send("请提问"); await page.getByRole("radio", { name: "细致", exact: true }).check(); await page.getByRole("button", { name: "下一题", exact: true }).click(); await page.getByRole("checkbox", { name: "搜索", exact: true }).check(); await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.getByText("所选数量不符合要求", { exact: true })).toBeVisible(); expect(decisions).toHaveLength(0);
    // A custom answer counts toward min/max exactly as in the shared handler.
    await page.locator('textarea[name="q1_other"]').fill("归档"); await page.screenshot({ path: info.outputPath("ask-user-question.png"), fullPage: true });
    await page.getByRole("button", { name: "提交", exact: true }).click(); await expect(page.getByRole("region", { name: "运行回复", exact: true }).getByText("表单处理完成 1", { exact: true })).toBeVisible();
    expect(decisions[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "使用哪种模式？": "细致", "选择两项功能": "搜索, 归档" } } });
    await send("Kimi 提问"); await page.getByRole("radio", { name: "蓝色", exact: true }).check(); await expect(page.locator('textarea[name="q0_other"]')).toHaveCount(0); await page.getByRole("button", { name: "提交", exact: true }).click(); await expect(page.getByRole("region", { name: "运行回复", exact: true }).getByText("表单处理完成 2", { exact: true })).toBeVisible(); expect(decisions[1]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "选择 Kimi 选项": "蓝色" } } });
    await send("图片批次"); await expect(page.getByLabel("图片批次").locator("img")).toHaveCount(2); await expect(page.getByText("图 1 · 本机图片", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "图 1 · 本机图片", exact: true }).click(); await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible(); await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'upload-one.txt', mimeType: 'text/plain', buffer: Buffer.from('first chosen file') });
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'upload-two.txt', mimeType: 'text/plain', buffer: Buffer.from('second chosen file') });
    await expect(page.getByRole('button', { name: '移除 upload-one.txt', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '移除 upload-two.txt', exact: true })).toBeVisible();
    await send("文件预览"); await expect(page.getByRole('region', { name: 'upload-one.txt', exact: true })).toBeVisible(); await expect(page.getByRole('region', { name: 'upload-two.txt', exact: true })).toBeVisible(); const fileCard = page.getByRole("region", { name: "验收.html", exact: true }); await fileCard.getByRole("button", { name: "预览", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "文件预览" }).locator("pre")).toContainText("<script>window.attachmentExecuted=true</script>");
    expect(await page.evaluate(() => "attachmentExecuted" in window)).toBe(false); await page.keyboard.press("Escape");
    const downloaded = page.waitForEvent("download"); await fileCard.getByRole("button", { name: "另存为 验收.html", exact: true }).click(); const file = await downloaded;
    expect(file.suggestedFilename()).toBe("验收.html"); expect(await readFile((await file.path())!, "utf8")).toContain("原文保持完整");
    await send("/config"); await page.getByRole("button", { name: "English", exact: true }).click(); await expect.poll(async () => JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")).locale).toBe("en");
    await page.screenshot({ path: info.outputPath("config.png"), fullPage: true });
    const conversation = (await hub.store.conversations("owner"))[0]!; const imageMessage = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.blocks.some((b) => b.type === "card" && b.elements.some((e) => e.type === "image")))!;
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)); await page.goto(`${hub.url}/#conversation=${conversation.id}&message=${imageMessage.id}`); await expect(page.getByLabel("图片批次").locator("img")).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    // A real stopped origin exercises shell and attachment caching in WebKit too;
    // context.setOffline produces an internal WebKit reload error in this harness.
    const port = Number(new URL(hub.url).port); await hub.close();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("图片批次").locator("img")).toHaveCount(2);
    await expect.poll(() => page.getByLabel("图片批次").locator("img").first().evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
    hub = await HubServer.start({ stateDir: path.join(root, "hub"), port, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
    await expect(page.locator(".connection-pill.online")).toBeVisible({ timeout: 20_000 });

  } finally { await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
