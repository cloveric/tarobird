import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { runChangesSchema, type RunChanges } from "../../src/client-protocol/run-changes.js";
import type { HubConnection } from "./connection.js";
import { DiffCounts } from "./DiffCounts.js";
import { DiffViewerTrigger, recordedRunChanges } from "./DiffViewerTrigger.js";
import { readRunEvidence } from "./run-changes-read.js";
import { t } from "./i18n.js";

/** A narrow rail: three names say what a turn touched; the rest is a count. */
const NAMED = 3;
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function RatioBar({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  const add = Math.max(0, additions ?? 0);
  const del = Math.max(0, deletions ?? 0);
  const total = add + del;
  if (total === 0) return null;
  const addPct = add === 0 ? 0 : del === 0 ? 100 : Math.min(92, Math.max(8, Math.round((add / total) * 100)));
  const delPct = 100 - addPct;
  return (
    <span className="workspace-diff-bar" aria-hidden="true">
      {addPct > 0 && <i className="is-add" style={{ width: `${addPct}%` }} />}
      {delPct > 0 && <i className="is-del" style={{ width: `${delPct}%` }} />}
    </span>
  );
}

/** One reply's recorded changes in the workspace rail: plain-language summary + green/red bar + per-file counts.
 *  The names are the Hub's record of that run. Until they arrive, or when they cannot be read (offline, an older
 *  Host), the totals saved on the reply stand in. Opening it shows the same recorded changes as the reply does. */
export function WorkspaceRunChanges({ connection, message }: { connection: HubConnection; message: Message }) {
  const state = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const { run, summary, partial } = recordedRunChanges(message);
  const [files, setFiles] = useState<RunChanges["items"]>();
  const runId = run?.id, revision = run?.revision, messageId = message.id, conversationId = message.conversationId, botId = message.authorId;
  const readable = !!summary && state.status === "online" && state.runChangesAvailable === true;
  useEffect(() => {
    setFiles(undefined);
    if (!runId || !readable) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ conversationId, botId, runId });
    void readRunEvidence(connection, `/api/messages/${encodeURIComponent(messageId)}/changes?${query}`, controller.signal).then(raw => {
      const value = runChangesSchema.parse(raw);
      if (controller.signal.aborted || value.messageId !== messageId || value.runId !== runId || value.state !== "recorded" || !value.items.length) return;
      setFiles(value.items);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [connection, messageId, conversationId, botId, runId, revision, readable]);
  if (!summary) return null;
  const named = files?.slice(0, NAMED), more = named ? Math.max(summary.files, files!.length) - named.length : 0;
  const note = [more > 0 ? t("还有 {0} 个文件", more) : "", partial ? t("部分记录") : ""].filter(Boolean).join(" · ");
  // "2 个文件已更改 +14 -3": the totals use the same green/red counts as the file rows below.
  const plainSummary = summary.files === 1 ? t("1 个文件已更改") : t("{0} 个文件已更改", summary.files);
  return <div className="workspace-diff-row"><DiffViewerTrigger connection={connection} message={message}>
    <span className="workspace-diff-files">
      <span className="workspace-diff-summary">
        <FileDiff size={14} aria-hidden="true"/>
        <span className="workspace-diff-summary-text">{plainSummary}</span>
        <DiffCounts additions={summary.additions} deletions={summary.deletions} className="workspace-diff-summary-counts"/>
        <ChevronRight size={13} className="workspace-diff-chevron" aria-hidden="true"/>
      </span>
      <RatioBar additions={summary.additions} deletions={summary.deletions} />
      {named ? named.map(file => <span key={file.key} className="workspace-diff-file"><span className="workspace-diff-name" title={file.path}>{fileName(file.path)}</span><DiffCounts additions={file.additions} deletions={file.deletions} className="workspace-diff-counts"/></span>)
        : <span className="workspace-diff-file"><span className="workspace-diff-name">{t("改动 {0} 个文件", summary.files)}</span><DiffCounts additions={summary.additions} deletions={summary.deletions} className="workspace-diff-counts"/></span>}
      {note && <span className="workspace-diff-note">{note}</span>}
    </span>
  </DiffViewerTrigger></div>;
}
