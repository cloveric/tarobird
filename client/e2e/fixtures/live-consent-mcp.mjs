// Synthetic Computer Use consent only. Never opens an app or grants access to
// a browser; writes the received decision solely to the isolated test root.
import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2], pending = new Map();
let sequence = 0;
const emit = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
async function handle(frame) {
  if (!frame.method) { const resolve = pending.get(frame.id); pending.delete(frame.id); resolve?.(frame.result); return; }
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return emit({ id: frame.id, result: { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tarobird-consent-fixture", version: "1.0.0" } } });
  if (frame.method === "tools/list") return emit({ id: frame.id, result: { tools: [{ name: "consent_probe", description: "Present a synthetic consent form and return the user's decision. No browser or operating system access. Call once and wait for the user's response.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }] } });
  if (frame.method === "ping") return emit({ id: frame.id, result: {} });
  if (frame.method !== "tools/call" || frame.params.name !== "consent_probe") return emit({ id: frame.id, error: { code: -32601, message: "Unknown fixture method" } });
  const id = `consent-${++sequence}`, response = new Promise((resolve) => pending.set(id, resolve));
  emit({ id, method: "elicitation/create", params: { mode: "form", message: 'Allow Computer Use to use "Example Browser"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "tarobird-consent-fixture", connector_name: "Computer Use",
      persist: ["session", "always"], riskLevel: "high", subtitle: "Synthetic test only; no app access will be granted.",
      tool_name: "consent_probe", tool_params: { app: "com.example.browser" },
      tool_params_display: [{ name: "app", display_name: "App", value: "Example Browser" }] },
  } });
  const decision = await response;
  await appendFile(path.join(root, "consent-receipts.jsonl"), JSON.stringify(decision) + "\n");
  emit({ id: frame.id, result: { content: [{ type: "text", text: `CONSENT_PROBE_DONE ${JSON.stringify(decision)}` }] } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  void handle(frame).catch((error) => emit({ id: frame.id, error: { code: -32603, message: String(error.message) } }));
}
