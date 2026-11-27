import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TerminalConfigure, TerminalOutput, TerminalSessionInfo, TerminalStatus } from "../../../src/client-protocol/host-terminal.js";
import type { HubConnection } from "../../src/connection.js";
import { HubHttpError } from "../../src/http-error.js";
import { HostTerminalSettings, TerminalPanel } from "../../src/TerminalPanel.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/side-conversation.css";
import "../../src/terminal.css";

interface FixtureState {
  status: "online" | "offline";
  hostTerminalAvailable: boolean;
  failStatusLoad: boolean;
  statusData: TerminalStatus;
  lists: Record<string, TerminalSessionInfo[]>;
  holdListFor?: string;
  releaseHeldList?: () => void;
  createCalls: Array<{ conversationId: string; cols: number; rows: number }>;
  inputCalls: Array<{ id: string; data: string }>;
  resizeCalls: Array<{ id: string; cols: number; rows: number }>;
  closeCalls: string[];
  close404Ids: Set<string>;
  outputCalls: Array<{ id: string; after: number; wait: number; aborted: boolean }>;
  outputMode: "ok" | "403" | "404" | "hold";
  configured: TerminalConfigure[];
  unauthorizedCount: number;
  busyEvents: boolean[];
}

const PUB_A = "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=";
const PUB_B = "MCowBQYDK2VwAyEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB0=";
const PUB_IOS = "MCowBQYDK2VwAyECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC0=";

const fixtureState: FixtureState = {
  status: "online",
  hostTerminalAvailable: true,
  failStatusLoad: false,
  statusData: {
    supported: true,
    enabled: true,
    allowed: true,
    canManage: true,
    policy: { revision: 1, enabled: true, grants: [{ deviceId: "dev_mac", publicKey: PUB_A }] },
    devices: [
      { id: "dev_mac", name: "Studio Mac", platform: "macos", publicKey: PUB_A },
      { id: "dev_win", name: "Work PC", platform: "windows", publicKey: PUB_B },
      { id: "dev_ios", name: "Pocket Phone", platform: "ios", publicKey: PUB_IOS },
    ],
    sessions: [],
  },
  lists: {
    conv_a: [
      { id: "term_a1", conversationId: "conv_a", title: "zsh #1", cwd: "/workspace/a", shell: "zsh", backend: "pty-script", running: true, exitCode: null, createdAt: 1, lastActivityAt: 1, cols: 100, rows: 28 },
    ],
    conv_b: [
      { id: "term_b1", conversationId: "conv_b", title: "zsh #2", cwd: "/workspace/b", shell: "zsh", backend: "pty-script", running: true, exitCode: null, createdAt: 2, lastActivityAt: 2, cols: 100, rows: 28 },
    ],
    conv_empty: [],
  },
  createCalls: [],
  inputCalls: [],
  resizeCalls: [],
  closeCalls: [],
  close404Ids: new Set(),
  outputCalls: [],
  outputMode: "ok",
  configured: [],
  unauthorizedCount: 0,
  busyEvents: [],
};

const listeners = new Set<() => void>();
let snapshot = {
  status: fixtureState.status,
  hostTerminalAvailable: fixtureState.hostTerminalAvailable,
  user: { id: "owner", name: "Owner", role: "owner" as const },
};

const notify = () => {
  snapshot = {
    status: fixtureState.status,
    hostTerminalAvailable: fixtureState.hostTerminalAvailable,
    user: { id: "owner", name: "Owner", role: "owner" as const },
  };
  for (const l of listeners) l();
};

let seqCounter = 0;

