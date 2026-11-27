import { afterEach, expect, it, vi } from "vitest";
import { decodeStoredValue, encodeStoredValue, makeCollection } from "../integrations/infinite-canvas/overlay/collection";
import { providerFetch, setAllowedDomains } from "../integrations/infinite-canvas/overlay/provider";

afterEach(() => {
  setAllowedDomains({});
  vi.unstubAllGlobals();
});

it("stores binary canvas resources separately from JSON and round-trips their MIME type", async () => {
  const blob = new Blob([new Uint8Array([0, 255, 20, 16])], { type: "image/png" });
  const restored = decodeStoredValue(await encodeStoredValue(blob)) as Blob;
  expect(restored.type).toBe("image/png");
  expect([...new Uint8Array(await restored.arrayBuffer())]).toEqual([0, 255, 20, 16]);
  const json = { nodes: [{ id: "synthetic", content: "one\ntwo" }] };
  expect(decodeStoredValue(await encodeStoredValue(json))).toEqual(json);
});

it("keeps upstream stores distinct while listing and clearing through the scoped host", async () => {
  const data = new Map<string, Uint8Array>();
  const host = {
    dataGet: async (key: string) => data.get(key) ?? null,
    dataPut: async (key: string, value: Uint8Array): Promise<true> => { data.set(key, value); return true; },
    dataKeys: async () => [...data.keys()],
    dataRemove: async (key: string): Promise<true> => { data.delete(key); return true; },
  };
  const projects = makeCollection("projects", host);
  const preferences = makeCollection("preferences", host);
  await projects.setItem("shared-key", { nodes: [] });
  await preferences.setItem("shared-key", "dark");
  expect(await projects.iterate((value, key) => ({ value, key }))).toEqual({ value: { nodes: [] }, key: "shared-key" });
  await projects.clear();
  expect(await projects.getItem("shared-key")).toBeNull();
  expect(await preferences.getItem("shared-key")).toBe("dark");
});

it("requires a grant and allows only canvas generation operations", async () => {
  await expect(providerFetch("https://api.openai.com/v1/models")).rejects.toThrow("MODEL_DESTINATION_DENIED");
  setAllowedDomains({ grantedDomains: ["api.openai.com"] });
  await expect(providerFetch("https://api.openai.com.example.invalid/v1/models")).rejects.toThrow("MODEL_DESTINATION_DENIED");
  await expect(providerFetch("https://api.openai.com:8443/v1/models")).rejects.toThrow("MODEL_DESTINATION_DENIED");
  await expect(providerFetch("https://api.openai.com/v1/files")).rejects.toThrow("MODEL_ENDPOINT_DENIED");
  await expect(providerFetch("https://api.openai.com/v1/models", { method: "POST" })).rejects.toThrow("MODEL_ENDPOINT_DENIED");
  await expect(providerFetch("https://api.openai.com/v1/responses")).rejects.toThrow("MODEL_ENDPOINT_DENIED");
});

it("passes only bounded provider fields through the Canvas broker and restores the response", async () => {
  setAllowedDomains({ grantedDomains: ["api.openai.com"] });
  let receive!: (message: { source: unknown; data: unknown }) => void;
  const requests: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage(request: Record<string, unknown>) {
      requests.push(request);
      receive({ source: parent, data: {
        protocol: request.protocol, id: request.id, ok: true,
        result: { status: 200, contentType: "application/json", body: new TextEncoder().encode('{"data":[]}') },
      } });
    },
  };
  vi.stubGlobal("window", { parent, addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } });
  const input = JSON.stringify({ model: "fixture", prompt: "draw a triangle" });
  const response = await providerFetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    body: input,
    headers: { "Content-Type": "application/json", Cookie: "untrusted", "X-Private": "ignored" },
  });
  expect(await response.json()).toEqual({ data: [] });
  expect(requests).toEqual([{
    protocol: "tarobird.plugin.v1",
    id: expect.any(String),
    method: "canvas.provider.request",
    httpMethod: "POST",
    url: "https://api.openai.com/v1/images/generations",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(input),
  }]);
});

it("keeps prompt-source requests restricted to approved JSON without sharing provider headers", async () => {
  const { fetchApprovedPromptSource } = await import("../integrations/infinite-canvas/overlay/provider");
  const official = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json";
  await expect(fetchApprovedPromptSource(official)).rejects.toThrow("PROMPT_SOURCE_DENIED");
  setAllowedDomains({ grantedDomains: ["raw.githubusercontent.com"] });
  await expect(fetchApprovedPromptSource(official + "?unexpected=value")).rejects.toThrow("PROMPT_SOURCE_DENIED");
  await expect(fetchApprovedPromptSource(official.replace("awesome-gpt-image", "unapproved"))).rejects.toThrow("PROMPT_SOURCE_DENIED");
  await expect(providerFetch(official)).rejects.toThrow("MODEL_ENDPOINT_DENIED");
});

