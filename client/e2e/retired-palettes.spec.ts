import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

const retired = ["white-teal", "plum", "sand", "pixel", "tty", "paper", "agent"];
const supported = ["cli", "mono", "white-blue", "white-green", "white-violet", "white-rose", "white-orange", "sage", "ocean"];

for (const source of ["global", "legacy"] as const) test(`retired ${source} themes fall back before and after hydration without losing preferences or drafts`, async ({ page }, info) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "retired-palettes-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('theme','主题助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["theme"], "保留草稿");
    if (source === "legacy") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const draft = page.getByRole("textbox", { name: "消息", exact: true });
    await draft.fill("这个草稿和已绑定主机要保留。");
    // Hold only asynchronous preference reads; inspect the synchronous startup
    // mirror independently of both current and legacy IndexedDB readers.
    await page.addInitScript(() => {
      const original = IDBObjectStore.prototype.get, pending: (() => void)[] = [];
      let released = false;
      IDBObjectStore.prototype.get = function (key) {
        const request = original.call(this, key);
        if ((this.name === "settings" || this.name === "meta") && key === "preferences") {
          const add = request.addEventListener.bind(request);
          request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            add(type, type === "success" ? (event: Event) => { const resume = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event); if (released) resume(); else pending.push(resume); } : listener, options);
          }) as typeof request.addEventListener;
        }
        return request;
      };
      Object.assign(window, { releaseAppearanceReads() { released = true; IDBObjectStore.prototype.get = original; pending.splice(0).forEach(resume => resume()); } });
    });
    for (const [i, palette] of retired.entries()) {
      const theme = ["light", "dark", "system"][i % 3]!;
      await page.evaluate(async ({ palette, theme, source }) => {
        const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const registry = await open("tarocub-hosts-v1");
        const previous = await new Promise<any>((resolve, reject) => {
          const request = registry.transaction("meta").objectStore("meta").get("preferences");
          request.onsuccess = () => resolve(request.result ? JSON.parse(request.result) : {}); request.onerror = () => reject(request.error);
        });
        const value = { ...previous, palette, theme, monoAccent: "warm-gray", fontSize: 16, locale: "zh", showModelIcons: false, quietStart: "22:00", quietEnd: "08:00", animations: true };
        await new Promise<void>((resolve, reject) => {
          const tx = registry.transaction("meta", "readwrite");
          if (source === "global") tx.objectStore("meta").put(JSON.stringify(value), "preferences"); else tx.objectStore("meta").delete("preferences");
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        }); registry.close();
        if (source === "legacy") {
          const legacy = await open("tarocub-v1");
          await new Promise<void>((resolve, reject) => {
            const tx = legacy.transaction("settings", "readwrite"); tx.objectStore("settings").put(value, "preferences");
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
          }); legacy.close();
        }
        localStorage.setItem("tarocub-appearance", JSON.stringify(value));
      }, { palette, theme, source });
      await page.reload(); await expect(page.locator(".loading-screen")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "warm-gray");
      await page.evaluate(() => (window as unknown as { releaseAppearanceReads(): void }).releaseAppearanceReads());
      await waitForClientOnline(page); await selectConversation(page, chat.title);
      await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-model-icons", "hidden");
      await expect(draft).toHaveValue("这个草稿和已绑定主机要保留。");
      await openSettings(page);
      await expect(page.getByLabel("字号", { exact: true })).toHaveValue("16");
      await expect(page.locator('input[name="color-palette"][value="mono"]')).toBeChecked();
      expect(await page.locator('input[name="color-palette"]').evaluateAll(nodes => nodes.map(n => (n as HTMLInputElement).value))).toEqual(supported);
      const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem("tarocub-appearance")!));
      expect(mirror).toMatchObject({ palette: "mono", theme, monoAccent: "warm-gray", showModelIcons: false });
      await closeSettings(page);
    }
    // A subsequent ordinary edit must save the normalized palette, so it
    // cannot reappear from the old record during the next preference write.
    await openSettings(page); await page.getByLabel("主题", { exact: true }).selectOption("dark"); await page.getByLabel("主题", { exact: true }).selectOption("light");
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); });
      const value = await new Promise<any>(resolve => { const r = db.transaction("meta").objectStore("meta").get("preferences"); r.onsuccess = () => resolve(JSON.parse(r.result)); }); db.close(); return value;
    })).toMatchObject({ palette: "mono", theme: "light", monoAccent: "warm-gray", fontSize: 16, showModelIcons: false, quietStart: "22:00", quietEnd: "08:00" });
    await page.locator('input[value="mono"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`themes-${source}.png`), animations: "disabled" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