const fakeConnection = {
  identity: { hubPublicKey: "hub_key_fixture", deviceId: "dev_mac" },
  get state() { return snapshot; },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async terminalStatus(): Promise<TerminalStatus> {
    if (fixtureState.failStatusLoad) throw new HubHttpError(503, "unavailable");
    return structuredClone(fixtureState.statusData);
  },
  async terminalConfigure(raw: TerminalConfigure) {
    fixtureState.configured.push(raw);
    const next = { revision: raw.expectedRevision + 1, enabled: raw.enabled, grants: raw.grants };
    fixtureState.statusData = { ...fixtureState.statusData, enabled: next.enabled, policy: next };
    return next;
  },
  async terminalList(conversationId: string): Promise<TerminalSessionInfo[]> {
    if (fixtureState.holdListFor === conversationId) {
      await new Promise<void>((resolve) => { fixtureState.releaseHeldList = resolve; });
    }
    return structuredClone(fixtureState.lists[conversationId] ?? []);
  },
  async terminalCreate(input: { conversationId: string; cols?: number; rows?: number }): Promise<TerminalSessionInfo> {
    const cols = input.cols ?? 100;
    const rows = input.rows ?? 28;
    fixtureState.createCalls.push({ conversationId: input.conversationId, cols, rows });
    const created: TerminalSessionInfo = {
      id: `term_created_${fixtureState.createCalls.length}`,
      conversationId: input.conversationId,
      title: `zsh #${fixtureState.createCalls.length + 10}`,
      cwd: `/workspace/${input.conversationId}`,
      shell: "zsh",
      backend: "pty-script",
      running: true,
      exitCode: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      cols,
      rows,
    };
    fixtureState.lists[input.conversationId] = [...(fixtureState.lists[input.conversationId] ?? []), created];
    return created;
  },
  async terminalReadOutput(id: string, after: number, wait = 0, signal?: AbortSignal): Promise<TerminalOutput> {
    const entry = { id, after, wait, aborted: false };
    fixtureState.outputCalls.push(entry);
    if (fixtureState.outputMode === "403") throw new HubHttpError(403, "terminal_not_authorized");
    if (fixtureState.outputMode === "404") throw new HubHttpError(404, "terminal_not_found");
    if (fixtureState.outputMode === "hold") {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { entry.aborted = true; reject(new DOMException("Aborted", "AbortError")); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 4000);
      });
    }
    if (after === 0) {
      seqCounter += 1;
      return { id, seq: seqCounter, running: true, exitCode: null, chunks: [{ seq: seqCounter, data: `\x1b[38;2;0;31;1mREADY_${id}\x1b[0m\r\n` }] };
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { entry.aborted = true; reject(new DOMException("Aborted", "AbortError")); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 3000);
    });
    return { id, seq: after, running: true, exitCode: null, chunks: [] };
  },
  async terminalWriteInput(id: string, data: string) {
    fixtureState.inputCalls.push({ id, data });
  },
  async terminalResize(id: string, cols: number, rows: number) {
    fixtureState.resizeCalls.push({ id, cols, rows });
  },
  async terminalClose(id: string) {
    fixtureState.closeCalls.push(id);
    if (fixtureState.close404Ids.has(id)) throw new HubHttpError(404, "terminal_not_found");
    for (const key of Object.keys(fixtureState.lists)) {
      fixtureState.lists[key] = fixtureState.lists[key]!.filter((t) => t.id !== id);
    }
  },
} as unknown as HubConnection;

function AppFixture() {
  const [conv, setConv] = useState("conv_a");
  const [visible, setVisible] = useState(true);
  const [refreshKey, setRefreshKey] = useState("v1");
  return (
    <div className="app-shell has-side-panel" style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <aside className="sidebar" style={{ padding: 12 }}>
        <button type="button" onClick={() => setConv("conv_a")}>Conv A</button>
        <button type="button" onClick={() => setConv("conv_b")}>Conv B</button>
        <button type="button" onClick={() => setConv("conv_empty")}>Conv Empty</button>
        <button type="button" onClick={() => setVisible((v) => !v)}>Toggle Terminal</button>
        <button type="button" onClick={() => setRefreshKey((k) => `${k}+`)}>Bump Devices</button>
      </aside>
      <main className="conversation-main" style={{ flex: 1, minWidth: 0, padding: 12, overflowY: "auto" }}>
        <HostTerminalSettings
          connection={fakeConnection}
          active
          refreshKey={refreshKey}
          busyChange={(busy) => fixtureState.busyEvents.push(busy)}
        />
      </main>
      <TerminalPanel
        connection={fakeConnection}
        conversationId={conv}
        hostName="macmini"
        visible={visible}
        close={() => setVisible(false)}
        onUnauthorized={() => { fixtureState.unauthorizedCount += 1; }}
      />
    </div>
  );
}

const params = new URLSearchParams(location.search);
if (params.get("failStatus") === "1") fixtureState.failStatusLoad = true;
const strict = params.get("strict") === "1";
const node = document.getElementById("root")!;
createRoot(node).render(strict ? <StrictMode><AppFixture /></StrictMode> : <AppFixture />);

Object.assign(window, {
  terminalFixture: {
    state: fixtureState,
    setOnline(online: boolean) {
      fixtureState.status = online ? "online" : "offline";
      notify();
    },
    setFailStatusLoad(fail: boolean) {
      fixtureState.failStatusLoad = fail;
    },
    setOutputMode(mode: FixtureState["outputMode"]) {
      fixtureState.outputMode = mode;
    },
    holdList(convId?: string) {
      fixtureState.holdListFor = convId;
    },
    releaseList() {
      fixtureState.releaseHeldList?.();
      fixtureState.releaseHeldList = undefined;
      fixtureState.holdListFor = undefined;
    },
    markClose404(id: string) {
      fixtureState.close404Ids.add(id);
    },
  },
});
