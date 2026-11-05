import { createRoot } from "react-dom/client";
import { ShareInbox } from "../../src/ShareInbox.js";
import { ClientCache } from "../../src/storage.js";
import type { SharedItem, ShareBridge } from "../../src/share-controller.js";
import type { HubConnection } from "../../src/connection.js";
import type { ClientFrame, Conversation } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";
const foreign = new URLSearchParams(location.search).get("scenario") === "foreign";
const archived = new URLSearchParams(location.search).get("scenario") === "archived";
const pin = { hubKey: "trusted-hub", deviceId: "device_one" };
const cache = new ClientCache("share-review-fixture"), identity = { ...pin, hubPublicKey: pin.hubKey, publicKey: "client-key", name: "Share fixture", routes: [] };
await cache.initializeIdentity(identity);
// ?scenario=archived: failed shares already pinned to an archived chat and to a topic of an archived group.
let items: SharedItem[] = archived ? [
  { id: "884b9026-9029-4a6b-ad36-cd40b6f9a241", createdAt: 1, text: "归档前的分享", files: [{ name: "report.txt", type: "text/plain", size: 5 }], delivery: { ...pin, conversationId: "conv_archived", text: "归档前的分享" } },
  { id: "5b3f0f86-7c1e-4f53-9d43-2f4c1e0a9b11", createdAt: 2, text: "话题分享", files: [], delivery: { ...pin, conversationId: "topic_closed", text: "话题分享", mentions: ["bot_beta"] } },
] : [{ id: "884b9026-9029-4a6b-ad36-cd40b6f9a241", createdAt: Date.now(), text: "来自系统分享的草稿", files: [] }];
if (foreign) items[0]!.delivery = { hubKey: "other-host", deviceId: "device_two", conversationId: "conv_one", text: items[0]!.text };
const calls: ClientFrame[] = [], prepares: unknown[] = []; let failNext = !archived;
// Late-response control: hold() parks the next list() with the inbox as it is now until release().
let holdNext = false, parked: (() => void) | undefined;
const native: ShareBridge = {
  list: async () => { const snapshot = structuredClone(items); if (holdNext) { holdNext = false; await new Promise<void>((resolve) => { parked = resolve; }); } return { items: snapshot }; },
  prepare: async ({ id, delivery }) => { prepares.push(structuredClone(delivery)); const item = items.find((i) => i.id === id)!; item.delivery ??= structuredClone(delivery); return structuredClone(item); },
  readChunk: async () => { throw new Error("not_a_file"); }, remove: async ({ id }) => { items = items.filter((i) => i.id !== id); }, setMaxFileBytes: async () => undefined, clear: async () => { items = []; },
};
const connection = { cache, identity, state: { status: "online", bots: [{ id: "bot_alpha", name: "Alpha" }, { id: "bot_beta", name: "Beta" }] }, send: async (frame: ClientFrame) => { if (failNext) { failNext = false; throw new Error("fixture_offline"); } calls.push(frame); } } as unknown as HubConnection;
const conversation = (id: string, title: string, type: "direct" | "group", closed = false, parentId?: string): Conversation => ({ id, title, type, ownerId: "owner", ...(parentId ? { parentId } : {}), botIds: type === "direct" ? ["bot_alpha"] : ["bot_alpha", "bot_beta"], archived: closed, createdAt: 0 });
let conversations: Conversation[] = [conversation("conv_one", "工作助手", "direct"), conversation("conv_archived", "旧助手", "direct", true), conversation("group_open", "研发群", "group"), conversation("topic_open", "发布", "group", false, "group_open"), conversation("group_closed", "旧群", "group", true), conversation("topic_closed", "复盘", "group", false, "group_closed")];
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<ShareInbox connection={connection} conversations={conversations} native={native} hosts={[{ hubKey: "other-host", deviceId: "device_two", name: "Mac mini", open: (conversationId) => Object.assign(window, { switchedShare: conversationId }) }]}/>);
Object.assign(window, { shareCalls: calls, sharePrepares: prepares, shareFixture: {
  pending: () => structuredClone(items),
  hold: () => { holdNext = true; }, held: () => !!parked, release: () => { parked?.(); parked = undefined; },
  add: (text: string) => { items = [...items, { id: "0f2a6c1e-3b4d-4e5f-8a9b-1c2d3e4f5a6b", createdAt: Date.now(), text, files: [] }]; },
  restore: () => { conversations = conversations.map((c) => ({ ...c, archived: false })); render(); },
} });
render();
