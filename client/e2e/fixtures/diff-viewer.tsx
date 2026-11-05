import React from "react";
import { createRoot } from "react-dom/client";
import DiffViewer from "../../src/DiffViewer.js";
import { ClientCache, type Identity } from "../../src/storage.js";
import { HubConnection } from "../../src/connection.js";
import { HubHttpError } from "../../src/http-error.js";
import { Capacitor } from "@capacitor/core";
import type { WorkspaceChange, WorkspaceFileDiff } from "../../../src/client-protocol/workspace-diff.js";
import "../../src/styles.css";
import "../../src/palette-tokens.css";
const params = new URLSearchParams(location.search), mode = params.get("mode");
if (params.has("emptyFont")) {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = (node, pseudo) => { const style = original(node, pseudo); return node.matches(".diff-code-scroll") ? new Proxy(style, { get(target, key) { if (key === "font") return ""; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }) : style; };
}
if (mode === "android") Capacitor.getPlatform = () => "android";
const identity = { deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "test", routes: [] } as unknown as Identity;
const cache = new ClientCache("diff-viewer-fixture"); await cache.initializeIdentity(identity);
const connection = new HubConnection(identity, cache);
connection.state = { ...connection.state, status: "online", workspaceDiffAvailable: mode !== "old", user: { id: "owner", role: "owner", name: "Owner" } as any, bots: [{ id: "bot", name: "Codex · 界面优化" }] as any };
const item = (path: string, other = {}): WorkspaceChange => ({ path, status: "modified", staged: false, unstaged: true, generated: false, kind: "file", protected: false, additions: 4, deletions: 1, ...other });
const items = [item("src/components/ReviewPanel.tsx"), item("src/theme.css"), item("large.txt"), item("image.png"), item("package-lock.json", { generated: true }), item(".env", { protected: true, additions: null, deletions: null })];
const common = { scope: "current_workspace", conversationId: "conversation", botId: "bot", head: "a".repeat(40), capturedAt: Date.now(), state: mode === "nongit" ? "not_repository" : "ready", notes: [] };
const normalLines = [
  { kind: "context", text: "export function ReviewPanel({ notes }) {", oldLine: 1, newLine: 1, clipped: false },
  { kind: "delete", text: "  const count = notes.length;", oldLine: 2, newLine: null, clipped: false },
  { kind: "add", text: "  const visibleNotes = notes.filter(note => !note.archived);", oldLine: null, newLine: 2, clipped: false },
  { kind: "add", text: "  const count = visibleNotes.length;", oldLine: null, newLine: 3, clipped: false },
  { kind: "add", text: "  if (!count) return <EmptyReview />;", oldLine: null, newLine: 4, clipped: false },
  { kind: "context", text: "  return <ReviewList notes={visibleNotes} />;", oldLine: 3, newLine: 5, clipped: false },
  { kind: "context", text: "}", oldLine: 4, newLine: 6, clipped: false },
];
if (mode === "widecode") normalLines[2]!.text = "中🙂".repeat(200) + "TAIL_MARKER";
if (mode === "shortcode") for (const line of normalLines) line.text = "x";
let removed = false;
const requests: string[] = [], sent: unknown[] = [];
connection.http = async (route: string, init?: RequestInit) => {
  requests.push(route); await new Promise(resolve => setTimeout(resolve, 20));
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (mode === "404") throw new HubHttpError(404, "not_found");
  if (mode === "missing") throw new HubHttpError(404, "conversation_not_found");
  if (mode === "gone") throw new HubHttpError(410, "bot_deleted");
  if (mode === "changing") throw new HubHttpError(409, "workspace_diff_changed_during_read");
  const path = new URL(route, "http://fixture").searchParams.get("path");
  if (!path) return { ...common, items: mode === "nongit" ? [] : removed ? items.slice(1) : items, truncated: false } as any;
  const large = path === "large.txt", preview = route.includes("preview=1"), binary = path === "image.png";
  return { ...common, file: items.find(i => i.path === path), binary, metadataOnly: binary || large && !preview, reason: binary ? "binary" : large ? "too_large" : null, truncated: large, preview, additions: 4, deletions: 1,
    notes: preview ? ["preview_prefix"] : [],
    hunks: binary || large && !preview ? [] : [{ header: large ? "@@ preview new:1-200 @@" : "@@ -1,4 +1,6 @@", oldStart: 1, oldLines: 4, newStart: 1, newLines: 6, lines: large ? Array.from({ length: 200 }, (_, i) => ({ kind: "add", text: `const row${i + 1} = ${i + 1};`, oldLine: null, newLine: i + 1, clipped: false })) : normalLines }] } as any;
};
const root = createRoot(document.getElementById("root")!);
root.render(<DiffViewer connection={connection} conversationId="conversation" botId="bot" close={() => root.render(<p>closed</p>)}/>);
(window as any).diffFixture = { connection, cache, requests, sent,
  removeFirst() { removed = true; },
  breakSave() { cache.saveDiffReviewDraft = async () => { throw new Error("draft_identity_changed"); }; },
  async ack() { const entry = (await cache.outbox())[0]; if (entry) { sent.push(entry.frame); await (connection as any).ack(entry.id, true); } },
  async fail() { const entry = (await cache.outbox())[0]; if (entry) { await cache.fail(entry.id, "permission_denied"); (connection as any).update({}, true); } },
};
