import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { CardElement } from "../../src/client-protocol/index.js";
import { crossHostDispatchGrantCommandSchema, defaultDispatcherSettings } from "../../src/client-protocol/dispatch.js";
import { networkCanonical, type NetworkManifest } from "../../src/client-protocol/private-network.js";
import { LocalHostClient } from "../../src/host-cli/client.js";
import { initializeHost } from "../../src/host-cli/setup.js";
import { hashSecret } from "../../src/hub/auth.js";
import { messageHostId } from "../../src/hub/bot-messages.js";
import { desktopTls } from "../../src/hub/desktop-tls.js";
import { networkId } from "../../src/hub/private-network.js";
import { HubServer } from "../../src/hub/server.js";
import { startHubControl } from "../../src/hub/service.js";
import { loadHubTls } from "../../src/hub/tls.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { closeSettings, openSettings } from "./fixtures/settings.js";

test.use({ ignoreHTTPSErrors: true, serviceWorkers: "block" });

for (const kind of ["approval", "answer"] as const) test(`the receiving owner opens the remote ticket from settings and submits its ${kind}`, async ({ page }) => {
  const root = await mkdtemp(path.join(tmpdir(), "d-ra-"));
  const aDir = path.join(root, "a"), bDir = path.join(root, "b");
  const a = await HubServer.start({ stateDir: aDir });
  let b: HubServer | undefined, socket: WebSocket | undefined, closeControl: (() => Promise<void>) | undefined;
  try {
    const address = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)?.address;
    if (!address) throw new Error("Cross-host fixture requires a non-loopback IPv4 interface");
    await initializeHost(bDir, "Receiving fixture");
    const cert = await desktopTls(root, [address]);
    b = await HubServer.start({
      stateDir: bDir, host: address, tls: await loadHubTls({ cert: cert.cert, key: cert.key }),
      exposure: "public", clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist"),
    });
    const receiver = b;
    const sourceHost = messageHostId(a.auth.publicKey), receivingHost = messageHostId(b.auth.publicKey);
    const route = { name: "Direct" as const, url: b.url, certificateAuthority: cert.certificateAuthority };
    const nonce = randomBytes(32).toString("base64url");
    const manifest: NetworkManifest = {
      v: 2, id: networkId(a.auth.publicKey, nonce), authorityKey: a.auth.publicKey, genesisNonce: nonce, name: "Dispatch fixture",
      revision: 1, devices: [], revokedMembers: [], blockedBindings: [],
      hosts: [
        { publicKey: a.auth.publicKey, name: "Source fixture", routes: [], protocol: 2, state: "active", revoked: false },
        { publicKey: b.auth.publicKey, name: "Receiving fixture", routes: [route], protocol: 2, state: "active", revoked: false },
      ],
    };
    const membership = { manifest, signature: a.auth.signNetworkManifest(manifest) };
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({
        v: 1, routes: hub === b ? [route] : [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [],
        admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false,
      })]);
    }
    closeControl = await startHubControl(bDir, { running: true, pid: process.pid, url: b.url, instanceUrl: b.instanceUrl, publicKey: b.auth.publicKey },
      () => {}, { enrollController: value => receiver.enrollLocalController(value) });
    const controller = await LocalHostClient.connect(bDir, { enroll: true });
    try {
      const command = crossHostDispatchGrantCommandSchema.parse({ operation: "cross-host-dispatch-grant", sourceHost, sourceBot: "dispatcher", allowed: true });
      const proof = await controller.deviceAction({ operation: "bot-message-grant", target: createHash("sha256").update(networkCanonical(command)).digest("hex") });
      await controller.request("/api/dispatch/cross-host-grants", "POST", { command, proof });
    } finally { controller.close(); }

    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('dispatcher','Fixture dispatcher','fixture','codex','dispatcher')");
    await a.store.createConversation("owner", ["dispatcher"], "Fixture dispatch inbox", "fixture_inbox");
    const settings = await a.dispatch.settings("owner", "dispatcher");
    await a.dispatch.updateSettings("owner", "dispatcher", { expectedRevision: settings.revision, settings: {
      ...defaultDispatcherSettings(), mode: "auto",
      nodes: [{ hostId: receivingHost, enabled: true, maxConcurrent: 1, preference: "normal" }],
    } });
    const workers = {
      catalog: async () => ({ engines: [{ id: "codex" as const, available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" }] }),
      dispatchWorker: async () => "fixture_worker",
      ticketWorkspace: async () => root,
      remoteDispatchWorker: async () => "fixture_worker",
      remoteTicketWorkspace: async () => root,
    };
    a.dispatch.workers = workers;
    b.dispatch.workers = workers;
    const secret = randomBytes(32).toString("base64url");
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('fixture_worker','Remote fixture worker',?,'codex','worker')", [hashSecret(secret)]);
    const owner = { kind: "owner" as const, userId: "owner" };
    const ticket = await a.dispatch.create(owner, "dispatcher", { requestId: "fixture_create", title: "接收方审批工单", request: "请完成隔离测试" });
    const running = await a.dispatch.dispatch(owner, "dispatcher", { requestId: "fixture_dispatch", ticketId: ticket.id, hostId: receivingHost, engine: "codex" });
    const attempt = running.attempts.at(-1)!;

    const ws = new WebSocket(b.instanceUrl.replace(/^http/, "ws") + "/instance");
    socket = ws;
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", raw => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame }));
    send({ type: "instance.hello", botId: "fixture_worker", secret, engine: "codex", model: "", effort: "", capabilities: ["bot-messages.v1"] });
    await expect.poll(() => frames.find(frame => frame.type === "instance.message")).toMatchObject({ message: { id: attempt.inputMessageId } });
    const actionId = kind === "approval" ? "approve" : "answer";
    const element: CardElement = kind === "approval" ? { type: "button", actionId, text: "批准隔离测试" } : {
      type: "form", extra: { tarocub_questions: {
        version: 1, requestId: "fixture_question", questions: [{ header: "工单问题", question: "怎样继续？", multiSelect: false, required: true, allowFreeText: true, options: [{ label: "按计划继续" }] }],
      } }, children: [{ type: "button", name: "askq_submit", actionId, extra: { form_action_type: "submit" } }],
    };
    const message = await b.store.publishBotMessage("fixture_worker", {
      conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, status: "complete",
      blocks: [{ type: "card", elements: [element],
        extra: { nativeRun: { runId: "fixture_run", engine: "codex", phase: kind === "approval" ? "waiting_approval" : "waiting_answer", revision: 1, startedAt: 1, updatedAt: 2 } } }],
    });
    await a.dispatch.sweep();
    expect((await a.dispatch.show(owner, ticket.id)).attempts.at(-1)?.waitingFor).toEqual({ kind, messageId: message.id });

    await page.goto(b.url);
    await preparePairing(page, b, [route]);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await b.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    const row = page.locator(`.conversation-row[data-conversation-id="${attempt.conversationId}"]`);
    await expect(row).toHaveCount(0);
    await openSettings(page, "general");
    const toggle = page.getByRole("switch", { name: "在列表里显示工单对话", exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await closeSettings(page);
    await expect(page.getByRole("button", { name: "按 Bot", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row).toContainText(ticket.title);
    await page.getByRole("button", { name: "按对话", exact: true }).click();
    await expect(row).toContainText(ticket.title);
    await page.getByRole("button", { name: "按 Bot", exact: true }).click();
    await expect(row).toContainText(ticket.title);
    await row.click();
    const response = "继续隔离测试";
    if (kind === "approval") {
      await page.getByRole("button", { name: "批准隔离测试", exact: true }).click();
    } else {
      const form = page.getByRole("region", { name: "回答问题", exact: true });
      await form.locator('textarea[name="q0_other"]').fill(response);
      await form.getByRole("button", { name: "提交", exact: true }).click();
    }
    const interaction = () => frames.find(frame => frame.type === "instance.call" && frame.method === "interaction");
    await expect.poll(interaction).toMatchObject({ params: { userId: "owner", conversationId: attempt.conversationId, messageId: message.id, actionId } });
    if (kind === "answer") expect(JSON.stringify(interaction()!.params)).toContain(response);
    send({ type: "instance.result", id: interaction()!.id, result: { ok: true } });
    const confirmation = kind === "approval" ? "接收方已批准" : "接收方已回答";
    send({ type: "instance.request", id: "fixture_publish", method: "publish", params: {
      id: message.id, conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, status: "complete", version: 2,
      blocks: [{ type: "card", elements: [{ type: "markdown", text: confirmation }],
        extra: { nativeRun: { runId: "fixture_run", engine: "codex", phase: "running", revision: 2, startedAt: 1, updatedAt: 3 } } }],
    } });
    await expect(page.getByRole("main").getByText(confirmation, { exact: true })).toBeVisible();
    await a.dispatch.sweep();
    expect((await a.dispatch.show(owner, ticket.id)).attempts.at(-1)?.waitingFor).toBeUndefined();
  } finally {
    socket?.terminate();
    await closeControl?.();
    await Promise.all([a.close(), b?.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
