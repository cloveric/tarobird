import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n.js";
import { documentHtml } from "./document-html.js";

export default function DocxPreview({ blob }: { blob: Blob }) {
  useLocale();
  const [state, setState] = useState<{ html?: string; error?: string }>({});
  useEffect(() => {
    let disposed = false, finished = false, worker: Worker | undefined;
    const stop = () => { clearTimeout(timer); worker?.terminate(); worker = undefined; };
    const fail = (reason = "invalid") => { finished = true; if (!disposed) setState({ error: reason }); stop(); };
    const timer = setTimeout(() => fail("timeout"), 15_000);
    setState({});
    if (blob.size > 10 * 1024 * 1024) { fail("large"); return stop; }
    void blob.arrayBuffer().then(bytes => {
      if (disposed || finished) return;
      worker = new Worker(new URL("./docx.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = event => { event.preventDefault(); fail(); };
      worker.onmessageerror = () => fail();
      worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => {
        if (disposed) return;
        if (event.data.error || typeof event.data.html !== "string") { fail(event.data.error); return; }
        try { setState({ html: documentHtml(event.data.html) }); stop(); } catch { fail("large"); }
      };
      worker.postMessage(bytes, [bytes]);
    }).catch(() => fail());
    return () => { disposed = true; stop(); };
  }, [blob]);
  if (state.error) return <p role="alert">{state.error === "large" ? t("文档过大或内容过于复杂，请另存为后打开。") : state.error === "timeout" ? t("文档预览超时，请另存为后打开。") : t("无法预览此 Word 文档，文件可能损坏或已加密。请另存为后打开。")}</p>;
  if (state.html === undefined) return <p role="status">{t("正在打开文档…")}</p>;
  return <><p className="document-preview-note">{t("阅读预览保留主要内容，复杂排版以原文件为准。")}</p><div className="document-scroll" tabIndex={0} role="region" aria-label={t("文档内容")}><article className="document-page docx-document" dangerouslySetInnerHTML={{ __html: state.html }}/></div></>;
}
