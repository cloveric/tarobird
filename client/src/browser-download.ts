import { t } from "./i18n.js";

/** Old/disabled workers keep the established in-memory browser path. Native
 * shells select their own export and do not need this capability. */
export async function supportsBrowserDownload(): Promise<boolean> {
  const worker = globalThis.navigator?.serviceWorker?.controller; if (!worker) return false;
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const finish = (supported: boolean) => { clearTimeout(timer); channel.port1.close(); resolve(supported); };
    const timer = setTimeout(() => finish(false), 1000);
    channel.port1.onmessage = event => finish(event.data?.type === "attachment.download.supported");
    try { worker.postMessage({ type: "attachment.download.capabilities" }, [channel.port2]); } catch { finish(false); }
  });
}

/** Stream an already-verified Blob through our own worker. Completion means the
 * worker copied every byte into the browser response, not that the user's disk
 * write is confirmed. Undefined means an older/absent worker needs the fallback. */
export async function browserDownload(blob: Blob, name: string, fileLock?: string): Promise<boolean | undefined> {
  const worker = globalThis.navigator?.serviceWorker?.controller; if (!worker) return;
  const channel = new MessageChannel(), id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let started = false, finished = false;
    const finish = (result?: boolean, error?: unknown) => {
      if (finished) return; finished = true; clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", changed); channel.port1.close();
      if (error) reject(error); else resolve(result);
    };
    const expired = () => {
      channel.port1.postMessage({ type: "cancel" });
      finish(undefined, started ? new Error(t("浏览器下载中断，请重试。")) : undefined);
    };
    const changed = () => { channel.port1.postMessage({ type: "cancel" }); finish(undefined, new Error(t("浏览器下载中断，请重试。"))); };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    let timer = setTimeout(expired, 5000);
    channel.port1.onmessage = (event: MessageEvent<{ type: string }>) => {
      const type = event.data?.type;
      if (type === "unsupported") { finish(); return; }
      if (type === "ready" && !started) {
        started = true; clearTimeout(timer); timer = setTimeout(expired, 120_000);
        // A download attribute can bypass Service Worker interception. Let the
        // worker's Content-Disposition turn this navigation into a download.
        const anchor = document.createElement("a");
        anchor.href = `/__tarocub_download/${id}`; anchor.click();
      } else if (type === "progress") { clearTimeout(timer); timer = setTimeout(expired, 120_000); }
      else if (type === "done") finish(true);
      else if (type === "cancelled") finish(false);
      else if (type === "error") finish(undefined, new Error(t("浏览器下载中断，请重试。")));
    };
    try { worker.postMessage({ type: "attachment.download.prepare", id, blob, name, fileLock }, [channel.port2]); }
    catch { finish(); }
  });
}
