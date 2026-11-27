import { openDB, type DBSchema } from "idb";
import { CANVAS_NODE_MAX_SOURCE_BYTES, canvasNetworkRequest, canvasNodeSourceURL } from "../electron/canvas-network.mjs";
import { sha256Hex } from "../../src/client-protocol/plugins.js";
import { validCanvasScope } from "./canvas-data-store.js";
import { invoke, isElectron } from "./desktop-bridge.js";

const MAX_NODES = 24;
const MAX_SCOPE_BYTES = 2 * 1024 * 1024;
const MAX_INSTALLATIONS = 64;
const textEncoder = new TextEncoder();

export type CanvasNodeInfo = Readonly<{ id: string; title: string; url: string; sha256: string }>;
export type PreparedCanvasNode = CanvasNodeInfo & Readonly<{ source: string }>;
export type CanvasNodeState = { enabled: boolean; plugins: CanvasNodeInfo[] };
type StoredState = { enabled: boolean; generation: string; plugins: PreparedCanvasNode[] };
type Mutation<T> = { next: StoredState | undefined; result: T };
type NodeSourceLoader = (url: string) => Promise<string>;

export interface CanvasNodeStore {
  read(scope: string): Promise<StoredState | undefined>;
  mutate<T>(scope: string, work: (prior: StoredState | undefined) => Mutation<T>): Promise<T>;
}

interface NodeDatabase extends DBSchema {
  scopes: { key: string; value: StoredState };
}

function indexedCanvasNodeStore(): CanvasNodeStore {
  let opening: ReturnType<typeof openDB<NodeDatabase>> | undefined;
  const open = () => {
    if (!globalThis.indexedDB) throw new Error("canvas_node_store_unavailable");
    return opening ??= openDB<NodeDatabase>("tarobird.plugin.canvas-nodes.v1", 1, {
      upgrade(db) { db.createObjectStore("scopes"); },
      blocking(_current, _next, event) { (event.target as IDBDatabase).close(); opening = undefined; },
      terminated() { opening = undefined; },
    }).catch(() => { opening = undefined; throw new Error("canvas_node_store_unavailable"); });
  };
  return {
    async read(scope) { return (await open()).get("scopes", scope); },
    async mutate(scope, work) {
      const tx = (await open()).transaction("scopes", "readwrite");
      void tx.done.catch(() => undefined);
      const prior = await tx.store.get(scope);
      const { next, result } = work(prior);
      if (!prior && next && await tx.store.count() >= MAX_INSTALLATIONS) throw new Error("canvas_node_quota_exceeded");
      if (next) await tx.store.put(next, scope);
      else if (prior) await tx.store.delete(scope);
      await tx.done;
      return result;
    },
  };
}

function requireScope(scope: string): void {
  if (!validCanvasScope(scope)) throw new Error("canvas_node_scope_invalid");
}

function sourceBytes(source: unknown): Uint8Array {
  if (typeof source !== "string" || source.length === 0 || source.length > CANVAS_NODE_MAX_SOURCE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(source)) {
    throw new Error("canvas_node_source_invalid");
  }
  const bytes = textEncoder.encode(source);
  if (bytes.byteLength > CANVAS_NODE_MAX_SOURCE_BYTES || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== source) {
    throw new Error("canvas_node_source_invalid");
  }
  return bytes;
}

function info({ id, title, url, sha256 }: CanvasNodeInfo): CanvasNodeInfo {
  return { id, title, url, sha256 };
}

function view(state: StoredState | undefined): CanvasNodeState {
  return { enabled: state?.enabled === true, plugins: (state?.plugins ?? []).map(info) };
}

function requireEnabled(state: StoredState | undefined): StoredState {
  if (!state?.enabled) throw new Error("canvas_nodes_disabled");
  return state;
}

async function describeSource(url: string, source: string): Promise<PreparedCanvasNode> {
  const bytes = sourceBytes(source);
  const [urlHash, sha256] = await Promise.all([sha256Hex(url), sha256Hex(bytes)]);
  const title = (url.split("/").at(-1) ?? "").slice(0, -3).slice(0, 120);
  return { id: `node_${urlHash.slice(0, 32)}`, title, url, sha256, source };
}

/** Trusted loader only. The App must check the Canvas installation's reviewed
 * domain grant before invoking it. Source requests carry no credential. */
