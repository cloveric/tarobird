import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runAttachmentsCommand } from "../src/host-cli/attachments.js";
import { initializeHost } from "../src/host-cli/setup.js";

let root: string, hub: HubServer, control: (() => Promise<void>) | undefined;
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "attachments-cli-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
});
afterEach(async () => { vi.unstubAllEnvs(); await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });

it("lists and deletes attachments through the owner API, freeing the blob", async () => {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const chat = await hub.store.createConversation("owner", ["alpha"], "PPT 素材", "decks");
  const ids: string[] = [];
  for (const size of [100, 2000]) {
    const id = `att_cli_${size}`; ids.push(id);
    await hub.store.db.run("INSERT INTO attachments VALUES(?,?,'owner','fixture',?,'application/pdf',?,?,1,?)", [id, chat.id, size, `${size}.pdf`, `${id}.blob`, size]);
    await writeFile(path.join(hub.attachments.directory, `${id}.blob`), Buffer.alloc(size));
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "file", attachmentId: id, name: `${size}.pdf`, size, mime: "application/pdf" }] });
  }
  expect(await runAttachmentsCommand(root, "list", {})).toEqual({ count: 2, bytes: 2100, conversations: [{ conversationId: chat.id, title: "PPT 素材", count: 2, bytes: 2100, revision: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  const page: any = await runAttachmentsCommand(root, "list", { conversation: chat.id, sort: "size" });
  expect(page.items.map((item: { id: string }) => item.id)).toEqual(["att_cli_2000", "att_cli_100"]);
  await expect(runAttachmentsCommand(root, "delete", { ids: "att_cli_2000" })).rejects.toThrow("--yes");
  await expect(runAttachmentsCommand(root, "delete", { ids: "att_cli_2000", conversation: chat.id, yes: true })).rejects.toThrow("二选一");
  expect(await runAttachmentsCommand(root, "delete", { ids: "att_cli_2000", yes: true })).toEqual({ deleted: 1, freedBytes: 2000, ids: ["att_cli_2000"], pending: [] });
  await expect(access(path.join(hub.attachments.directory, "att_cli_2000.blob"))).rejects.toThrow();
  expect(await runAttachmentsCommand(root, "delete", { conversation: chat.id, yes: true })).toEqual({ deleted: 1, freedBytes: 100, ids: ["att_cli_100"], pending: [] });
  expect(await runAttachmentsCommand(root, "list", {})).toEqual({ count: 0, bytes: 0, conversations: [] });
  await expect(runAttachmentsCommand(root, "remove", {})).rejects.toThrow("attachments list|delete");
});
