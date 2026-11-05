import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { createHash, randomFillSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test("unpaired startup removes abandoned scratch while respecting another window's active read lock", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "download-startup-"));
  const hub = await HubServer.start({ stateDir: root + "/hub", clientDir: path.resolve("dist") });
  const context = await browser.browserType().launchPersistentContext(root + "/profile", { headless: true });
  try {
    const page = await context.newPage(), active = await context.newPage();
    for (const target of [page, active]) { await target.goto(hub.url); await expect(target.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible(); }
    const heldName = await active.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1", { create: true });
      const active = crypto.randomUUID();
      await new Promise<void>(resolve => { void navigator.locks.request(`tarocub-download-tmp-v1:${active}`, { mode: "shared" }, async () => { resolve(); await new Promise(() => undefined); }); });
      const writer = await (await (await root.getDirectoryHandle(active, { create: true })).getFileHandle("data", { create: true })).createWritable();
      await writer.write(new Uint8Array([7])); await writer.close();
      return active;
    });
    // This page owns the second lock until reload, so an earlier startup sweep
    // cannot delete the fixture before the restart under test.
    await page.evaluate(async () => {
      const name = crypto.randomUUID();
      await new Promise<void>(resolve => { void navigator.locks.request(`tarocub-download-tmp-v1:${name}`, { mode: "shared" }, async () => { resolve(); await new Promise(() => undefined); }); });
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1");
      const writer = await (await (await root.getDirectoryHandle(name, { create: true })).getFileHandle("data", { create: true })).createWritable();
      await writer.write(new Uint8Array([7])); await writer.close();
    });
    const directories = () => page.evaluate(async () => { const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1"); const names: string[] = []; for await (const name of root.keys()) names.push(name); return names.sort(); });
    await page.reload(); await expect.poll(directories).toEqual([heldName]);
    await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible();
    await active.close(); await page.reload(); await expect.poll(directories).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("512 MiB saves twice after another 256 MiB journal, with exact bytes and no retained scratch copies", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-download-"));
  const hub = await HubServer.start({ stateDir: root + "/hub", clientDir: path.resolve("dist") });
  const context = await browser.browserType().launchPersistentContext(root + "/profile", { headless: true, acceptDownloads: true });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('files','文件助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["files"], "连续大文件下载", "downloads");
    const size = 512 * 1024 ** 2, name = "资料 包-512MiB.bin"; let bytes: Buffer | undefined = randomFillSync(Buffer.allocUnsafe(size));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = await hub.attachments.importForBot("files", { conversationId: chat.id, name, size, mime: "application/octet-stream", sha256 }, bytes); bytes = undefined;
    await hub.store.publishBotMessage("files", { conversationId: chat.id, blocks: [{ type: "file", attachmentId: id, name, size, mime: "application/octet-stream" }], status: "complete" });
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)); await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.evaluate(async () => {
      for (const { name } of await indexedDB.databases()) {
        if (!name?.startsWith("tarocub-")) continue;
        const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); });
        try {
          if (!db.objectStoreNames.contains("downloadMeta")) continue;
          const identity = await new Promise<any>(resolve => { const request = db.transaction("settings").objectStore("settings").get("identity"); request.onsuccess = () => resolve(request.result); });
          if (!identity) continue;
          const tx = db.transaction(["downloadMeta", "downloadChunks"], "readwrite"), bytes = new ArrayBuffer(8 * 1024 ** 2);
          const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
          for (let index = 0; index < 32; index++) tx.objectStore("downloadChunks").put({ attachmentId: "older-file", revision: "older", index, bytes });
          tx.objectStore("downloadMeta").put({ revision: "older", etag: `"${"a".repeat(64)}"`, total: 512 * 1024 ** 2, offset: 256 * 1024 ** 2, mime: "test", updatedAt: Date.now() - 1000, scope: JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]) }, "older-file");
          await done;
        } finally { db.close(); }
      }
    });
    const downloads: { size: number; sha256: string }[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
      const file = await downloading; expect(await file.failure()).toBeNull(); expect(file.suggestedFilename()).toBe(name);
      const hash = createHash("sha256"); let received = 0;
      for await (const part of createReadStream((await file.path())!)) { hash.update(part); received += part.length; }
      const receipt = { size: received, sha256: hash.digest("hex") }; expect(receipt).toEqual({ size, sha256 }); downloads.push(receipt);
      await expect(page.locator(".file-card").getByRole("status")).toHaveText("已交给浏览器下载");
      await expect.poll(() => page.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tarocub-download-tmp-v1"); let count = 0;
        for await (const _ of root.keys()) count++; return count;
      })).toBe(0);
    }
    expect(errors).toEqual([]);
    await info.attach("repeated-large-file", { body: JSON.stringify({ browser: browser.browserType().name(), persistentProfile: true, seededOtherJournalBytes: 256 * 1024 ** 2, downloads, scratchDirectoriesAfterEachExport: 0, errors }, null, 2), contentType: "application/json" });
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker downloads isolate clients, reject replay and preserve an original token after a duplicate prepare", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-download-auth-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") }), context = await browser.newContext();
  try {
    const owner = await context.newPage(), other = await context.newPage();
    for (const page of [owner, other]) { await page.goto(hub.url); await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)); await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true); }
    const id = await owner.evaluate(async () => {
      const id = crypto.randomUUID(), channel = new MessageChannel();
      const ready = new Promise<void>((resolve, reject) => { channel.port1.onmessage = event => { if (event.data.type === "ready") resolve(); else reject(new Error(event.data.type)); }; });
      navigator.serviceWorker.controller!.postMessage({ type: "attachment.download.prepare", id, name: "odd-\ud800-name.bin", blob: new Blob(["owner bytes"]) }, [channel.port2]); await ready; return id;
    });
    expect(await other.evaluate(async id => (await fetch(`/__tarocub_download/${id}`)).status, id)).toBe(404);
    expect(await other.evaluate(id => new Promise<string>(resolve => {
      const channel = new MessageChannel(); channel.port1.onmessage = event => { resolve(event.data.type); channel.port1.close(); };
      navigator.serviceWorker.controller!.postMessage({ type: "attachment.download.prepare", id, name: "duplicate.bin", blob: new Blob(["wrong bytes"]) }, [channel.port2]);
    }), id)).toBe("error");
    const original = await owner.evaluate(async id => { const response = await fetch(`/__tarocub_download/${id}`); return { status: response.status, text: await response.text(), disposition: response.headers.get("Content-Disposition"), cache: response.headers.get("Cache-Control") }; }, id);
    expect(original).toEqual({ status: 200, text: "owner bytes", disposition: "attachment; filename*=UTF-8''odd-_-name.bin", cache: "no-store" });
    expect(await owner.evaluate(async id => (await fetch(`/__tarocub_download/${id}`)).status, id)).toBe(404);
    const before = owner.url(); await owner.evaluate(id => { const anchor = document.createElement("a"); anchor.href = `/__tarocub_download/${id}`; anchor.click(); }, id);
    await expect(owner.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible(); expect(owner.url()).toBe(before);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
