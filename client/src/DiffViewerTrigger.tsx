import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileDiff } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { isRunActive, nativeRun } from "../../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../../src/client-protocol/run-changes.js";
import type { HubConnection } from "./connection.js";
import { PageLoadBoundary } from "./PageLoadBoundary.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { useMessageOverlay } from "./message-overlay.js";
import { RunChangesEntryContext } from "./run-changes-entry.js";
import { t } from "./i18n.js";

type Viewer = typeof import("./RunDiffViewer.js").default;
let loadedViewer: Viewer | undefined, loadingViewer: Promise<Viewer> | undefined;
/** Load before presenting so exactly one sheet opens. A placeholder dialog
 * would slide in and then be replaced by the real one (two animations). */
function loadViewer(): Promise<Viewer> {
  return loadingViewer ??= import("./RunDiffViewer.js").then(module => (loadedViewer = module.default))
    .catch((error: unknown) => { loadingViewer = undefined; throw error; });
}
// Only reached when loading failed: the boundary then reports the failure.
const DiffViewer = lazy(() => loadViewer().then(component => ({ default: component })));

/** A reply's run and the counts saved with it. Counts are captured with the finished run, never scanned from disk. */
export function recordedRunChanges(message: Message) {
  const block = message.blocks.find(value => value.type === "card" && nativeRun(value));
  const run = block?.type === "card" ? nativeRun(block) : undefined;
  const parsed = runChangesSummarySchema.safeParse(block?.type === "card" ? block.extra?.runChanges : undefined);
  const summary = parsed.success && parsed.data.runId === run?.id && parsed.data.revision === run.revision ? parsed.data : undefined;
  const partial = !!run && (!!summary?.partial || !!run.detailsUnavailable || ["stopped", "error", "interrupted", "partial"].includes(run.phase));
  return { run, summary, partial };
}

/** On a reply the entry reads "本轮改动" and nothing else. The workspace rail passes its own content, which names the files. */
export function DiffViewerTrigger({ connection, message, children }: { connection: HubConnection; message: Message; children?: ReactNode }) {
  const active = useContext(RuntimeHostActiveContext);
  // On a reply (no children) the App may route 「本轮改动」 to the Files panel; the rail and the panel keep the viewer.
  const openInFiles = useContext(RunChangesEntryContext);
  const [open, setOpen] = useState(false), [opening, setOpening] = useState(false), request = useRef(0);
  const { run } = recordedRunChanges(message);
  const scope = JSON.stringify([connection.identity.hubPublicKey, connection.identity.deviceId, message.conversationId, message.authorId, message.id, run?.id]);
  useEffect(() => { request.current++; setOpen(false); setOpening(false); }, [scope, active]);
  useMessageOverlay(message.id, open && active);
  if (connection.state.user?.role !== "owner" || message.authorType !== "bot" || !run) return null;
  const show = () => {
    if (loadedViewer) { setOpen(true); return; }
    // A late chunk must not open a sheet for another message, host or view.
    const token = ++request.current; setOpening(true);
    void loadViewer().catch(() => undefined).finally(() => { if (token !== request.current) return; setOpening(false); setOpen(true); });
  };
  const Loaded = loadedViewer;
  return <><button type="button" title={t("查看本轮保存的修改。多次编辑按记录累计，不等于最终净变化。")} aria-busy={opening || undefined} onPointerDown={() => { void loadViewer().catch(() => undefined); }} onFocus={() => { void loadViewer().catch(() => undefined); }} onClick={() => { if (!children && openInFiles?.(message)) return; if (!opening) show(); }}>{children ?? <><FileDiff size={14}/><span>{t("本轮改动")}</span></>}</button>
    {open && active && createPortal(<PageLoadBoundary close={() => setOpen(false)}>{Loaded ? <Loaded key={scope} connection={connection} conversationId={message.conversationId} botId={message.authorId} messageId={message.id} runId={run.id} snapshotKey={isRunActive(run.phase) ? "active" : `${run.revision}:${run.phase}:${!!run.detailsUnavailable}`} close={() => setOpen(false)}/> : <Suspense fallback={null}><DiffViewer key={scope} connection={connection} conversationId={message.conversationId} botId={message.authorId} messageId={message.id} runId={run.id} snapshotKey={isRunActive(run.phase) ? "active" : `${run.revision}:${run.phase}:${!!run.detailsUnavailable}`} close={() => setOpen(false)}/></Suspense>}</PageLoadBoundary>, document.body)}
  </>;
}
