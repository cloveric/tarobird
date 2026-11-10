#!/usr/bin/env node
// Read-only Claude Code catalog fixture: answers `initialize` the way the CLI
// does (control_response with its /model rows) and never starts a session.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
if (process.env.FIXTURE_ARGS_FILE) writeFileSync(process.env.FIXTURE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const levels = ["low", "medium", "high", "xhigh", "max"];
const models = [
  { value: "default", resolvedModel: "claude-fable-5-2", displayName: "Default (recommended)", description: "Fable 5.2", supportsEffort: true, supportedEffortLevels: levels },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Complex work", supportsEffort: true, supportedEffortLevels: levels },
  { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "Toughest challenges", supportsEffort: true, supportedEffortLevels: levels },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fast", supportsEffort: true, supportedEffortLevels: levels },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "", supportsEffort: true, supportedEffortLevels: levels },
  { value: "claude-fable-5-3", resolvedModel: "claude-fable-5-3", displayName: "Fable 5.3", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "bad id", displayName: "Broken" },
];
const unavailable_models = [{ value: "claude-mythos-5-2", displayName: "Mythos 5.2", description: "Not available" }];
process.stdout.write(JSON.stringify({ type: "system", subtype: "hook_started" }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models, unavailable_models } } }) + "\n");
});
