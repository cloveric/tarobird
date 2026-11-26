const PROTOCOL = "tarobird.plugin.v1";

export type HostHelloInfo = {
  pluginId: string;
  scopeId?: string;
  theme: "light" | "dark";
  locale: string;
  grantedCapabilities: string[];
  conversationId?: string;
  botNames?: string[];
};

export type HostCanvasAgentEvent =
  | { type: "canvas.agent.hello"; clientId: string; protocolVersion: number; conversationId?: string }
  | { type: "canvas.agent.tool_call"; clientId: string; requestId: string; name: string; input: Record<string, unknown>; projectId?: string }
  | { type: "canvas.agent.tool_cancel"; clientId: string; requestId: string }
  | { type: "canvas.agent.closed"; clientId: string; reason?: string };

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const agentListeners = new Set<(event: HostCanvasAgentEvent) => void>();
let initialized = false;

function ensureListener(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("message", (event) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.protocol === PROTOCOL && typeof data.id === "string" && pending.has(data.id)) {
      const entry = pending.get(data.id)!;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(typeof data.error === "string" ? data.error : "host_error"));
      return;
    }
    if (typeof data.type === "string" && data.type.startsWith("canvas.agent.")) {
      for (const listener of agentListeners) {
        listener(data as unknown as HostCanvasAgentEvent);
      }
    }
  });
}

export function callHost<T = unknown>(method: string, extra: Record<string, unknown> = {}): Promise<T> {
  ensureListener();
  return new Promise<T>((resolve, reject) => {
    const id = `ic_${++seq}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ protocol: PROTOCOL, id, method, ...extra }, "*");
  });
}

export function subscribeCanvasAgentEvents(listener: (event: HostCanvasAgentEvent) => void): () => void {
  ensureListener();
  agentListeners.add(listener);
  return () => { agentListeners.delete(listener); };
}

export const hostBridge = {
  hello: () => callHost<HostHelloInfo>("host.hello"),
  storageGet: (key: string) => callHost<string | null>("storage.get", { key }),
  storageSet: (key: string, value: string) => callHost<boolean>("storage.set", { key, value }),
  storageRemove: (key: string) => callHost<boolean>("storage.remove", { key }),
  storageList: () => callHost<Record<string, string>>("storage.list"),
  storageClear: () => callHost<boolean>("storage.clear"),
  credentialsGet: (key: string) => callHost<string | null>("credentials.get", { key }),
  credentialsSet: (key: string, value: string) => callHost<boolean>("credentials.set", { key, value }),
  credentialsRemove: (key: string) => callHost<boolean>("credentials.remove", { key }),
  clipboardWrite: (text: string) => callHost<boolean>("clipboard.write", { text }),
  agentConnect: (clientId: string) => callHost<{ connected: boolean; protocolVersion: number; conversationId?: string }>("canvas.agent.connect", { clientId }),
  agentDisconnect: (clientId: string) => callHost<boolean>("canvas.agent.disconnect", { clientId }),
  agentState: (clientId: string, snapshot: { projectId: string; title: string } | null) => callHost<boolean>("canvas.agent.state", { clientId, snapshot }),
  agentActivate: (clientId: string) => callHost<boolean>("canvas.agent.activate", { clientId }),
  agentResult: (clientId: string, requestId: string, payload: { result?: unknown; error?: { code: string; message: string } }) =>
    callHost<boolean>("canvas.agent.result", { clientId, requestId, ...payload }),
};
