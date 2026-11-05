import { Capacitor, registerPlugin } from "@capacitor/core";
import { invoke, isDesktop, isElectron } from "./desktop-bridge.js";
import { t } from "./i18n.js";
import { browserDownload } from "./browser-download.js";
import { attachmentMime } from "../../src/client-protocol/attachment-mime.js";
import { encodeDesktopBytes } from "./desktop-base64.js";

const CHUNK = 1024 * 1024;
/** A server-supplied label is never a filesystem path. */
export function attachmentFilename(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "");
  const suffix = /\.[a-z0-9]{1,16}$/i.exec(sanitized);
  const extension = suffix && suffix.index > 0 ? suffix[0] : "";
  const stem = (extension ? sanitized.slice(0, -extension.length) : sanitized).replace(/[. ]+$/g, "");
  const prefix = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem + extension) ? "_" : "";
  let clean = "", bytes = prefix.length + extension.length;
  // Reserve the complete extension and any Windows device-name prefix before
  // truncating, while keeping Unicode code points and the final byte budget.
  for (const character of stem) {
    const size = new TextEncoder().encode(character).length;
    if (prefix.length + clean.length + character.length + extension.length > 160 || bytes + size > 240) break;
    clean += character; bytes += size;
  }
  clean = clean.replace(/[. ]+$/g, "");
  return `${prefix}${clean || "attachment"}${extension}`;
}
/** Download/save, share and open are distinct operations on every platform. */
export type ExportStage = "choosing" | "saving" | "preparing" | "sharing" | "handoff" | "opening";
/** What the platform accepted. Only "saved" means the chosen file was fully
 * written and closed; "shared" is the share sheet's completion and "browser" a
 * download handed to the browser. "opened" only confirms launching the Android
 * chooser, not which app the user chose. No handoff confirms a file on disk. */
export type ExportDelivery = "saved" | "shared" | "browser" | "opened";
export type ExportReport = { browserLock?: string; savedKey?: string; stage?: (stage: ExportStage) => void; delivered?: (delivery: ExportDelivery, savedPath?: string, savedLocation?: string) => void };
export function canRevealSavedAttachment(): boolean { return isDesktop(); }
export function isAndroidApk(name: string): boolean { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && /\.apk$/i.test(name); }
/** Confirmed saves supply a desktop path or Android content URI. Native code
 * rechecks its save grant; references never enter a shell or the Hub. */
export async function openSavedAttachment(path: string): Promise<void> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    try {
      const plugin = registerPlugin<{ openSaved(options: { uri: string }): Promise<void> }>("TaroBotAttachmentSaver");
      await plugin.openSaved({ uri: path }); return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "attachment_install_permission_required") throw new Error(t("请在系统设置中允许 TaroBird 安装未知应用，然后再次点击安装 APK。"), { cause: error });
      throw new Error(t("无法打开已保存的文件，请确认文件未被移动或删除，并已安装对应应用；也可以重新另存为。"), { cause: error });
    }
  }
  try {
    if (!isDesktop()) throw new Error("desktop_required");
    if (!isElectron() && /\.(?:exe|com|bat|cmd|msi|msp|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|cpl|jar|command|terminal|sh)$/i.test(path.trim())) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      if (!await ask(t("这个附件可能运行程序或修改系统。请仅在确认来源可信时打开。"), { title: t("打开可执行附件"), kind: "warning" })) return;
    }
    await invoke("open_saved_file", { path, ...(isElectron() ? { english: document.documentElement.lang.startsWith("en") } : {}) });
  } catch (error) {
    throw new Error(t("无法打开已保存的文件，请确认文件未被移动或删除，并已安装对应应用；也可以重新另存为。"), { cause: error });
  }
}
export async function revealSavedAttachment(path: string): Promise<void> {
  try {
    if (!isDesktop()) throw new Error("desktop_required");
    await invoke("reveal_saved_file", { path });
  } catch (error) {
    throw new Error(t("无法打开文件位置，请确认文件未被移动或删除；也可以重新另存为。"), { cause: error });
  }
}
/** Resolves true once the platform accepted the file, false when the user
 * dismissed the save dialog or share sheet. The first stage is reported
 * synchronously, before any await. */
