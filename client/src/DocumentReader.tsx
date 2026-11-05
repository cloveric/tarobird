import { Component, lazy, Suspense, type ReactNode } from "react";
import { MarkdownText } from "./MarkdownText.js";
import { t, useLocale } from "./i18n.js";
import "./document-preview.css";

const Spreadsheet = lazy(() => import("./SpreadsheetPreview.js"));
const Word = lazy(() => import("./DocxPreview.js"));
class DocumentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">{t("文档预览暂不可用，请另存为查看。")}</p> : this.props.children; }
}
export function DocumentReader({ blob }: { blob: Blob }) {
  useLocale();
  return <DocumentBoundary><Suspense fallback={<p role="status">{t("正在打开文档…")}</p>}><Word blob={blob}/></Suspense></DocumentBoundary>;
}
export function MarkdownReader({ text, truncated }: { text: string; truncated: boolean }) {
  useLocale();
  return <>{truncated && <p className="document-preview-note">{t("预览显示前 256 KB，另存为可查看完整文件。")}</p>}<div className="document-scroll" tabIndex={0} role="region" aria-label={t("文档内容")}><article className="document-page"><MarkdownText text={text}/></article></div></>;
}

export function SpreadsheetReader({ blob }: { blob: Blob }) {
  useLocale();
  return <DocumentBoundary><Suspense fallback={<p role="status">{t("正在打开表格…")}</p>}><Spreadsheet blob={blob}/></Suspense></DocumentBoundary>;
}
