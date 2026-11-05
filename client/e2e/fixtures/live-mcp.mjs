// Synthetic local MCP endpoint for opt-in real-engine acceptance. It has no
// network operations and can only read/write the fixture's fixed paths.
import { createInterface } from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
const record = (event) => appendFile(path.join(root, "mcp-receipts.jsonl"), JSON.stringify(event) + "\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const tools = [
  { name: "read_probe", description: "Read the local acceptance nonce. No network or user files are accessed.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "write_probe", description: "Create acceptance-result.txt in the temporary test workspace, using the nonce returned by read_probe and the user's chosen color. Call only once after approval.", inputSchema: { type: "object", properties: { nonce: { type: "string" }, color: { type: "string" } }, required: ["nonce", "color"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") { send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tarocub-local-acceptance", version: "1.0.0" } }); continue; }
  if (message.method === "ping") { send(message.id, {}); continue; }
  if (message.method === "tools/list") { send(message.id, { tools }); continue; }
  if (message.method === "tools/call") {
    try {
      const nonce = (await readFile(path.join(root, "nonce.txt"), "utf8")).trim();
      let text;
      if (message.params.name === "read_probe") {
        await record({ tool: "read_probe" }); text = JSON.stringify({ nonce });
      } else if (message.params.name === "write_probe") {
        if (message.params.arguments?.nonce !== nonce || message.params.arguments?.color !== "蓝色") throw new Error("Expected the actual nonce and selected color");
        const file = path.join(root, "workspace", "acceptance-result.txt");
        await writeFile(file, `TAROCUB_MCP_OK\n${nonce}\n蓝色\n`);
        await record({ tool: "write_probe", color: "蓝色" }); text = JSON.stringify({ file, result: "TAROCUB_MCP_OK" });
      } else throw new Error("Unknown fixture tool");
      send(message.id, { content: [{ type: "text", text }] });
    } catch (error) { send(message.id, { isError: true, content: [{ type: "text", text: String(error.message) }] }); }
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n");
}
