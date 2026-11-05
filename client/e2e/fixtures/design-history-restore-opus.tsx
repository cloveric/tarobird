import "../../src/styles.css";
import { createRoot } from "react-dom/client";
import { WorkbenchDesignHistory } from "../../src/WorkbenchDesignHistory.js";
import type { DesignSession } from "../../src/workbench-design-session.js";

// Opus CC1: mounts the production history panel over a stub session so a
// restore failure followed by the list refresh can be driven exactly.
const row = (n: number, current = false) => ({ n, first: "x", at: "2026-11-03T06:00:00.000Z", by: "user" as const, name: "Owner", userId: "owner", revision: n, files: [{ path: "project/Main.dc.html", op: "edited" as const }], ...(current ? { current: true } : {}) });
const fixture = { lists: 0, restores: 0, failList: false, failRestore: "design_revision_conflict", restored: 0 };
(window as any).historyFixture = fixture;
const snapshot = { history: { status: "ok" } };
const session = {
  readOnly: false, shared: false,
  subscribe: () => () => undefined, getSnapshot: () => snapshot,
  async historyList() { fixture.lists++; if (fixture.failList) throw new Error("design_history_unavailable"); return { result: { rows: [row(2, true), row(1)], more: false } }; },
  async historyDiff() { return { result: { lines: [], added: 0, removed: 0 } }; },
  async restoreFromUi() { fixture.restores++; if (fixture.failRestore) throw new Error(fixture.failRestore); },
} as unknown as DesignSession;
// The panel opens upward from the status bar, as in the editor.
createRoot(document.getElementById("root")!).render(<div style={{ position: "fixed", insetInlineStart: 24, bottom: 24 }}><WorkbenchDesignHistory session={session} onRestored={() => { fixture.restored++; }}/></div>);
