import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invoke, isElectron } from "./desktop-bridge.js";
import { importDesktopData, indexedDbImportTarget } from "./desktop-migration-import.js";
import type { MigrationManifest } from "./desktop-migration-format.js";
import { BrandMark } from "./BrandScenes.js";
import { t, useLocale } from "./i18n.js";
import "./desktop-migration.css";

type Inspection = { state: "fresh" | "profile" | "ready" | "committed" | "transition_required" | "invalid"; mode?: string; exportId?: string; manifest?: MigrationManifest; replacesExportId?: string; sourceChanged?: boolean };
let legacyNoticeExportId: string | undefined;
const sizeErrors = new Set(['migration_too_large', 'migration_blob_too_large', 'migration_value_too_large', 'migration_too_many_skipped', 'migration_too_many_blobs']);
async function readBytes(exportId: string, kind: "part" | "blob", identifier: number | string): Promise<Uint8Array> {
  let offset = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await invoke<{ data: Uint8Array; next: number; done: boolean }>("desktop_migration_read", { exportId, kind, ...(kind === "part" ? { index: identifier } : { sha256: identifier }), offset });
    if (!(chunk.data instanceof Uint8Array) || chunk.data.length > 1024 * 1024 || chunk.next !== offset + chunk.data.length || !chunk.done && chunk.next <= offset || chunk.next > 128 * 1024 * 1024) throw new Error("migration_read_invalid");
    chunks.push(chunk.data); offset = chunk.next;
    if (chunk.done) break;
  }
  const bytes = new Uint8Array(offset); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

async function electronStartup(): Promise<void> {
  const target = await indexedDbImportTarget();
  // An import whose registry commit landed before main's receipt and marker is
  // finished from that same export, never replaced by a newer snapshot.
  const committed = await target.state();
  let status = await invoke<Inspection>("desktop_migration_inspect", committed.importedExportId ? { committedExportId: committed.importedExportId } : {});
  if (status.state === "committed") {
    if (status.manifest?.exportId !== committed.importedExportId) throw new Error("migration_state_invalid");
    if (committed.pendingLocalStorage) {
      try { await target.setLocalStorage(committed.pendingLocalStorage); await target.finishLocalStorage(); }
      catch { throw new Error("migration_local_storage_failed"); }
    }
    await invoke("desktop_migration_complete", { exportId: committed.importedExportId });
    legacyNoticeExportId = status.sourceChanged ? committed.importedExportId : undefined;
    return;
  }
  if (status.state === "transition_required" || status.state === "invalid") status = await invoke<Inspection>("desktop_migration_prepare");
  if (status.state === "invalid") throw new Error("migration_export_invalid");
  if (status.state === "profile") {
    const current = await target.state();
    if (status.mode === "imported" && current.importedExportId !== status.exportId) throw new Error("migration_profile_data_missing");
    if (current.pendingLocalStorage) { await target.setLocalStorage(current.pendingLocalStorage); await target.finishLocalStorage(); }
    await invoke("desktop_migration_complete", { ...(status.exportId ? { exportId: status.exportId } : {}) });
    legacyNoticeExportId = status.sourceChanged ? status.exportId : undefined;
    return;
  }
  if (status.state === "ready" && status.manifest) {
    const manifest = status.manifest;
    const result = await importDesktopData({ manifest, replacesExportId: status.replacesExportId,
      part: async index => new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(manifest.exportId, "part", index)),
      blob: sha => readBytes(manifest.exportId, "blob", sha),
    }, target);
    if (result.state === "target_not_empty") throw new Error("migration_target_not_empty");
    if (result.localStorage !== "saved") throw new Error("migration_local_storage_failed");
    await invoke("desktop_migration_complete", { exportId: manifest.exportId });
    return;
  }
  if (status.state !== "fresh") throw new Error("migration_state_invalid");
  await invoke("desktop_migration_complete");
}

// Single startup transaction, including React development re-mounts. Failure can
// be retried; there is never a second concurrent importer or mounted HostApp.
let startup: Promise<"open" | "exported"> | undefined;
async function checkStartup(): Promise<"open" | "exported"> {
  if (isElectron()) { await electronStartup(); return "open"; }
  if (!isTauri()) return "open";
  const mode = await invoke<{ transition: boolean; appVersion: string }>("desktop_migration_mode");
  const status = await invoke<{ exports: string[]; imported: string[] }>("desktop_migration_status");
  // Rollback to a transitional build must not replay the old outbox, even if
  // Electron has not yet acknowledged import. The source remains intact.
  if (status.exports.length || status.imported.length) return "exported";
  if (!mode.transition) return "open";
  const { exportDesktopData, indexedDbExportSource, tauriExportSink } = await import("./desktop-migration-export.js");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  await exportDesktopData(indexedDbExportSource(), tauriExportSink((command, args, options) => tauriInvoke(command, args, options?.headers ? { headers: options.headers } : undefined)), { appVersion: mode.appVersion });
  return "exported";
}

export function DesktopMigrationGate({ children }: { children: ReactNode }) {
  useLocale();
  const [state, setState] = useState<"checking" | "open" | "exported" | "failed">(() => isElectron() || isTauri() ? "checking" : "open");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string>();
  const run = () => {
    setState("checking");
    const work = startup ??= checkStartup();
    void work.then(value => { setState(value); setNotice(legacyNoticeExportId); }, reason => { if (startup === work) startup = undefined; setError(reason instanceof Error ? reason.message : "migration_failed"); setState("failed"); });
  };
  useEffect(() => { if (isElectron() || isTauri()) run(); }, []);
  if (state === "open") return <>{children}{notice && <aside role="status" className="desktop-migration-notice">
    <span>{t("旧版另有数据变更。当前继续使用新版数据，两份记录均已保留，未自动合并。")}</span>
    <button type="button" onClick={() => {
      setNotice(undefined); legacyNoticeExportId = undefined;
      void invoke("desktop_migration_complete", { exportId: notice, acknowledgeSourceChange: true }).catch(() => {});
    }}>{t("知道了")}</button>
  </aside>}</>;
  return <div className="loading-screen desktop-migration-gate"><BrandMark/>
    {state === "checking" ? <p role="status">{t("正在准备桌面数据…")}</p> : state === "exported"
      ? <><p>{t("桌面数据已保存，请继续安装新版。旧记录和草稿已保留。")}</p><p>{t("为避免重复发送，旧版暂不连接主机。")}</p></>
      : <><p role="alert">{error === "migration_close_old_app" ? t("请退出旧版 TaroBird 窗口，再重试。主机可以继续运行。")
        : sizeErrors.has(error) ? t("旧版数据超出自动迁移上限，原记录未删除。请先在旧版中清理大附件或缓存，再重试。")
        : error === "migration_source_busy" ? t("旧版数据仍在写入。请退出旧版窗口，稍后重试。原记录已保留。")
        : t("桌面数据迁移尚未完成，原有数据已保留。")}</p><code>{error}</code><button type="button" onClick={run}>{t("重试")}</button></>}
  </div>;
}