export async function exportAttachment(blob: Blob, rawName: string, report: ExportReport = {}, action: "save" | "share" | "external" = "save"): Promise<boolean> {
  const name = attachmentFilename(rawName);
  if (isElectron()) {
    report.stage?.("choosing");
    const save = await invoke<{ token: string } | null>("desktop_save_begin", { name, size: blob.size });
    if (!save) return false;
    try {
      report.stage?.("saving");
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        const receipt = await invoke<{ written: number }>("desktop_save_write", { token: save.token, data: encodeDesktopBytes(bytes) });
        if (receipt.written !== bytes.length) throw new Error(t("文件未完整写入，请重新保存。"));
      }
      const receipt = await invoke<{ path: string; size: number }>("desktop_save_commit", { token: save.token });
      if (receipt.size !== blob.size || !receipt.path) throw new Error(t("文件未完整写入，请重新保存。"));
      report.delivered?.("saved", receipt.path); return true;
    } catch (error) {
      await invoke("desktop_save_cancel", { token: save.token }).catch(() => undefined);
      throw new Error(t("保存失败，请检查剩余空间和文件权限后重试。"), { cause: error });
    }
  }
  if (isDesktop()) {
    report.stage?.("choosing");
    let savedPath: string;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const selected = await save({ defaultPath: name }); if (!selected) return false;
      report.stage?.("preparing");
      // The native save dialog grants write access only to the chosen file.
      // Keep an existing destination intact until its quarantine mark succeeds.
      const file = await (await import("@tauri-apps/plugin-fs")).open(selected, { read: false, write: true, create: true });
      try {
        // Mark the chosen Mac file with system quarantine before any untrusted
        // payload reaches it. A marking failure must never become a saved receipt.
        try { await invoke("quarantine_saved_file", { path: selected }); }
        catch (error) { throw new Error(t("无法在此位置安全保存附件，请选择其他文件夹后重试。"), { cause: error }); }
        report.stage?.("saving");
        await file.truncate(0);
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
          // The native plugin uses std::io::Write::write, not write_all. Advance
          // only by its confirmed byte count and retain the unwritten suffix.
          for (let written = 0; written < bytes.length;) {
            const count = await file.write(bytes.subarray(written));
            if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - written) throw new Error(t("文件未完整写入，请重新保存。"));
            written += count;
          }
        }
      } finally { await file.close(); }
      savedPath = selected;
    } catch (error) {
      // Native plugins reject with strings. Give the file card a useful save
      // error instead of treating these failures as an unavailable attachment.
      if (error instanceof Error) throw error;
      throw new Error(t("保存失败，请检查剩余空间和文件权限后重试。"), { cause: error });
    }
    // A failed write can leave a partial target; only a closed complete write is "saved".
    report.delivered?.("saved", savedPath); return true;
  }
  if (Capacitor.isNativePlatform()) {
    report.stage?.("preparing");
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const base = "tarocub-exports";
    // On the next export, sweep copies older than 24h. This is not a timer or
    // a deletion deadline; receivers may read after the share sheet closes.
    const previous = await Filesystem.readdir({ path: base, directory: Directory.Cache }).catch(() => ({ files: [] }));
    for (const file of previous.files) if (/^\d+-[0-9a-f-]+$/.test(file.name) && Number(file.name.split("-")[0]) < Date.now() - 86_400_000) await Filesystem.rmdir({ path: `${base}/${file.name}`, directory: Directory.Cache, recursive: true }).catch(() => undefined);
    const folder = `${base}/${Date.now()}-${crypto.randomUUID()}`; const path = `${folder}/${name}`;
    await Filesystem.mkdir({ path: folder, directory: Directory.Cache, recursive: true });
    try {
      await Filesystem.writeFile({ path, directory: Directory.Cache, data: "" });
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer()); let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await Filesystem.appendFile({ path, directory: Directory.Cache, data: btoa(binary) });
      }
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      if (action === "save") {
        report.stage?.(Capacitor.getPlatform() === "ios" ? "choosing" : "saving");
        const plugin = registerPlugin<{ save(options: { uri: string; mime: string; key?: string }): Promise<{ saved: boolean; location?: string; uri?: string }> }>("TaroBotAttachmentSaver");
        const result = await plugin.save({ uri, mime: blob.type, ...(report.savedKey ? { key: report.savedKey } : {}) });
        if (result.saved === false) return false;
        if (result.saved !== true) throw new Error("attachment_save_unconfirmed");
        // A native receipt means a closed public download or a completed
        // document export, not just a copy in the App's temporary cache.
        report.delivered?.("saved", Capacitor.getPlatform() === "android" ? result.uri : undefined, result.location); return true;
      } else if (action === "external" && Capacitor.getPlatform() === "android") {
        report.stage?.("opening");
        const plugin = registerPlugin<{ open(options: { uri: string; mime: string; title: string }): Promise<void> }>("TaroBotAttachmentOpener");
        await plugin.open({ uri, mime: blob.type, title: t("用其他应用打开") });
      } else {
        report.stage?.("sharing");
        const { Share } = await import("@capacitor/share");
        await Share.share({ title: name, files: [uri] });
      }
    } catch (error) {
      // @capacitor/share 8 rejects with exactly "Share canceled" on iOS (no completed
      // activity) and Android (chooser cancelled while this activity was not
      // stopped). A target that opens without covering the app can therefore be
      // reported as cancelled, so retain the copy for the next export's sweep.
      if (action !== "save" && error instanceof Error && error.message === "Share canceled") return false;
      await Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(() => undefined);
      throw action === "external" ? new Error(t("无法打开文件，请安装对应的阅读应用，或使用另存为。"), { cause: error }) : action === "save" ? new Error(t("保存失败，请检查剩余空间和文件权限后重试。"), { cause: error }) : error;
    } finally {
      // Saved copies live outside this cache. A share/open receiver may still
      // be reading its copy, so only saves can clean up immediately.
      if (action === "save") await Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(() => undefined);
    }
    report.delivered?.(action === "external" && Capacitor.getPlatform() === "android" ? "opened" : "shared"); return true;
  }
  report.stage?.("handoff");
  const streamed = await browserDownload(blob, name, report.browserLock);
  if (streamed !== undefined) { if (streamed) report.delivered?.("browser"); return streamed; }
  // If a capable worker disappeared during this download, retry explicitly.
  // Retaining successive large OPFS copies would exhaust private-browser quota.
  if (report.browserLock) throw new Error(t("浏览器下载中断，请重试。"));
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  report.delivered?.("browser"); return true;
}

