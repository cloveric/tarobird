// Isolated stdio MCP fixture. Only a successful form response can write its
// fixed test file. No networking, arbitrary paths, or operator data access.
import { createInterface } from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2], pending = new Map();
let sequence = 0;
const emit = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const reply = (id, result) => emit({ id, result });
const record = (event) => appendFile(path.join(root, "elicitation-receipts.jsonl"), JSON.stringify(event) + "\n");
async function handle(frame) {
  if (!frame.method) { const resolve = pending.get(frame.id); pending.delete(frame.id); resolve?.(frame.result); return; }
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tarocub-elicitation-fixture", version: "1.0.0" } });
  if (frame.method === "ping") return reply(frame.id, {});
  if (frame.method === "tools/list") return reply(frame.id, { tools: [{ name: "create_probe", description: "Ask the user a native MCP form for color and note, then create the fixed test file and return its absolute path. Wait for the user's form response. Do not supply answers yourself.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } }] });
  if (frame.method !== "tools/call" || frame.params.name !== "create_probe") return emit({ id: frame.id, error: { code: -32601, message: "Unknown fixture method" } });
  const id = `form-${++sequence}`;
  const result = new Promise((resolve) => pending.set(id, resolve));
  emit({ id, method: "elicitation/create", params: { mode: "form", message: "MCP 文件验收", requestedSchema: { type: "object", properties: {
    color: { type: "string", title: "颜色", oneOf: [{ const: "blue", title: "蓝色" }, { const: "green", title: "绿色" }] },
    note: { type: "string", title: "文件说明", maxLength: 100 },
  }, required: ["color", "note"] } } });
  const response = await result;
  await record({ action: response?.action ?? "error" });
  if (response?.action !== "accept") return reply(frame.id, { isError: true, content: [{ type: "text", text: "The user cancelled the form. Do not retry." }] });
  if (response.content?.color !== "blue" || response.content?.note !== "手机确认") throw new Error("Expected actual phone choices");
  const nonce = (await readFile(path.join(root, "nonce.txt"), "utf8")).trim();
  const file = path.join(root, "workspace", "mcp-form-result.txt");
  await writeFile(file, `CODEX_MCP_FORM_OK\n${nonce}\nblue\n手机确认\n`);
  await record({ write: true });
  reply(frame.id, { content: [{ type: "text", text: JSON.stringify({ file, nonce, result: "CODEX_MCP_FORM_OK" }) }] });
}
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  void handle(frame).catch((error) => reply(frame.id, { isError: true, content: [{ type: "text", text: String(error.message) }] }));
}
