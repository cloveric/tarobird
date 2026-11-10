#!/usr/bin/env node
// Synthetic model metadata only. Never handles a prompt, thread or model turn.
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const codex = process.argv.includes("app-server");
const stalled = process.env.FIXTURE_MODEL_DISCOVERY_SCENARIO === "stalled";
const log = value => { if (process.env.FIXTURE_MODEL_DISCOVERY_LOG) appendFileSync(process.env.FIXTURE_MODEL_DISCOVERY_LOG, JSON.stringify(value) + "\n"); };
log({ started: true });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  log({ method: message.method ?? message.request?.subtype });
  if (codex) {
    if (message.method === "initialize") {
      const reply = () => send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fixture" } });
      if (stalled) setTimeout(reply, 700); else reply();
    } else if (message.method === "model/list") {
      if (stalled) {
        // Two answered steps must not restart the total discovery deadline.
        if (!message.params?.cursor) setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { data: [], nextCursor: "stalled-page" } }), 700);
      } else send({ jsonrpc: "2.0", id: message.id, result: { data: [
        { model: "gpt-6.2-sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        { model: "gpt-next-no-effort", supportedReasoningEfforts: [] },
      ], nextCursor: null } });
    }
  } else if (!stalled && message.type === "control_request" && message.request?.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { models: [
      { value: "claude-fable-5-3", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
      { value: "claude-nova-6", supportsEffort: false },
    ] } } });
  }
});
