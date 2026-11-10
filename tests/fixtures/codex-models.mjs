#!/usr/bin/env node
// Read-only Codex app-server catalog fixture: initialize, then a two-page
// model/list. Never opens a thread.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
if (process.env.FIXTURE_ARGS_FILE) writeFileSync(process.env.FIXTURE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const all = ["low", "medium", "high", "xhigh", "max", "ultra"].map(reasoningEffort => ({ reasoningEffort, description: "" }));
const row = (model, displayName, efforts, extra = {}) => ({ id: model, model, displayName, description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: efforts, ...extra });
const pages = {
  "": { data: [row("gpt-6.1-sol", "GPT-6.1-Sol", all, { isDefault: true }), row("gpt-6.2-sol", "GPT-6.2-Sol", all)], nextCursor: "page-2" },
  "page-2": { data: [row("gpt-6-luna", "GPT-6-Luna", all.slice(0, 5)), row("gpt-internal", "Internal", all, { hidden: true })], nextCursor: null },
};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { userAgent: "fixture" });
  else if (message.method === "model/list") reply(message.id, pages[message.params?.cursor ?? ""]);
});
