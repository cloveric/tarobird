import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationWorkspace } from "../src/ConversationWorkspace.js";
import type { HubConnection } from "../src/connection.js";
import { ResourcesTriggerButton } from "../src/ResourcesPanel.js";
import { setLocale } from "../src/i18n.js";
import { HubHttpError } from "../src/http-error.js";

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
  Object.defineProperty(dom.document, "visibilityState", { get: () => visibility.hidden ? "hidden" : "visible" });
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
    state: { status: "online", user: { id: "member_example", role: "member" }, ...state },
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

const attachment = (name: string, mime: string) => ({
  attachmentId: "file_example", messageId: "msg_example", conversationId: "example",
  conversationTitle: "Example", name, mime, size: 10, authorId: "user_example",
  authorType: "user", authorName: "Example User", createdAt: baseline,
});

it("labels visible resource totals and marks a failed refresh as stale", async () => {
  const sample = { sampledAt: baseline, canStop: false, summary: { totalCpuPercent: 7, totalMemoryBytes: 128 * 1024 ** 2 } };
  const request = vi.fn()
    .mockResolvedValueOnce(sample)
    .mockRejectedValueOnce(new HubHttpError(503, "host_resources_timeout"))
    .mockResolvedValue({ ...sample, summary: { ...sample.summary, totalCpuPercent: 23 } });
  const conn = connection({ hostResources: request }, { hostResourcesAvailable: true });
  const trigger = (open: boolean) => createElement(ResourcesTriggerButton, { connection: conn, onOpen: noop, open });
  await act(async () => root.render(trigger(false)));
  expect(request).toHaveBeenCalledTimes(1);
  const button = container.querySelector("button")!;
  expect(button.getAttribute("title")).toContain("CPU 7.0%");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(button.getAttribute("title")).toContain("CPU 7.0%");
  expect(button.querySelector(".resources-footer-metrics")?.textContent).toContain("旧读数");
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain("可见进程");
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain("上次读数");
  expect(button.querySelector(".resources-footer-metrics")?.getAttribute("aria-hidden")).toBe("true");
  await act(async () => root.render(trigger(true)));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => root.render(trigger(false)));
  expect(request).toHaveBeenCalledTimes(3);
  expect(button.getAttribute("title")).toContain("CPU 23.0%");
  expect(button.getAttribute("title")).not.toContain("上次读数");
  visibility.hidden = true;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(request).toHaveBeenCalledTimes(3);
  visibility.hidden = false;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(request).toHaveBeenCalledTimes(4);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(request).toHaveBeenCalledTimes(4);
});

it("shows a loading state until the first file response returns", async () => {
  let provide!: (data: unknown) => void;
  const pending = new Promise(resolve => { provide = resolve; });
  await act(async () => root.render(workspace(connection({ http: () => pending }))));
  expect(container.textContent).toContain("正在读取产物…");
  expect(container.textContent).not.toContain("暂无本轮改动、工作台内容或对话文件。");
  await act(async () => provide({ items: [attachment("Example.png", "image/png")], nextCursor: null }));
  expect(container.textContent).not.toContain("正在读取产物…");
  expect(container.querySelector(".workspace-file-tile-name")?.textContent).toBe("Example.png");
});

it("reports a failed first file read and only shows empty after a successful retry", async () => {
  const http = vi.fn().mockRejectedValueOnce(new Error("fixture failure")).mockResolvedValue({ items: [], nextCursor: null });
  await act(async () => root.render(workspace(connection({ http }))));
  expect(container.textContent).toContain("暂时无法读取产物，请刷新。");
  expect(container.textContent).not.toContain("暂无本轮改动、工作台内容或对话文件。");
  const refresh = container.querySelector('button[aria-label="刷新工作区"]') as HTMLButtonElement;
  await act(async () => refresh.click());
  expect(container.textContent).toContain("暂无本轮改动、工作台内容或对话文件。");
});

it("does not claim a conversation is idle before the first supported queue read", async () => {
  let provide!: (data: unknown) => void;
  const pending = new Promise(resolve => { provide = resolve; });
  const http = (route: string) => route.includes("/queue?") ? pending : Promise.resolve({ items: [], nextCursor: null });
  await act(async () => root.render(workspace(connection({ http }, { promptQueueAvailable: true }))));
  expect(container.textContent).toContain("正在读取任务状态…");
  expect(container.textContent).not.toContain("当前空闲");
  await act(async () => provide({ supported: true, revision: "1", botId: "bot_example", conversationId: "example", items: [],
    capabilities: { reorder: false, edit: false, cancel: false } }));
  expect(container.textContent).toContain("当前空闲");
});

it("uses the same normalized MIME type for each file badge and description", async () => {
  const records = [attachment("scan.heic", "IMAGE/HEIC"), attachment("brief", "application/pdf; charset=binary")];
  const conn = connection({ http: async () => ({ items: records.map((file, i) => ({ ...file, attachmentId: "example_" + i })), nextCursor: null }) });
  await act(async () => root.render(workspace(conn)));
  const tiles = [...container.querySelectorAll(".workspace-file-tile")];
  expect(tiles[0]?.querySelector(".workspace-file-badge")?.textContent).toBe("IMG");
  expect(tiles[0]?.querySelector(".workspace-file-badge")?.classList.contains("is-img")).toBe(true);
  expect(tiles[0]?.querySelector(".workspace-file-tile-meta")?.textContent).toContain("图片");
  expect(tiles[1]?.querySelector(".workspace-file-badge")?.textContent).toBe("PDF");
  expect(tiles[1]?.querySelector(".workspace-file-tile-meta")?.textContent).toContain("PDF 文档");
});
