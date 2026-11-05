import React from "react";
import { createRoot } from "react-dom/client";
import RunDiffViewer from "../../src/RunDiffViewer.js";
import { DiffViewerTrigger } from "../../src/DiffViewerTrigger.js";
import { ClientCache, type Identity } from "../../src/storage.js";
import { HubConnection } from "../../src/connection.js";
import { HubHttpError } from "../../src/http-error.js";
import { Capacitor } from "@capacitor/core";
import { parseRecordedPatch, wholeFilePatch } from "../../../src/core/recorded-diff.js";
import { storedDiffReviewDraftSchema } from "../../src/diff-review-draft.js";
import "../../src/styles.css";
import "../../src/palette-tokens.css";

const params = new URLSearchParams(location.search), mode = params.get("mode"), suffix = params.get("run") ?? "one";
if (mode === "android") Capacitor.getPlatform = () => "android";
const identity = { deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] } as unknown as Identity;
const cache = new ClientCache("run-diff-viewer-fixture"); await cache.initializeIdentity(identity);
const connection = new HubConnection(identity, cache);
connection.state = { ...connection.state, workspaceDiffAvailable: true, status: "online", runChangesAvailable: mode !== "old", user: { id: "owner", role: "owner", name: "Owner" } as any, bots: [{ id: "bot", name: "Codex · 界面优化" }] as any };
const messageId = `message-${suffix}`, runId = `run-${suffix}`, revision = "a".repeat(64);
const item = (key: string, path: string, overrides = {}) => ({ key: key.repeat(64), path, edits: 2, generated: false, protected: false, additions: 4, deletions: 2, partial: false, ...overrides });
const files = [item("1", "/project/src/ReviewPanel.tsx"), item("2", "/project/large.txt", { edits: 1, additions: 2200, deletions: 0 }), item("3", "/project/.env", { protected: true, additions: null, deletions: null }), item("4", "/project/package-lock.json", { generated: true })];
const common = { scope: "recorded_run", messageId, conversationId: "conversation", botId: "bot", runId, revision, state: ["active", "expired", "not_recorded"].includes(mode ?? "") ? mode : "recorded", partial: mode === "partial", unavailable: 0, childEdits: 0 };
const requests: string[] = [], sent: unknown[] = [];
let busyRemaining = mode === "busy" ? 2 : 0;
connection.http = async (route: string, init?: RequestInit) => {
  requests.push(route); await new Promise(resolve => setTimeout(resolve, 15));
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (busyRemaining > 0) { busyRemaining--; throw new HubHttpError(429, "run_changes_busy"); }
  if (mode === "changing") throw new HubHttpError(409, "run_changes_changed");
  if (route.includes("/conversations/")) return { scope: "current_workspace", conversationId: "conversation", botId: "bot", capturedAt: Date.now(), state: mode === "live" ? "no_head" : "not_repository", head: null, notes: [], items: [], truncated: false } as any;
  const query = new URL(route, "http://fixture").searchParams, key = query.get("key");
  if (!key) return { ...common, items: common.state === "recorded" ? files : [], truncated: false } as any;
  const file = files.find(value => value.key === key)!;
  const op = query.get("operation") ?? "1-0", seq = Number(op.split("-")[0]), preview = query.get("preview") === "1", large = key === "2".repeat(64);
  const source = large ? wholeFilePatch("const generated = true;\n".repeat(2200), "add") : `@@ -1,2 +1,3 @@\n export function ReviewPanel() {\n-  return oldView;\n+  const selected = '${suffix}-${seq}';\n+  return selected;`;
  const parsed = parseRecordedPatch(source, preview ? 200 : 1000);
  const operation = (id: string) => ({ id, seq: Number(id.split("-")[0]), at: 1792400000000, additions: file.protected ? null : large ? 2200 : 2, deletions: file.protected ? null : large ? 0 : 1, format: file.protected ? "empty" : "unified", partial: false });
  const reason = file.protected ? "protected" : large && !preview ? "too_large" : null;
  return { ...common, file, operation: operation(op), operations: large ? [operation("1-0")] : [operation("1-0"), operation("2-0")], operationsTruncated: false,
    hunks: reason ? [] : parsed.hunks, reason, preview, truncated: large } as any;
};
const root = createRoot(document.getElementById("root")!);
const message = { id: messageId, conversationId: "conversation", authorId: "bot", authorType: "bot", blocks: [{ type: "card", elements: [], extra: { nativeRun: { version: 1, id: runId, revision: 1, phase: "done", startedAt: 1, updatedAt: 2, endedAt: 2, count: 2, completed: 2, failed: 0, truncated: false }, runChanges: { v: 1, runId, revision: 1, files: 1, edits: 2, additions: 4, deletions: 2, unavailable: 0, partial: false, childEdits: 0 } } }] } as any;
if (mode === "finish") { common.state = "active"; message.blocks[0].extra.nativeRun.phase = "working"; delete message.blocks[0].extra.runChanges; }
const render = () => root.render(["trigger", "finish"].includes(mode ?? "") ? <DiffViewerTrigger connection={connection} message={message}/> : <RunDiffViewer connection={connection} conversationId="conversation" botId="bot" messageId={messageId} runId={runId} close={() => root.render(<p>closed</p>)}/>);
render();
(window as any).runDiffFixture = {
  finish() { common.state = "recorded"; message.blocks[0].extra.nativeRun.phase = "done"; message.blocks[0].extra.nativeRun.revision++; render(); }, connection, cache, requests, sent, storedDiffReviewDraftSchema,
  async ack() { const entry = (await cache.outbox())[0]; if (entry) { sent.push(entry.frame); await (connection as any).ack(entry.id, true); } },
};
