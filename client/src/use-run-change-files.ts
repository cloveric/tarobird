import { useEffect, useState, useSyncExternalStore } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import { runChangesSchema, type RunChanges } from "../../src/client-protocol/run-changes.js";
import type { HubConnection } from "./connection.js";
import { recordedRunChanges } from "./DiffViewerTrigger.js";
import { readRunEvidence } from "./run-changes-read.js";

/** The files one reply's recorded run changed, read from the Hub's record of that run (the same source as the
 * workspace rail's change summary). Until they arrive, or when they cannot be read, only the saved totals exist. */
export function useRunChangeFiles(connection: HubConnection, message: Message | undefined) {
  const state = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const recorded = message ? recordedRunChanges(message) : undefined;
  const [files, setFiles] = useState<RunChanges["items"]>();
  const run = recorded?.run, summary = recorded?.summary;
  const runId = run?.id, revision = run?.revision, messageId = message?.id, conversationId = message?.conversationId, botId = message?.authorId;
  const readable = !!summary && state.status === "online" && state.runChangesAvailable === true;
  useEffect(() => {
    setFiles(undefined);
    if (!runId || !readable || !messageId || !conversationId || !botId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ conversationId, botId, runId });
    void readRunEvidence(connection, `/api/messages/${encodeURIComponent(messageId)}/changes?${query}`, controller.signal).then(raw => {
      const value = runChangesSchema.parse(raw);
      if (controller.signal.aborted || value.messageId !== messageId || value.runId !== runId || value.state !== "recorded" || !value.items.length) return;
      setFiles(value.items);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [connection, messageId, conversationId, botId, runId, revision, readable]);
  return { summary, files, partial: !!recorded?.partial };
}
