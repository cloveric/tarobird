import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test, type Page } from "@playwright/test";
import { widgetBlock } from "../../src/client-protocol/widget.js";
import { mountWidget } from "./fixtures/widget-runtime-host.js";
import { sendChoiceFixture } from "./fixtures/claude-send-choice.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";

test.use({ serviceWorkers: "block" });
const source = `<button id="inc">增加</button><p id="count"></p><script>
let count=Number(tarobot.state.initial?.count)||0;const draw=()=>document.querySelector('#count').textContent=String(count);draw();
document.querySelector('#inc').onclick=()=>{count++;draw();tarobot.state.set({count})};</script>`;
const guest = (page: Page) => page.frameLocator(".widget-panel:visible > iframe").frameLocator("iframe");

test("runtime flush bypasses both coalescers and retires the Worker before acknowledging", async ({ page }) => {
  const host = await mountWidget(page, source);
  await host.guest.locator("#inc").click(); await host.guest.locator("#inc").click();
  await expect(host.guest.locator("#count")).toHaveText("2");
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "tarobot-widget-state-flush", key: "runtime-host-key", id: "retire-one" }, "*"));
  await expect.poll(async () => (await host.messages()).find(message => message.type === "tarobot-widget-state-flushed")).toMatchObject({ id: "retire-one", ok: true, state: '{"count":2}' });
  // The opaque frame remains for this probe; the terminal ACK must already
  // mean script execution stopped, without relying on App removing the iframe.
  await expect(host.guest.locator("#inc")).toBeDisabled();
  await expect(host.guest.locator("#count")).toHaveText("2");
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "tarobot-widget-state-flush", key: "runtime-host-key", id: "retire-two" }, "*"));
  expect((await host.messages()).filter(message => message.type === "tarobot-widget-state-flushed")).toHaveLength(1);
});

test("runtime does not accept select or text input before the first interactive snapshot", async ({ page }) => {
  const pending = mountWidget(page, `<select id="choice"><option value="a">A</option><option value="b">B</option></select><textarea id="note"></textarea><p id="value">loading</p><script>
const start=performance.now();while(performance.now()-start<1300){};
const select=document.getElementById('choice');select.onchange=()=>document.getElementById('value').textContent=select.value;document.getElementById('value').textContent=select.value;</script>`);
  const frame = page.frameLocator("iframe").frameLocator("iframe");
  await expect(frame.locator("#choice")).toBeDisabled(); await expect(frame.locator("#note")).toBeDisabled();
  await expect(frame.locator("#report-root")).toHaveAttribute("inert", "");
  await expect(frame.locator("#choice").selectOption("b", { timeout: 100 })).rejects.toThrow();
  await frame.locator("#note").evaluate(node => (node as HTMLTextAreaElement).focus()); await page.keyboard.type("not accepted");
  await expect(frame.locator("#note")).toHaveValue("");
  const host = await pending;
  await expect(host.guest.locator("#choice")).toBeEnabled(); await expect(host.guest.locator("#note")).toBeEnabled();
  await host.guest.locator("#choice").selectOption("b"); await expect(host.guest.locator("#value")).toHaveText("b");
  await host.guest.locator("#note").fill("accepted after ready"); await expect(host.guest.locator("#note")).toHaveValue("accepted after ready");
});

for (const withState of [false, true]) test(`runtime unsupported initialization flush has an explicit ${withState ? "snapshot" : "empty state"} outcome`, async ({ page }) => {
  const host = await mountWidget(page, `<p id="static">Static fallback</p><button id="dead">Unavailable script control</button>${"<i>·</i>".repeat(2100)}<script>${withState ? "tarobot.state.set({count:7});" : ""}document.getElementById('static').textContent='dynamic';</script>`);
  await expect(host.guest.locator("#static")).toHaveText("Static fallback"); await expect(host.guest.locator("#dead")).toBeDisabled();
  await expect.poll(async () => (await host.messages()).some(message => message.type === "tarobot-widget-error" && message.reason === "unsupported")).toBe(true);
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "tarobot-widget-state-flush", key: "runtime-host-key", id: "unsupported-retire" }, "*"));
  await expect.poll(async () => (await host.messages()).find(message => message.type === "tarobot-widget-state-flushed")).toMatchObject({ id: "unsupported-retire", ok: true, ...(withState ? { state: '{"count":7}' } : {}) });
  if (!withState) expect((await host.messages()).find(message => message.type === "tarobot-widget-state-flushed")).not.toHaveProperty("state");
});

