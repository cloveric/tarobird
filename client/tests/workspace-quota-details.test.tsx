import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationWorkspace } from "../src/ConversationWorkspace.js";
import type { HubConnection } from "../src/connection.js";
import { UsageDetails } from "../src/UsageIndicators.js";
import { setLocale } from "../src/i18n.js";
import type { QuotaView } from "../src/usage-readings.js";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("../src/workbench-library.js", () => ({ listWorkbenchLibrary: async () => ({ entries: [] }) }));

const baseline = Date.parse("2026-11-28T10:00:00Z");
const noop = () => {};
let root: Root;
let container: HTMLElement;
let visibility: { hidden: boolean };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(baseline);
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  visibility = { hidden: false };
  Object.defineProperty(dom.document, "hidden", { get: () => visibility.hidden });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("Node", dom.Node);
  vi.stubGlobal("HTMLElement", dom.HTMLElement);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  setLocale("zh");
  container = document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function connection(extra = {}, state = {}) {
  return {
    subscribe: () => noop,
    state: { status: "online", user: { role: "member" }, ...state },
    isReadOnly: false,
    identity: { hubPublicKey: "synthetic-host" },
    http: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...extra,
  } as unknown as HubConnection;
}

type WorkspaceProps = ComponentProps<typeof ConversationWorkspace>;
function workspace(conn: HubConnection, options: Partial<WorkspaceProps> = {}) {
  return createElement(ConversationWorkspace, {
    id: "workspace",
    connection: conn,
    conversation: { id: "example", type: "direct", botIds: ["bot_example"] } as WorkspaceProps["conversation"],
    bots: [{ id: "bot_example", name: "Example Bot", engine: "codex", online: true }] as WorkspaceProps["bots"],
    botLabels: new Map(),
    hostName: "Example Host",
    connectionSummary: "5ms",
    streamingBots: [],
    messages: [],
    comms: undefined,
    commsLoading: false,
    onRefreshComms: noop,
    onClose: noop,
    onJumpConversation: noop,
    onLocateMessage: noop,
    onOpenAllFiles: noop,
    onOpenWorkbenchFile: noop,
    ...options,
  });
}

it("uses the Host clock and exposes stale quota details through a disclosure", async () => {
  const quota: QuotaView = {
    left: 42, windows: [{ id: "usage_example", label: "Primary", pool: "Example", left: 42, resetsAt: new Date(baseline + 10 * 60_000).toISOString() }],
    stale: true, blocked: [], observedAt: new Date(baseline).toISOString(), ageMs: 0,
  };
  const conn = connection({}, { serverTimeOffset: 5 * 60_000 });
  await act(async () => root.render(createElement("div", {}, workspace(conn, { quotaUsage: quota }),
    createElement(UsageDetails, { quota, serverTimeOffset: 5 * 60_000 }))));
  const row = container.querySelector(".workspace-quota-row")!;
  expect(row.getAttribute("title")).toContain("5 分钟后重置");
  expect(row.textContent).toContain("旧读数");
  expect(row.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toContain("旧读数");
  const details = row.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
  expect(details.getAttribute("aria-label")).toBe("额度详情");
  await act(async () => details.click());
  expect(details.getAttribute("aria-expanded")).toBe("true");
  const pane = document.getElementById(details.getAttribute("aria-controls")!)!;
  expect(pane.textContent).toContain("5 分钟后重置");
  expect(pane.textContent).toContain("上次读数");
});
