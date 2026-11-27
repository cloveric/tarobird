import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "../src/connection.js";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useSyncExternalStore: <T,>(
      subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ) => actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot),
  };
});
vi.mock("../src/mobile-screen-viewer-transport.js", () => ({ hasScreenViewer: () => false }));
vi.mock("../src/i18n.js", () => ({
  setLocale: () => {},
  useLocale: () => "zh",
  t: (key: string, ...values: (string | number | undefined)[]) =>
    key.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] === undefined ? match : String(values[Number(index)])),
  formatList: (items: Iterable<string>) => [...items].join("、"),
}));

import {
  crossHostFolderKey,
  emptyCrossHostFolderOrder,
  resetCrossHostFolderOrderCache,
  writeCrossHostFolderOrder,
} from "../src/cross-host-folder-order.js";
import { MobileHome } from "../src/MobileHome.js";
import { MobileListOptions } from "../src/MobileListOptions.js";
import { setLocale } from "../src/i18n.js";

function makeConn(hubPublicKey: string, folders: Array<{ id: string; name: string }>, assignments: Array<{ conversationId: string; folderId: string }>): HubConnection {
  const state = {
    status: "online" as const,
    bots: [{ id: "bot", name: "助手", engine: "codex", model: "", effort: "", online: 1 }],
    avatars: [],
    outbox: 0,
    cacheRevision: 1,
    foldersAvailable: true,
    folderReorderAvailable: true,
    folderPinAvailable: true,
    conversationFolders: { revision: 1, folders, assignments },
  };
  return {
    state,
    identity: { deviceId: "d1", name: "d1", platform: "ios", publicKey: "pk", hubPublicKey, routes: [] },
    cache: { subscribeDrafts: () => () => {}, draftPreview: async () => "" },
    isReadOnly: false,
    isClosed: false,
    subscribe: () => () => {},
  } as unknown as HubConnection;
}

const chat = (id: string, title: string): Conversation => ({
  id, type: "direct", title, ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1,
});

afterEach(() => {
  resetCrossHostFolderOrderCache();
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.unstubAllGlobals();
  setLocale("zh");
});

describe("mobile cross-host retention with 1 temporarily-ready host (#92 / #152)", () => {
  it("retains combined cross-host folder order and host badge when registeredHostCount > 1 and only 1 host is ready", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    });
    resetCrossHostFolderOrderCache();
    setLocale("zh");

    const hubKeyA = "hubKeyA";
    const hubKeyB = "hubKeyB";
    writeCrossHostFolderOrder({
      version: 1,
      pinned: [],
      ordinary: [
        crossHostFolderKey({ hostKey: hubKeyA, folderId: "f2" }),
        crossHostFolderKey({ hostKey: hubKeyA, folderId: "f1" }),
        crossHostFolderKey({ hostKey: hubKeyA, folderId: null }),
        crossHostFolderKey({ hostKey: hubKeyB, folderId: "f3" }),
      ],
    });

    const connA = makeConn(hubKeyA, [{ id: "f1", name: "分组 1" }, { id: "f2", name: "分组 2" }], [
      { conversationId: "c1", folderId: "f1" },
      { conversationId: "c2", folderId: "f2" },
    ]);
    const hostA = {
      id: "hostA",
      name: "macmini",
      connection: connA,
      conversations: [chat("c1", "对话 1"), chat("c2", "对话 2")],
      bots: connA.state.bots,
      activity: {},
      pins: [],
      globalPins: [],
    };

    const html = renderToStaticMarkup(
      <MobileHome
        hosts={[hostA]}
        registeredHostCount={2}
        activeHostId="hostA"
        tab="messages"
        setTab={() => {}}
        select={() => {}}
        newChat={() => {}}
        settingsBot={() => {}}
        create={() => {}}
        selectHost={() => {}}
        open={() => {}}
        searchHistory={() => {}}
      />,
    );

    const idxF2 = html.indexOf("分组 2");
    const idxF1 = html.indexOf("分组 1");
    expect(idxF2).toBeGreaterThan(-1);
    expect(idxF1).toBeGreaterThan(idxF2);
    expect(html).toContain("macmini");

    // MobileListOptions renders "按主机分组" toggle even when only 1 of 2 registered hosts is ready.
    const listOptsHtml = renderToStaticMarkup(
      <MobileListOptions
        hosts={[hostA]}
        registeredHostCount={2}
        activeHostId="hostA"
        visible={false}
        disabled={false}
        groupByHost={false}
        changeGroupByHost={() => {}}
        showDisconnectedBots={false}
        changeShowDisconnectedBots={() => {}}
      />,
    );
    expect(listOptsHtml).toContain("列表选项");
    writeCrossHostFolderOrder(emptyCrossHostFolderOrder(), { fromSync: true });
  });
});