test("runtime relay accepts the previous viewer ready handshake without a started message", async ({ page }) => {
  const relay = await readFile("public/widget-sandbox.html", "utf8");
  await page.route("https://legacy-widget.test/relay", route => route.fulfill({ contentType: "text/html", body: relay }));
  await page.setContent("<main></main>");
  await page.evaluate(() => {
    const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.src = "https://legacy-widget.test/relay";
    (window as unknown as { legacyReply?: unknown }).legacyReply = undefined;
    window.addEventListener("message", event => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === "tarobot-widget-shell-ready") frame.contentWindow!.postMessage({ type: "tarobot-widget-init", key: "legacy", document: `<script>addEventListener('message',e=>{if(e.source===parent&&e.data.key==='legacy'&&e.data.type==='tarobot-widget-state-flush')parent.postMessage({type:'tarobot-widget-state-flushed',key:'legacy',id:e.data.id,ok:true,state:'{"count":7}'},'*')});parent.postMessage({type:'tarobot-widget-ready',key:'legacy'},'*');<\/script>` }, "*");
      if (event.data?.type === "tarobot-widget-ready") frame.contentWindow!.postMessage({ type: "tarobot-widget-state-flush", key: "legacy", id: "old-viewer" }, "*");
      if (event.data?.type === "tarobot-widget-state-flushed") (window as unknown as { legacyReply?: unknown }).legacyReply = event.data;
    });
    document.body.appendChild(frame);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { legacyReply?: unknown }).legacyReply)).toMatchObject({ id: "old-viewer", ok: true, state: '{"count":7}' });
});

test("runtime retirement during unsupported initialization still acknowledges its final explicit state", async ({ page }) => {
  const pending = mountWidget(page, `<button id="dead">Loading</button>${"<i>·</i>".repeat(2100)}<script>const start=performance.now();while(performance.now()-start<500){};tarobot.state.set({count:9});</script>`);
  const frame = page.frameLocator("iframe").frameLocator("iframe");
  await expect(frame.locator("#dead")).toBeDisabled();
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "tarobot-widget-state-flush", key: "runtime-host-key", id: "retire-before-fallback" }, "*"));
  const host = await pending;
  await expect.poll(async () => (await host.messages()).find(message => message.type === "tarobot-widget-state-flushed")).toMatchObject({ id: "retire-before-fallback", ok: true, state: '{"count":9}' });
  expect((await host.messages()).filter(message => message.type === "tarobot-widget-state-flushed")).toHaveLength(1);
});

