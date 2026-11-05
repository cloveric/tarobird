import { describe, expect, it } from "vitest";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "../src/connection.js";
import type { ConversationActivity } from "../src/storage.js";
import { buildConversationRows, type InboxHost, type InboxRow } from "../src/conversation-inbox.js";

// Pure projection checks for the two independent local pin lists. The browser
// journey (global-conversation-pins.spec.ts) covers rendering, focus and storage.
const chat = (id: string, title: string, createdAt: number, extra: Partial<Conversation> = {}): Conversation =>
  ({ id, type: "direct", title, ownerId: "owner", botIds: ["bot"], archived: false, createdAt, ...extra });
const group = (id: string, title: string, createdAt: number, extra: Partial<Conversation> = {}) => chat(id, title, createdAt, { type: "group", ...extra });
const topic = (id: string, title: string, parentId: string, createdAt: number, extra: Partial<Conversation> = {}) => group(id, title, createdAt, { parentId, ...extra });
const activity = (at: number, unread: string[] = [], preview = `preview ${at}`, attention: string[] = []): ConversationActivity => ({
  preview, at, lastContentSeq: at, unread: Object.fromEntries(unread.map((id, i) => [id, i + 1])),
  ...(attention.length ? { attention: Object.fromEntries(attention.map(id => [id, { kind: "question" as const, at }])) } : {}),
});
function host(id: string, conversations: Conversation[], options: { pins?: string[]; globalPins?: string[]; activity?: Record<string, ConversationActivity> } = {}): InboxHost {
  return { id, name: id, connection: {} as HubConnection, conversations, bots: [{ id: "bot", name: "助手", engine: "", model: "", effort: "", online: 1 }],
    activity: options.activity ?? {}, pins: options.pins ?? [], globalPins: options.globalPins };
}
const ids = (rows: InboxRow[]) => rows.map(row => row.key.replace("\0", "/"));
const globalIds = (rows: InboxRow[]) => ids(rows.filter(row => row.globallyPinned));
const unreadTotal = (rows: InboxRow[]) => rows.reduce((sum, row) => sum + row.unread, 0);
const rowFor = (rows: InboxRow[], hostId: string, id: string) => rows.find(row => row.hostId === hostId && row.conversation.id === id);

