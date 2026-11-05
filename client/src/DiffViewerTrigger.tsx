import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileDiff } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { isRunActive, nativeRun } from "../../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../../src/client-protocol/run-changes.js";
import type { HubConnection } from "./connection.js";
import { PageLoadBoundary } from "./PageLoadBoundary.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { useMessageOverlay } from "./message-overlay.js";
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

/** Headline counts are captured with the finished run, never scanned from disk. */
export function DiffViewerTrigger({ connection, message }: { connection: HubConnection; message: Message }) {
  const active = useContext(RuntimeHostActiveContext);
  const [open, setOpen] = useState(false), [opening, setOpening] = useState(false), request = useRef(0);
  const block = message.blocks.find(value => value.type === "card" && nativeRun(value));
  const run = block?.type === "card" ? nativeRun(block) : undefined;
  const parsed = runChangesSummarySchema.safeParse(block?.type === "card" ? block.extra?.runChanges : undefined);
  const summary = parsed.success && parsed.data.runId === run?.id && parsed.data.revision === run.revision ? parsed.data : undefined;
  const scope = JSON.stringify([connection.identity.hubPublicKey, connection.identity.deviceId, message.conversationId, message.authorId, message.id, run?.id]);
  useEffect(() => { request.current++; setOpen(false); setOpening(false); }, [scope, active]);
  useMessageOverlay(message.id, open && active);
  if (connection.state.user?.role !== "owner" || message.authorType !== "bot" || !run) return null;
  const partial = summary?.partial || run.detailsUnavailable || ["stopped", "error", "interrupted", "partial"].includes(run.phase);
  const label = summary?.files ? t("改动 {0} 个文件", summary.files) + ` · +${summary.additions ?? "—"} −${summary.deletions ?? "—"}` + (partial ? ` · ${t("部分记录")}` : "") : t("本轮改动");
  const show = () => {
    if (loadedViewer) { setOpen(true); return; }
    // A late chunk must not open a sheet for another message, host or view.
    const token = ++request.current; setOpening(true);
    void loadViewer().catch(() => undefined).finally(() => { if (token !== request.current) return; setOpening(false); setOpen(true); });
  };
  const Loaded = loadedViewer;
  return <><button type="button" title={t("查看本轮保存的修改。多次编辑按记录累计，不等于最终净变化。")} aria-busy={opening || undefined} onPointerDown={() => { void loadViewer().catch(() => undefined); }} onFocus={() => { void loadViewer().catch(() => undefined); }} onClick={() => { if (!opening) show(); }}><FileDiff size={14}/><span>{label}</span></button>
    {open && active && createPortal(<PageLoadBoundary close={() => setOpen(false)}>{Loaded ? <Loaded key={scope} connection={connection} conversationId={message.conversationId} botId={message.authorId} messageId={message.id} runId={run.id} snapshotKey={isRunActive(run.phase) ? "active" : `${run.revision}:${run.phase}:${!!run.detailsUnavailable}`} close={() => setOpen(false)}/> : <Suspense fallback={null}><DiffViewer key={scope} connection={connection} conversationId={message.conversationId} botId={message.authorId} messageId={message.id} runId={run.id} snapshotKey={isRunActive(run.phase) ? "active" : `${run.revision}:${run.phase}:${!!run.detailsUnavailable}`} close={() => setOpen(false)}/></Suspense>}</PageLoadBoundary>, document.body)}
  </>;
}
