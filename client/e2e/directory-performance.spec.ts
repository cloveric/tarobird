import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ trace: "off", serviceWorkers: "block" });
for (const width of [1360, 390]) test(`directory work during background streaming and reconnect at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 900 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "directory-performance-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, plugins: [{
    name: "directory-work-probe", enforce: "pre", transform(code, id) {
      const counter = (name: string) => `(window as any).__directoryWork.${name}++;`;
      if (id.endsWith("/src/App.tsx")) return code.replace("export function Workspace({ connection, forget, shell, pane }: WorkspaceProps) {", match => match + counter("workspace"));
      if (id.endsWith("/src/HostApp.tsx")) return code.replace("function HostAppSession({ Workspace, Pairing }: HostAppProps) {", match => match + counter("host"));
      if (id.endsWith("/src/ConversationList.tsx")) return code.replace("  const drafts = useDraftPreviews(connection.cache);", counter("list") + "  const drafts = useDraftPreviews(connection.cache);");
      if (id.endsWith("/src/Avatar.tsx")) return code.replace("  const context = useContext(Profiles), [loaded, setLoaded]", counter("avatar") + "  const context = useContext(Profiles), [loaded, setLoaded]");
      if (id.endsWith("/src/native.ts")) return code.replace('export async function updateBadge(count: number): Promise<void> {', match => match + '(window as any).__badgeAttempts.push(count); (window as any).__directoryWork.badges++; if ((window as any).__badgeAttempts.length === 1) throw new Error("fixture_native_bridge_not_ready");');
      if (id.endsWith("/src/connection.ts")) return code.replace("private update(changes: Partial<ConnectionState> = {}, cacheChanged = false, scoped = false): void {", match => match + "(window as any).__directoryConnection=this;");
    },
  }] });
  await server.listen(); const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: directory, origins: [new URL(url).origin] });
  try {
    await page.addInitScript(() => {
      Object.assign(window, { __directoryWork: { workspace: 0, host: 0, list: 0, avatar: 0, titles: 0, conversations: 0, outbox: 0, outboxMs: 0, badges: 0 }, __badgeAttempts: [] });
      const title = Object.getOwnPropertyDescriptor(Document.prototype, "title")!;
      Object.defineProperty(Document.prototype, "title", { ...title, set(value) { (window as any).__directoryWork.titles++; title.set!.call(this, value); } });
    });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Performance worker','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "Current", "current");
    const background = await hub.store.createConversation("owner", ["bot"], "Background", "background");
    for (let i = 0; i < 200; i++) await hub.store.createConversation("owner", ["bot"], `History ${i}`, `history-${i}`);
    const live = await hub.store.publishBotMessage("bot", { conversationId: background.id, blocks: [{ type: "text", text: "Background 0" }], status: "streaming" });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await page.waitForFunction(() => (window as any).__directoryConnection.state.status === "online" && Reflect.get((window as any).__directoryConnection, "syncing") === false);
    // Initial native failure must retry without waiting for a different count.
    await expect.poll(() => page.evaluate(() => (window as any).__badgeAttempts.length)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as any).__badgeAttempts.slice(0, 2))).toEqual([0, 0]);
    await page.evaluate(async () => {
      const { ClientCache } = await import("/src/storage.ts");
      for (const key of ["conversations", "outbox"] as const) {
        const original = ClientCache.prototype[key];
        (ClientCache.prototype as any)[key] = function(...args: unknown[]) {
          (window as any).__directoryWork[key]++;
          const start = performance.now(), result = (original as any).apply(this, args);
          // Count alone does not establish a latency bottleneck. Keep elapsed
          // IDB time alongside call volume; this is not a hardware speed gate.
          return key === "outbox" ? result.finally(() => { (window as any).__directoryWork.outboxMs += performance.now() - start; }) : result;
        };
      }
    });
    const reset = async () => {
      await page.waitForTimeout(300);
      await page.evaluate(() => { for (const key in (window as any).__directoryWork) (window as any).__directoryWork[key] = 0; });
    };
    await reset();
    for (let i = 1; i <= 20; i++) {
      await hub.store.publishBotMessage("bot", { id: live.id, conversationId: background.id, blocks: [{ type: "text", text: `Background ${i}` }], status: "streaming" });
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(300);
    const stream = await page.evaluate(() => ({ ...(window as any).__directoryWork }));
    await reset();
    await page.evaluate(() => { const socket = Reflect.get((window as any).__directoryConnection, "ws"); (window as any).__previousDirectorySocket = socket; socket.close(4000); });
    await page.waitForFunction(() => { const connection = (window as any).__directoryConnection; return Reflect.get(connection, "ws") !== (window as any).__previousDirectorySocket && connection.state.status === "online" && Reflect.get(connection, "syncing") === false; });
    await page.waitForTimeout(300);
    const reconnect = await page.evaluate(() => ({ ...(window as any).__directoryWork }));
    await selectConversation(page, background.title);
    await expect(page.locator(".message-blocks")).toContainText("Background 20");
    const result = { width, conversations: 202, events: 20, stream, reconnect };
    console.log("Directory work", JSON.stringify(result));
    await info.attach("directory-work", { body: JSON.stringify(result), contentType: "application/json" });
    expect(stream.titles).toBe(0); expect(stream.badges).toBe(0);
    expect(reconnect.conversations).toBeLessThan(20);
    expect(reconnect.workspace).toBeLessThan(100);
    if (width === 390) expect(stream.avatar).toBeLessThan(1000);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