async function open(page: Page, third = false, html = source) {
  const f = await sendChoiceFixture();
  const c = third ? await f.hub.store.createConversation("owner", ["bot"], "第三段对话", "state-third") : undefined;
  await page.addInitScript(() => {
    if (window !== top) return;
    const probe = { holdState: false, holdFinal: false, delayFinal: 0, finals: 0, blocked: 0 };
    (window as unknown as { stateProbe: typeof probe }).stateProbe = probe;
    // Install before production listeners: Window-target message events do not
    // retroactively move a later capture listener ahead of existing listeners.
    window.addEventListener("message", event => {
      if (event.data?.type === "tarobot-widget-state" && probe.holdState) { probe.blocked++; event.stopImmediatePropagation(); }
      if (event.data?.type !== "tarobot-widget-state-flushed") return;
      probe.finals++;
      if (probe.holdFinal) event.stopImmediatePropagation();
      else if (probe.delayFinal) {
        const delay = probe.delayFinal; probe.delayFinal = 0; event.stopImmediatePropagation();
        const { source, data } = event; setTimeout(() => window.dispatchEvent(new MessageEvent("message", { source, data })), delay);
      }
    }, true);
  });
  for (const [i, chat] of f.chats.entries()) await f.hub.store.publishBotMessage("bot", { id: `state-widget-${i}`, conversationId: chat.id, status: "complete", blocks: [widgetBlock({ title: "可恢复组件", summary: "各对话独立保存参数", html })] });
  await page.goto(f.hub.url); await preparePairing(page, f.hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await f.hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  await selectConversation(page, f.chats[0]!.title); await expect(guest(page).locator("#count")).toHaveText("0");
  return { ...f, third: c };
}
// Deliberately hold ordinary coalesced state packets. These tests prove the
// terminal snapshot commits, independent of load or browser timer scheduling.
const holdOrdinaryState = (page: Page) => page.evaluate(() => { (window as unknown as { stateProbe: { holdState: boolean } }).stateProbe.holdState = true; });

test("App deterministic static fallback does not invent an unconfirmed-state warning after navigation", async ({ page }) => {
  const f = await open(page, false, `<p id="count">0</p>${"<i>·</i>".repeat(2100)}<script>document.getElementById('count').textContent='dynamic'</script>`);
  try {
    await expect(page.getByText("组件未能完整运行，文字摘要仍可阅读。", { exact: true })).toBeVisible();
    await selectConversation(page, f.chats[1]!.title); await expect(guest(page).locator("#count")).toHaveText("0");
    await selectConversation(page, f.chats[0]!.title); await expect(guest(page).locator("#count")).toHaveText("0");
    await expect(page.getByText("组件未能确认最新状态，部分设置可能需要重新选择。", { exact: true })).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

test("App revoked Host removes the interactive frame and exposes its summary without a blank reserved canvas", async ({ page }) => {
  const f = await open(page);
  try {
    await page.getByRole("button", { name: "放大交互组件", exact: true }).click(); await expect(page.locator(".widget-expanded")).toBeVisible();
    const device = (await f.hub.store.db.all<{ id: string }>("SELECT id FROM devices WHERE id != 'pairing_fixture_owner'"))[0]!.id;
    await f.hub.auth.revoke(device, "local-owner");
    await expect(page.locator(".composer textarea")).toHaveAttribute("readonly", "", { timeout: 15000 });
    await expect(page.locator(".widget-panel > iframe")).toHaveCount(0);
    await expect(page.locator(".widget-expanded")).toHaveCount(0);
    await expect(page.getByText("当前对话为只读，交互组件仅显示文字摘要。", { exact: true })).toBeVisible();
    await expect(page.locator(".widget-summary")).toHaveAttribute("open", "");
    await expect(page.locator(".widget-summary p")).toHaveText("各对话独立保存参数");
    await expect(page.getByRole("button", { name: "放大交互组件", exact: true })).toBeDisabled();
    expect((await page.locator(".widget-panel").boundingBox())!.height).toBeLessThan(250);
  } finally { await page.close(); await f.close(); }
});

for (const width of [390, 1360]) test(`App state survives immediate collapse and conversation switch at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); const f = await open(page);
  try {
    await holdOrdinaryState(page);
    const input = page.getByRole("textbox", { name: "消息", exact: true }); await input.fill("A 的草稿");
    await page.getByRole("button", { name: "放大交互组件", exact: true }).click();
    await guest(page).locator("#inc").click(); await guest(page).locator("#inc").click();
    await page.getByRole("button", { name: "收起交互组件", exact: true }).click();
    await selectConversation(page, f.chats[1]!.title); await expect(guest(page).locator("#count")).toHaveText("0");
    await input.fill("B 的草稿"); await selectConversation(page, f.chats[0]!.title);
    await expect(guest(page).locator("#count")).toHaveText("2"); await expect(input).toHaveValue("A 的草稿");
    await selectConversation(page, f.chats[1]!.title); await expect(input).toHaveValue("B 的草稿");
    expect(f.turns).toHaveLength(0); expect(f.inputs).toHaveLength(0);
  } finally { await page.close(); await f.close(); }
});

test("App retains an offscreen virtual row until its state flush and restores it on scroll back", async ({ page }) => {
  const f = await open(page);
  try {
    await holdOrdinaryState(page); await guest(page).locator("#inc").click();
    // Push the interactive row well beyond virtualization overscan.
    for (let i = 0; i < 45; i++) await f.hub.store.publishBotMessage("bot", { id: `later-${i}`, conversationId: f.chats[0]!.id, status: "complete", blocks: [{ type: "text", text: `后续记录 ${i}\n${"阅读内容\n".repeat(8)}` }] });
    const scroll = page.locator(".message-scroll"); await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('[data-message-id="state-widget-0"] iframe')).toHaveCount(0);
    await expect(page.getByText("后续记录 44", { exact: false }).last()).toBeVisible();
    await scroll.hover(); await page.mouse.wheel(0, -100_000);
    await expect(guest(page).locator("#count")).toHaveText("1");
  } finally { await page.close(); await f.close(); }
});

test("App timeout keeps the old confirmed value and shows a scoped warning after return", async ({ page }) => {
  const f = await open(page);
  try {
    await page.evaluate(() => Object.assign((window as unknown as { stateProbe: object }).stateProbe, { holdState: true, holdFinal: true }));
    await guest(page).locator("#inc").click(); await selectConversation(page, f.chats[1]!.title);
    await expect(page.getByText("组件未能确认最新状态，部分设置可能需要重新选择。", { exact: true })).toHaveCount(0);
    await selectConversation(page, f.chats[0]!.title);
    await expect(guest(page).locator("#count")).toHaveText("0");
    await expect(page.getByText("组件未能确认最新状态，部分设置可能需要重新选择。", { exact: true })).toBeVisible();
  } finally { await page.close(); await f.close(); }
});

test("App rapid A to B to C navigation commits only the latest request and keeps drafts separate", async ({ page }) => {
  const f = await open(page, true);
  try {
    const c = f.third!;
    await expect(page.locator(".conversation-row").filter({ hasText: c.title })).toBeVisible();
    const input = page.getByRole("textbox", { name: "消息", exact: true }); await input.fill("A draft");
    await holdOrdinaryState(page); await guest(page).locator("#inc").click();
    // Hold this one terminal reply to make two real navigation requests race.
    await page.evaluate(() => { (window as unknown as { stateProbe: { delayFinal: number } }).stateProbe.delayFinal = 150; });
    await page.evaluate(([b, c]) => {
      const rows = [...document.querySelectorAll<HTMLElement>(".conversation-row")];
      rows.find(row => row.textContent?.includes(b!))!.click();
      rows.find(row => row.textContent?.includes(c!))!.click();
    }, [f.chats[1]!.title, c.title]);
    await expect(page.getByRole("heading", { name: c.title, exact: true, level: 1 })).toBeVisible();
    await expect(input).toHaveValue(""); await input.fill("C draft");
    await selectConversation(page, f.chats[0]!.title); await expect(input).toHaveValue("A draft"); await expect(guest(page).locator("#count")).toHaveText("1");
    await selectConversation(page, f.chats[1]!.title); await expect(input).toHaveValue("");
  } finally { await page.close(); await f.close(); }
});

test("App two ADHD panes retain independent state through hide, removal and mode exit", async ({ page }) => {
  const f = await open(page);
  try {
    await holdOrdinaryState(page); await guest(page).locator("#inc").click();
    // Switching the mode destroys the normal Workspace, so this also verifies
    // the parent guard flushes before unmount rather than relying on cleanup.
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of f.chats) await page.getByRole("checkbox", { name: new RegExp(`加入面板：.*${chat.title}`) }).check();
    const a = page.locator(`.adhd-card[data-pane-conversation="${f.chats[0]!.id}"]`);
    const b = page.locator(`.adhd-card[data-pane-conversation="${f.chats[1]!.id}"]`);
    const ag = a.frameLocator(".widget-panel > iframe").frameLocator("iframe"), bg = b.frameLocator(".widget-panel > iframe").frameLocator("iframe");
    await expect(ag.locator("#count")).toHaveText("1"); await expect(bg.locator("#count")).toHaveText("0");
    await ag.locator("#inc").click(); await bg.locator("#inc").click();
    await b.getByRole("button", { name: "放大此面板", exact: true }).click();
    await expect(a.locator(".widget-panel > iframe")).toHaveCount(0);
    await bg.locator("#inc").click();
    await b.getByRole("button", { name: "回到面板总览", exact: true }).click();
    await expect(ag.locator("#count")).toHaveText("2"); await expect(bg.locator("#count")).toHaveText("2");
    await ag.locator("#inc").click(); await a.getByRole("button", { name: "移除此面板", exact: true }).click();
    await expect(a).toHaveCount(0);
    await page.getByRole("checkbox", { name: new RegExp(`加入面板：.*${f.chats[0]!.title}`) }).check();
    await expect(ag.locator("#count")).toHaveText("3");
    await ag.locator("#inc").click();
    await page.getByRole("button", { name: "按对话", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await selectConversation(page, f.chats[0]!.title); await expect(guest(page).locator("#count")).toHaveText("4");
    await selectConversation(page, f.chats[1]!.title); await expect(guest(page).locator("#count")).toHaveText("2");
  } finally { await page.close(); await f.close(); }
});

test("App switching retained Host workspaces flushes the last state without crossing same message IDs or drafts", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "widget-state-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const visible = () => page.locator(".host-workspace:not([hidden])");
  const currentGuest = () => visible().frameLocator(".widget-panel > iframe").frameLocator("iframe");
  await page.addInitScript(() => {
    if (window !== top) return;
    const probe = { holdFinal: false, keys: new Map<MessageEventSource, string>(), pending: [] as { source: MessageEventSource | null; data: unknown }[] };
    (window as unknown as { hostStateProbe: typeof probe }).hostStateProbe = probe;
    window.addEventListener("message", event => {
      if (event.source && typeof event.data?.key === "string") probe.keys.set(event.source, event.data.key);
      if (event.data?.type === "tarobot-widget-state") event.stopImmediatePropagation();
      if (event.data?.type === "tarobot-widget-state-flushed" && probe.holdFinal) { probe.pending.push({ source: event.source, data: event.data }); event.stopImmediatePropagation(); }
    }, true);
  });
  const pair = async (hub: HubServer, name: string, add = false) => {
    if (add) await clickAppAction(page, "连接另一台主机", visible().getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(hub.url);
    await page.getByRole("textbox", { name: "主机名称", exact: true }).fill(name);
    await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(visible()).toHaveAttribute("data-active-host", `hub_${createHash("sha256").update(Buffer.from(hub.auth.publicKey, "base64")).digest("hex")}`);
    await expect(visible().locator(".connection-pill.online")).toBeVisible();
    await showDisconnectedBots(page);
    if (add) await setListOption(page, '按主机分组', true);
  };
  const choose = async (name: string) => { await visible().getByRole("region", { name: `主机：${name}`, exact: true }).getByRole("button", { name: /^同名对话/ }).click(); };
  try {
    for (const [hub, name] of [[a, "状态主机 A"], [b, "状态主机 B"]] as const) {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_conversation','direct','同名对话','owner',1,'same_action')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_conversation','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { id: "same_message", conversationId: "same_conversation", status: "complete", blocks: [widgetBlock({ title: "可恢复组件", summary: "每台主机独立保存参数", html: source })] });
    }
    await pair(a, "状态主机 A"); await pair(b, "状态主机 B", true); await choose("状态主机 A");
    await expect(currentGuest().locator("#count")).toHaveText("0");
    await visible().getByRole("textbox", { name: "消息", exact: true }).fill("A 的草稿");
    await currentGuest().locator("#inc").click(); await expect(currentGuest().locator("#count")).toHaveText("1");
    // Install in the already-loaded relay realm: WebKit's document.write
    // lifecycle does not reliably preserve addInitScript instrumentation.
    await visible().frameLocator(".widget-panel > iframe").locator("body").evaluate(() => {
      const replies: unknown[] = [];
      (window as unknown as { hiddenComposeReplies: unknown[] }).hiddenComposeReplies = replies;
      window.addEventListener("message", event => { if (event.data?.type === "tarobot-widget-compose-result") replies.push(event.data); });
    });
    await page.evaluate(() => { (window as unknown as { hostStateProbe: { holdFinal: boolean } }).hostStateProbe.holdFinal = true; });
    await choose("状态主机 B");
    // A delayed state ACK leaves a short retiring interval. Even an otherwise
    // correctly bound compose packet from that hidden frame must be refused.
    const hiddenFrame = page.locator(".host-workspace[hidden] .widget-panel > iframe");
    await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>(".host-workspace[hidden] .widget-panel > iframe")!.contentWindow!;
      const probe = (window as unknown as { hostStateProbe: { keys: Map<MessageEventSource, string> } }).hostStateProbe;
      window.dispatchEvent(new MessageEvent("message", { source, data: { type: "tarobot-widget-compose", key: probe.keys.get(source), id: "hidden-state-probe", text: "不得写入任何草稿" } }));
    });
    await expect.poll(() => hiddenFrame.contentFrame().locator("body").evaluate(() => (window as unknown as { hiddenComposeReplies: unknown[] }).hiddenComposeReplies), { timeout: 600 }).toContainEqual(expect.objectContaining({ id: "hidden-state-probe", accepted: false }));
    await page.evaluate(() => {
      const probe = (window as unknown as { hostStateProbe: { holdFinal: boolean; pending: { source: MessageEventSource | null; data: unknown }[] } }).hostStateProbe;
      probe.holdFinal = false; for (const packet of probe.pending.splice(0)) window.dispatchEvent(new MessageEvent("message", packet));
    });
    await expect(hiddenFrame).toHaveCount(0);
    await expect(currentGuest().locator("#count")).toHaveText("0");
    await visible().getByRole("textbox", { name: "消息", exact: true }).fill("B 的草稿");
    await currentGuest().locator("#inc").click(); await currentGuest().locator("#inc").click();
    await choose("状态主机 A"); await expect(currentGuest().locator("#count")).toHaveText("1");
    await expect(visible().getByRole("textbox", { name: "消息", exact: true })).toHaveValue("A 的草稿");
    await choose("状态主机 B"); await expect(currentGuest().locator("#count")).toHaveText("2");
    await expect(visible().getByRole("textbox", { name: "消息", exact: true })).toHaveValue("B 的草稿");
    await page.screenshot({ path: info.outputPath("host-state-isolated.png") });
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});