describe("global conversation pin projection", () => {
  it("keeps group pins and global pins independent, with global rows first and group pins only ordering the rest", () => {
    const conversations = [chat("old", "旧对话", 1), chat("mid", "中间", 2), chat("new", "最新", 3)];
    const base = buildConversationRows([host("a", conversations, { pins: ["old"] })]);
    expect(ids(base)).toEqual(["a/old", "a/new", "a/mid"]);
    expect(base.every(row => !row.globallyPinned)).toBe(true);
    const both = buildConversationRows([host("a", conversations, { pins: ["old"], globalPins: ["mid", "old"] })]);
    // Global rows sort by activity among themselves; a group pin does not lift
    // one global row above another, and the ordinary remainder keeps recency.
    expect(ids(both)).toEqual(["a/mid", "a/old", "a/new"]);
    expect(rowFor(both, "a", "old")).toMatchObject({ pinned: true, globallyPinned: true });
    expect(rowFor(both, "a", "mid")).toMatchObject({ pinned: false, globallyPinned: true });
    // Removing only the global pin restores the original group-pin order.
    expect(ids(buildConversationRows([host("a", conversations, { pins: ["old"], globalPins: ["mid"] })]))).toEqual(["a/mid", "a/old", "a/new"]);
    expect(ids(buildConversationRows([host("a", conversations, { pins: ["old"], globalPins: [] })]))).toEqual(ids(base));
    // A missing list (older directory snapshot) behaves like an empty one.
    expect(ids(buildConversationRows([host("a", conversations, { pins: ["old"] })]))).toEqual(ids(base));
  });

  it("scopes global pins by host even when conversation IDs coincide, with a deterministic order", () => {
    const same = [chat("same", "同名对话", 5)];
    const rows = buildConversationRows([host("b", same), host("a", same, { globalPins: ["same"] })]);
    expect(globalIds(rows)).toEqual(["a/same"]);
    expect(rowFor(rows, "b", "same")!.globallyPinned).toBe(false);
    expect(new Set(ids(rows)).size).toBe(rows.length);
    // Equal recency and title across hosts: the host-scoped key breaks the tie
    // independently of input order, so rows do not swap between renders.
    const both = (order: InboxHost[]) => globalIds(buildConversationRows(order));
    const a = host("a", same, { globalPins: ["same"] }), b = host("b", same, { globalPins: ["same"] });
    expect(both([a, b])).toEqual(["a/same", "b/same"]);
    expect(both([b, a])).toEqual(["a/same", "b/same"]);
  });

  it("ignores stale, archived and orphaned global pins without hiding anything else", () => {
    const conversations = [chat("live", "在用", 3), chat("archived", "已归档", 2, { archived: true }), group("g", "群", 1, { archived: true }), topic("t", "旧话题", "g", 1), topic("orphan", "孤儿话题", "missing", 1)];
    const rows = buildConversationRows([host("a", conversations, { globalPins: ["deleted", "archived", "t", "orphan"] })]);
    expect(ids(rows)).toEqual(["a/live"]);
    expect(globalIds(rows)).toEqual([]);
  });

  it("extracts a global topic from its live parent without double-counting unread, attention or previews", () => {
    const conversations = [group("g", "产品群", 1), topic("t1", "发布话题", "g", 2), topic("t2", "设计话题", "g", 3), chat("d", "私聊", 4)];
    const activityMap = {
      g: activity(10, ["g-1"]),
      t1: activity(30, ["t1-1", "t1-2"], "发布进度", ["t1-q"]),
      t2: activity(20, ["t2-1"], "设计稿"),
      d: activity(5, []),
    };
    const folded = buildConversationRows([host("a", conversations, { activity: activityMap })]);
    expect(ids(folded)).toEqual(["a/g", "a/d"]);
    expect(rowFor(folded, "a", "g")).toMatchObject({ unread: 4, topicTitles: ["发布话题", "设计话题"], previewTopic: "发布话题", activityAt: 30 });
    expect(rowFor(folded, "a", "g")!.attention.map(item => item.conversationId)).toEqual(["t1"]);

    const pinned = buildConversationRows([host("a", conversations, { activity: activityMap, globalPins: ["t1"] })]);
    expect(globalIds(pinned)).toEqual(["a/t1"]);
    expect(ids(pinned)).toEqual(["a/t1", "a/g", "a/d"]);
    const parent = rowFor(pinned, "a", "g")!, extracted = rowFor(pinned, "a", "t1")!;
    expect(parent).toMatchObject({ unread: 2, topicTitles: ["设计话题"], previewTopic: "设计话题", activityAt: 20 });
    expect(parent.attention).toEqual([]);
    expect(extracted).toMatchObject({ unread: 2, topicTitles: [], preview: "发布进度", activityAt: 30 });
    expect(extracted.attention.map(item => item.conversationId)).toEqual(["t1"]);
    // Every unread message is counted exactly once, before and after extraction.
    expect(unreadTotal(pinned)).toBe(unreadTotal(folded));
    // Unpinning folds the topic back with the original aggregate.
    expect(buildConversationRows([host("a", conversations, { activity: activityMap, globalPins: [] })])).toEqual(folded);
  });

  it("keeps a parent and its topic distinct when both are globally pinned, and keeps group-pinned topics folded", () => {
    const conversations = [group("g", "产品群", 1), topic("t1", "发布话题", "g", 2), topic("t2", "设计话题", "g", 3)];
    const activityMap = { g: activity(1, ["g-1"]), t1: activity(3, ["t1-1"]), t2: activity(2, ["t2-1"]) };
    const rows = buildConversationRows([host("a", conversations, { activity: activityMap, globalPins: ["g", "t1"], pins: ["t2"] })]);
    expect(ids(rows)).toEqual(["a/t1", "a/g"]);
    expect(rows.every(row => row.globallyPinned)).toBe(true);
    expect(rowFor(rows, "a", "g")).toMatchObject({ unread: 2, topicTitles: ["设计话题"] });
    expect(unreadTotal(rows)).toBe(3);
    // A group pin on a topic is presentation inside its group only; it never
    // creates an inbox row of its own.
    expect(ids(buildConversationRows([host("a", conversations, { activity: activityMap, pins: ["t2"] })]))).toEqual(["a/g"]);
  });

  it("drops a global topic once its parent is archived and restores it with the parent", () => {
    const live = [group("g", "产品群", 1), topic("t", "发布话题", "g", 2)];
    const archived = [group("g", "产品群", 1, { archived: true }), topic("t", "发布话题", "g", 2)];
    expect(globalIds(buildConversationRows([host("a", live, { globalPins: ["t"] })]))).toEqual(["a/t"]);
    expect(buildConversationRows([host("a", archived, { globalPins: ["t"] })])).toEqual([]);
    expect(globalIds(buildConversationRows([host("a", live, { globalPins: ["t"] })]))).toEqual(["a/t"]);
  });

  it("duplicated IDs in a pin list do not duplicate rows", () => {
    const rows = buildConversationRows([host("a", [chat("x", "X", 1), chat("y", "Y", 2)], { pins: ["x", "x"], globalPins: ["y", "y", "y"] })]);
    expect(ids(rows)).toEqual(["a/y", "a/x"]);
  });
});
