import { useState, type RefObject } from "react";
import { Copy } from "lucide-react";
import type { Block, Message } from "../../src/client-protocol/index.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { CreationDialog } from "./CreationDialog.js";
import { BackgroundTaskReference, type BackgroundSource } from "./BackgroundTaskReference.js";
import { MarkdownText } from "./MarkdownText.js";
import { runProse } from "./run-presentation.js";
import { t } from "./i18n.js";

/** Read the persisted report without requiring the expiring process journal. */
export function RunReport({ block, message, source, close, returnFocus, process, status }: {
  block: Extract<Block, { type: "card" }>; message: Message; source?: BackgroundSource;
  status?: string; close: () => void; returnFocus: RefObject<HTMLElement | null>; process?: () => void;
}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  const prose = runProse(block), notice = backgroundTaskNotice(block);
  const copy = async () => {
    try { await navigator.clipboard.writeText(prose.map(entry => entry.text!).join("\n\n")); setCopied(true); setError(false); }
    catch { setError(true); }
  };
  return <CreationDialog title={t(notice ? "后台任务结果" : "子代理回复")} closeLabel={t("关闭完整回复")} close={close} returnFocus={returnFocus} className="run-report-dialog" back>
    {status && <p className="run-details-meta">{status}</p>}
    <div className="run-report-body">
      {notice && <BackgroundTaskReference notice={notice} message={message} source={source ? { ...source, open: () => { close(); source.open(); } } : undefined}/>}
      {prose.length ? prose.map((entry, index) => <div className="card-text" key={entry.id ?? index}><MarkdownText text={entry.text!} reply/></div>) : <p className="muted">{t("暂无回复内容")}</p>}
    </div>
    <footer className="run-report-actions">
      <button type="button" disabled={!prose.length} onClick={() => void copy()}><Copy size={15}/>{copied ? t("已复制") : t("复制回复")}</button>
      {process && <button type="button" onClick={process}>{t("查看运行过程")}</button>}
      {error && <span role="alert">{t("复制失败，请手动选择内容。")}</span>}
    </footer>
  </CreationDialog>;
}
