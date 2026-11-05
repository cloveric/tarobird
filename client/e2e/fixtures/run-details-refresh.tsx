import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { HubConnection } from "../../src/connection.js";
import type { RunSummary } from "../../../src/client-protocol/run.js";
import type { Message } from "../../../src/client-protocol/index.js";
import { RunPresentation } from "../../src/RunPresentation.js";
import { RuntimeHostContext } from "../../src/RuntimeHost.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
// Include the shipping theme overrides: isolated base styles previously hid
// the duplicate CSS/SVG chevron regression from process-reader tests.
import "../../src/porcelain-details.css";

// Only the remote response latency is simulated. The real reader owns its
// requests, cancellation, revision refreshes, search and rendered state.
let requests = 0, aborted = 0, completed = 0;
let activeRequests = 0, maxActiveRequests = 0;
let terminal = false;
const params = new URL(location.href).searchParams;
let rowCount = params.has("empty") ? 0 : params.has("long") ? 30 : 1;
const thinkingRace = params.has("thinking-race");
let journalRevision = 1;
const connection = {
  identity: { hubPublicKey: "fixture", deviceId: "reader" },
  state: { status: "online", bots: [{ id: "alpha", online: true }] },
  subscribe: () => () => undefined,
  stopReceipt: () => undefined,
  http: async (url: string, options: RequestInit) => {
    requests++; activeRequests++; maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const responseRevision = journalRevision;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); aborted++; activeRequests--; reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); completed++; activeRequests--; resolve(); }, thinkingRace ? params.has("slow") ? 300 : 20 : 1200);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    const query = new URL(url, "https://fixture.test").searchParams.get("q");
    if (thinkingRace) return { entries: [{ seq: 1, revision: responseRevision, kind: "thinking", status: "done", at: 1, text: `PUBLIC_THOUGHT_${responseRevision}` }], next: params.has("history") ? 1 : null, expired: false, files: [] };
    return { entries: Array.from({ length: rowCount }, (_, index) => ({ seq: index + 1, revision: 1, kind: "tool", status: terminal ? "done" : "running", at: 1, name: query ? "WebSearch" : "Read", input: JSON.stringify(query ? { query } : { file_path: "/report.md" }) })), next: null, expired: false, files: [] };
  },
} as unknown as HubConnection;
// A schema-complete message: run cards read their own message's blocks (e.g. the
// changes trigger), exactly as every real Hub message provides them.
const message: Message = { id: "message", conversationId: "chat", authorId: "alpha", authorType: "bot", status: "streaming", version: 1, createdAt: 1, blocks: [{ type: "card", elements: [{ type: "markdown", text: "Running" }] }] };
const initial: RunSummary = { version: 1, id: "run", revision: thinkingRace ? 2 : 1, phase: thinkingRace || params.has("empty") ? "thinking" : "working", count: rowCount, completed: 0, failed: 0, startedAt: 1, updatedAt: 1, truncated: false };
function Fixture() {
  const [run, setRun] = useState(initial);
  Object.assign(window, { showRunEntries: () => { rowCount = 1; setRun(value => ({ ...value, count: 1, phase: "working", revision: value.revision + 1, updatedAt: Date.now() })); } });
  Object.assign(window, { runRefreshFixture: { maxActiveRequests: () => maxActiveRequests, commitThinking: (revision = 2) => { journalRevision = revision; }, finish: () => { terminal = true; setRun(value => ({ ...value, phase: "done", endedAt: Date.now() })); }, tick: () => setRun(value => ({ ...value, revision: value.revision + 1, updatedAt: Date.now() })), counts: () => ({ requests, aborted, completed }) } });
  return <RuntimeHostContext.Provider value="macmini"><RunPresentation run={run} message={message} block={{ type: "card", elements: [{ type: "markdown", text: "Running" }] }} connection={connection}/></RuntimeHostContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
