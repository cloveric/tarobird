import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch } from "lucide-react";
import type { Block, Message } from "../../src/client-protocol/index.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import type { HubConnection } from "./connection.js";
import { BackgroundTaskReference, type BackgroundSource } from "./BackgroundTaskReference.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { RunReport } from "./RunReport.js";
import { runProse } from "./run-presentation.js";
import { conversationPreview } from "./conversation-preview.js";
import { useRunReportPreview } from "./RunReportPreview.js";
import { useMessageOverlay } from "./message-overlay.js";
import { t } from "./i18n.js";
import "./run-presentation.css";

/** Only the producer's text report shape is collapsible. Interactive cards and
 * attachment elements keep their existing rendering and actions. */
export function isBackgroundReport(block: Extract<Block, { type: "card" }>): boolean {
  return !!backgroundTaskNotice(block) && block.elements.length >= 2
    && block.elements[0]?.type === "markdown" && block.elements.some(element => element.id === "background_context")
    && block.elements.every(element => element.type === "markdown");
}
export function BackgroundReport({ block, message, connection, source }: {
  block: Extract<Block, { type: "card" }>; message: Message; connection: HubConnection; source?: BackgroundSource;
}) {
  const hostActive = useContext(RuntimeHostActiveContext), trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const reportFocus = useMemo(() => ({ get current() { return trigger.current ?? card.current; } }), []);
  const key = JSON.stringify([connection.identity.hubPublicKey, connection.identity.deviceId, message.conversationId, message.id]);
  const [opened, open] = useState<string>();
  useLayoutEffect(() => { open(current => hostActive && current === key ? current : undefined); }, [hostActive, key]);
  useMessageOverlay(message.id, opened === key && hostActive);
  const { needsReader, preview } = useRunReportPreview(runProse(block).map(entry => entry.text!).join("\n\n"), false);
  const status = backgroundTaskNotice(block)?.delivery === "unconfirmed" ? t("交付未确认") : conversationPreview(block.elements[0]?.text ?? "") || t("后台任务");
  return <section ref={card} tabIndex={-1} className="native-run is-scoped background-report" aria-label={t("后台任务结果")}>
    <div className="native-run-heading"><span className="run-scope-heading"><GitBranch size={14}/>{status}</span></div>
    <BackgroundTaskReference notice={backgroundTaskNotice(block)!} message={message} source={source} compact/>
    {preview}
    {needsReader && <div className="native-run-actions"><button type="button" className="run-report-trigger" ref={trigger} onClick={() => open(key)}>{t("查看完整回复")}</button></div>}
    {opened === key && hostActive && createPortal(<RunReport key={key} status={status} block={block} message={message} source={source} close={() => open(undefined)} returnFocus={reportFocus}/>, document.body)}
  </section>;
}
