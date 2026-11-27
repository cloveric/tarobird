import { useState } from "react";
import type { WorkbenchController } from "./workbench-controller.js";
import type { DesignSession } from "./workbench-design-session.js";
import { designSystemInstall, type DesignSystemSource } from "./workbench-design-system.js";
import { listWorkbenchLibrary } from "./workbench-library.js";
import { designFrame } from "./design-frame.js";
import { t, useLocale } from "./i18n.js";

export function WorkbenchDesignSystems({ controller, session }: { controller: WorkbenchController; session: DesignSession }) {
  useLocale();
  const [sources, setSources] = useState<DesignSystemSource[]>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const list = async () => {
    setBusy(true); setError("");
    try {
      const connection = controller.connection, userId = connection.state.user?.id;
      const listing = await listWorkbenchLibrary(connection), available: DesignSystemSource[] = [];
      for (const entry of listing.entries) if (entry.kind === "design" && entry.state !== "missing" && (!entry.designFormat || entry.designFormat === "design-system")) {
        const document = await connection.cache.readWorkbenchDesign(entry.scope, entry.id).catch(() => undefined);
        if (document?.format === "design-system") available.push({ scope: entry.scope, id: entry.id, title: entry.title ?? t("设计系统") });
      }
      if (connection.isClosed || connection.state.user?.id !== userId) throw new Error("workbench_scope_unavailable");
      setSources(available);
    } catch { setError(t("无法读取设计系统，请重试。")); } finally { setBusy(false); }
  };
  const install = async (source: DesignSystemSource) => {
    setBusy(true); setError("");
    try {
      if (source.scope === controller.scope) await controller.designSession(source.id)?.flush();
      await session.flush(); const target = await session.refresh();
      const doc = await controller.connection.cache.readWorkbenchDesign(source.scope, source.id); if (!doc) throw new Error("design_not_found");
      const files = designSystemInstall(target, doc, source);
      const result = await session.request("publish", { files }) as { status: number }; if (result.status !== 200) throw new Error("design_revision_conflict");
      await designFrame(session).reload(); setSources(undefined);
    } catch (e) {
      setError(e instanceof Error && e.message === "design_system_local_changes"
        ? t("此副本有本地修改，未覆盖。请先保留或撤销这些修改，再同步。")
        : t("未能安装或同步。请检查版本冲突、容量或系统数量后重试（最多四套）。"));
    } finally { setBusy(false); }
  };
  return <span className="design-systems"><button disabled={busy} onClick={() => sources ? setSources(undefined) : void list()}>{t("设计系统")}</button>{sources && <div role="dialog" aria-label={t("安装或同步设计系统")} data-workbench-overlay>
    <p>{t("复制到当前项目；已有副本会同步，保留源项目。")}</p>
    {!sources.length && <p>{t("没有可安装的设计系统。项目中已有的主题仍可继续使用。")}</p>}{sources.map(source => <button key={source.scope + source.id} disabled={busy} onClick={() => void install(source)}>{source.title}</button>)}<button disabled={busy} onClick={() => setSources(undefined)}>{t("关闭")}</button></div>}{error && <span role="alert">{error}</span>}</span>;
}