export async function loadCanvasNodeSource(url: string): Promise<string> {
  const request = { kind: "source", httpMethod: "GET", url: canvasNodeSourceURL(url) } as const;
  const response = isElectron()
    ? await invoke<Awaited<ReturnType<typeof canvasNetworkRequest>>>("desktop_canvas_network", request)
    : await canvasNetworkRequest(request);
  if (response.status !== 200 || !(response.body instanceof Uint8Array)
    || response.body.byteLength > CANVAS_NODE_MAX_SOURCE_BYTES) throw new Error("canvas_node_source_invalid");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body);
}

export function createCanvasNodeRegistry(store: CanvasNodeStore = indexedCanvasNodeStore()) {
  const preparedRecords = new WeakMap<PreparedCanvasNode, { scope: string; generation: string }>();
  return {
    async get(scope: string): Promise<CanvasNodeState> {
      requireScope(scope);
      return view(await store.read(scope));
    },
    async setEnabled(scope: string, enabled: boolean): Promise<CanvasNodeState> {
      requireScope(scope);
      return store.mutate(scope, prior => {
        if (prior?.enabled === enabled || !prior && !enabled) return { next: prior, result: view(prior) };
        const next = { enabled, generation: crypto.randomUUID(), plugins: prior?.plugins ?? [] };
        return { next, result: view(next) };
      });
    },
    async prepare(scope: string, rawURL: string, loader: NodeSourceLoader): Promise<PreparedCanvasNode> {
      requireScope(scope);
      const url = canvasNodeSourceURL(rawURL);
      const { generation } = requireEnabled(await store.read(scope));
      const node = Object.freeze(await describeSource(url, await loader(url)));
      if (requireEnabled(await store.read(scope)).generation !== generation) throw new Error("canvas_node_review_expired");
      preparedRecords.set(node, { scope, generation });
      return node;
    },
    async install(scope: string, prepared: PreparedCanvasNode): Promise<CanvasNodeInfo> {
      requireScope(scope);
      const review = preparedRecords.get(prepared);
      if (!review || review.scope !== scope) throw new Error("canvas_node_review_expired");
      preparedRecords.delete(prepared);
      const node = await describeSource(canvasNodeSourceURL(prepared.url), prepared.source);
      if (node.id !== prepared.id || node.sha256 !== prepared.sha256) throw new Error("canvas_node_source_invalid");
      return store.mutate(scope, prior => {
        const current = requireEnabled(prior);
        if (current.generation !== review.generation) throw new Error("canvas_node_review_expired");
        const existing = current.plugins.find(plugin => plugin.id === node.id);
        if (existing) {
          if (existing.sha256 !== node.sha256) throw new Error("canvas_node_source_changed");
          return { next: current, result: info(existing) };
        }
        if (current.plugins.length >= MAX_NODES || [node, ...current.plugins].reduce((total, value) => total + textEncoder.encode(value.source).byteLength, 0) > MAX_SCOPE_BYTES) {
          throw new Error("canvas_node_quota_exceeded");
        }
        return { next: { ...current, plugins: [...current.plugins, node] }, result: info(node) };
      });
    },
    async remove(scope: string, id: string): Promise<boolean> {
      requireScope(scope);
      return store.mutate(scope, prior => {
        const plugins = prior?.plugins.filter(node => node.id !== id);
        if (!prior || !plugins || plugins.length === prior.plugins.length) return { next: prior, result: false };
        return { next: { ...prior, generation: crypto.randomUUID(), plugins }, result: true };
      });
    },
    async source(scope: string, id: string): Promise<PreparedCanvasNode> {
      requireScope(scope);
      const state = requireEnabled(await store.read(scope));
      const saved = state.plugins.find(node => node.id === id);
      if (!saved) throw new Error("canvas_node_not_installed");
      const checked = await describeSource(canvasNodeSourceURL(saved.url), saved.source);
      if (checked.id !== saved.id || checked.sha256 !== saved.sha256) throw new Error("canvas_node_source_invalid");
      const current = requireEnabled(await store.read(scope));
      if (current.generation !== state.generation || !current.plugins.some(node => node.id === id && node.sha256 === checked.sha256)) {
        throw new Error("canvas_node_review_expired");
      }
      return checked;
    },
    async clear(scope: string): Promise<void> {
      requireScope(scope);
      await store.mutate(scope, () => ({ next: undefined, result: undefined }));
    },
  };
}

export const canvasNodeRegistry = createCanvasNodeRegistry();
