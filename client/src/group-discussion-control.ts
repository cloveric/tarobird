import { groupDiscussionViewSchema, type GroupDiscussionAction } from "../../src/client-protocol/group-discussion.js";
import type { HubConnection } from "./connection.js";
import { timeoutSignal } from "./abort-signals.js";
import { t } from "./i18n.js";

/** A composer control belongs to the run the user saw, never a newer run. */
export async function controlComposerDiscussion(connection: HubConnection, conversationId: string, runId: string, action: GroupDiscussionAction) {
  const base = `/api/conversations/${conversationId}/discussion`;
  const current = groupDiscussionViewSchema.parse(await connection.http(`${base}?brief=1`, { signal: timeoutSignal(10_000) }));
  if (current.run?.id !== runId || current.run.conversationId !== conversationId || !current.run.actions?.includes(action)) {
    throw new Error(t("讨论或设置已变化，已保留输入。请核对最新状态后重试。"));
  }
  return groupDiscussionViewSchema.parse(await connection.http(`${base}/${runId}/control`, {
    method: "POST", body: JSON.stringify({ requestId: `gdc_${crypto.randomUUID()}`, revision: current.run.revision, action }), signal: timeoutSignal(30_000),
  }));
}