it("uses the five native v12 node types for Agent calls while keeping UI plugin types separate", async () => {
  const { CANVAS_AGENT_PROTOCOL_VERSION, canvasToolInputSchemas } = await import("../src/client-protocol/infinite-canvas");
  const native = ["image", "text", "video", "audio", "group"];
  expect(CANVAS_AGENT_PROTOCOL_VERSION).toBe(12);
  expect(canvasToolInputSchemas.canvas_get_state.safeParse({ types: native }).success).toBe(true);
  expect(canvasToolInputSchemas.canvas_apply_ops.safeParse({
    ops: [
      ...native.map(nodeType => ({ type: "add_node", nodeType })),
      { type: "update_node", id: "node", patch: { metadata: { content: "fixture" } } },
      { type: "set_group_members", groupId: "group", nodeIds: ["node"] },
      { type: "set_viewport", viewport: { x: 0, y: 0, k: 1 } },
      { type: "run_generation", nodeId: "image", mode: "image" },
    ],
  }).success).toBe(true);
  for (const nodeType of ["html", "markdown", "svg", "panorama", "template", "sticky-note", "panorama:viewer"]) {
    expect(canvasToolInputSchemas.canvas_get_state.safeParse({ types: [nodeType] }).success).toBe(false);
    expect(canvasToolInputSchemas.canvas_apply_ops.safeParse({ ops: [{ type: "add_node", nodeType }] }).success).toBe(false);
  }
});

it("offers only immutable GitHub Raw JS sources for third-party node confirmation", async () => {
  const { approvedNodeSource } = await import("../integrations/infinite-canvas/overlay/node-addons-api");
  const commit = "a".repeat(40);
  const url = `https://raw.githubusercontent.com/fixture/renderer/${commit}/nodes/render.js`;
  expect(approvedNodeSource(`  ${url}  `)).toBe(url);
  for (const invalid of [
    url.replace(commit, "main"), url.replace(commit, "deadbeef"), url.replace("render.js", "render.html"),
    url.replace("githubusercontent.com", "githubusercontent.com.example.invalid"),
    url.replace("nodes/", "../"), url.replace("nodes/", "%2e%2e/"),
    url + "?new=true", url + "#fragment", url.replace(".com/", ".com:443/"),
  ]) expect(approvedNodeSource(invalid)).toBeNull();
});

it("limits third-party output to text and a CSS-safe hex color", async () => {
  const { NODE_TEXT_LIMIT, safeNodeOutput } = await import("../integrations/infinite-canvas/overlay/node-addons-api");
  const text = "<img src=remote>";
  expect(safeNodeOutput({ text, color: "url(https://example.invalid/image)" })).toEqual({ text, color: undefined });
  expect(safeNodeOutput({ text: "a".repeat(NODE_TEXT_LIMIT + 1), color: "#ABC129" })).toEqual({
    text: "a".repeat(NODE_TEXT_LIMIT), color: "#ABC129",
  });
});

it("routes node actions to the host and only sends bounded text and title for rendering", async () => {
  vi.resetModules();
  const { nodeAddonsApi, NODE_TEXT_LIMIT, NODE_TITLE_LIMIT } = await import("../integrations/infinite-canvas/overlay/node-addons-api");
  let receive!: (message: { source: unknown; data: unknown }) => void;
  const requests: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage(request: Record<string, unknown>) {
      requests.push(request);
      receive({ source: parent, data: { protocol: request.protocol, id: request.id, ok: true, result: {} } });
    },
  };
  vi.stubGlobal("window", { parent, addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } });
  const url = `https://raw.githubusercontent.com/fixture/renderer/${"a".repeat(40)}/node.js`;
  await nodeAddonsApi.list();
  await nodeAddonsApi.enable(true);
  await nodeAddonsApi.install(url);
  await nodeAddonsApi.render("fixture", "t".repeat(NODE_TEXT_LIMIT + 1), "T".repeat(NODE_TITLE_LIMIT + 1));
  await nodeAddonsApi.enable(false);
  await nodeAddonsApi.remove("fixture");
  expect(requests.map(({ id, protocol, ...request }) => request)).toEqual([
    { method: "canvas.nodes.list" },
    { method: "canvas.nodes.enable", enabled: true },
    { method: "canvas.nodes.install", url },
    { method: "canvas.nodes.render", pluginId: "fixture", node: { text: "t".repeat(NODE_TEXT_LIMIT), title: "T".repeat(NODE_TITLE_LIMIT) } },
    { method: "canvas.nodes.enable", enabled: false },
    { method: "canvas.nodes.remove", pluginId: "fixture" },
  ]);
});
