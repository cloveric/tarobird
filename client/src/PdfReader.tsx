import { Component, lazy, Suspense, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { t, useLocale } from "./i18n.js";

// The parser and worker are loaded only when a PDF is opened. The offline shell
// and native bundles still carry the same local resources.
const Reader = lazy(() => import("./PdfPreview.js"));
class ReaderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert">{t("PDF 预览暂不可用，请另存为查看。")}</p>
      : this.props.children;
  }
}
export function PdfReader({ blob, name }: { blob: Blob; name: string }) {
  useLocale();
  return <ReaderBoundary><Suspense fallback={<p role="status"><LoaderCircle size={16} className="spin"/>{t("正在打开 PDF…")}</p>}><Reader blob={blob} name={name}/></Suspense></ReaderBoundary>;
}
