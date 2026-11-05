import { Component, type ReactNode } from "react";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";

// A failed optional page must not unmount the conversation workspace. In
// particular, a tab left open across a Hub upgrade may request an old chunk.
export class PageLoadBoundary extends Component<{ children: ReactNode; close: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <CreationDialog title={t("页面暂时无法打开")} close={this.props.close} closeLabel={t("关闭")} showHost={false} className="network-page-error">
      <p role="alert">{t("界面可能已更新，或连接暂时中断。请先关闭此页，保存正在编辑的内容后再重新加载应用。")}</p>
      <footer><button type="button" onClick={this.props.close}>{t("关闭此页")}</button><button type="button" className="primary" onClick={() => window.location.reload()}>{t("重新加载应用")}</button></footer>
    </CreationDialog>;
  }
}