export function canOpenAttachmentExternally(): boolean { return Capacitor.isNativePlatform(); }
/** Android ACTION_VIEW chooser; iOS supplies document apps through its share sheet. */
export function openAttachmentExternally(blob: Blob, name: string, report: ExportReport = {}): Promise<boolean> {
  if (!canOpenAttachmentExternally()) throw new Error("native_required");
  return exportAttachment(blob, name, report, "external");
}

export function shareAttachment(blob: Blob, name: string, report: ExportReport = {}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) throw new Error("native_required");
  return exportAttachment(blob, name, report, "share");
}
export function attachmentSaveLabel(): string { return Capacitor.isNativePlatform() ? t("保存到手机") : t("另存为"); }

export type AttachmentPreview = { kind: "text" | "markdown"; text: string; truncated: boolean } | { kind: "pdf" | "docx" | "spreadsheet" | "image" | "audio" | "video"; blob: Blob } | { kind: "unsupported" };
export async function previewAttachment(blob: Blob, name: string): Promise<AttachmentPreview> {
  // Older Bot deliveries and some file pickers omit the media type. Recover
  // only allowlisted media into inert media elements; explicit HTML/text types
  // keep their escaped-text route, and SVG is never inferred as an image.
  const type = blob.type.split(";", 1)[0]!.trim().toLowerCase();
  if (!type || type === "application/octet-stream") {
    const inferred = attachmentMime(name);
    if (/^(image|audio|video)\//.test(inferred)) blob = blob.slice(0, blob.size, inferred);
  }
  if (/^image\/(png|jpeg|gif|webp|avif)(;|$)/i.test(blob.type)) return { kind: "image", blob };
  if (/^audio\//i.test(blob.type)) return { kind: "audio", blob };
  if (/^video\//i.test(blob.type)) return { kind: "video", blob };
  if (/\.pdf$/i.test(name) && await blob.slice(0, 5).text() === "%PDF-") return { kind: "pdf", blob: new Blob([blob], { type: "application/pdf" }) };
  if (/\.(xlsx|xls|xlsm)$/i.test(name)) return { kind: "spreadsheet", blob };
  if (/\.docx$/i.test(name)) return { kind: "docx", blob };
  if (/\.(md|markdown)$/i.test(name) || /^text\/(markdown|x-markdown)(;|$)/i.test(blob.type)) return { kind: "markdown", text: await blob.slice(0, 256 * 1024).text(), truncated: blob.size > 256 * 1024 };
  // Render even HTML/SVG/code as escaped text, never as same-origin executable HTML.
  if (blob.type.startsWith("text/") || /\.(txt|md|csv|json|log|ya?ml|xml|html?|svg|[cm]?[jt]sx?|py|sh|css|toml|rs|go)$/i.test(name)) return { kind: "text", text: await blob.slice(0, CHUNK).text(), truncated: blob.size > CHUNK };
  return { kind: "unsupported" };
}
