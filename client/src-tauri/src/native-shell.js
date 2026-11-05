// Runs from the Windows binary at document creation, even when an older service
// worker supplied the HTML. Never remove IndexedDB, credentials or WebView data.
(() => {
  if (!/^https?:$/.test(location.protocol) || location.hostname !== "tauri.localhost" || window !== window.top) return;
  const version = "__TAROBOT_VERSION__";
  const worker = navigator.serviceWorker;
  if (!worker) return;
  const owns = (url) => {
    try { const parsed = new URL(url); return parsed.origin === location.origin && parsed.pathname === "/sw.js"; }
    catch { return false; }
  };
  const registrations = async () => (await worker.getRegistrations()).filter((registration) =>
    registration.scope === location.origin + "/" &&
    [registration.active, registration.waiting, registration.installing].some((item) => item && owns(item.scriptURL)));
  const marker = "tarobot-native-shell-recovery";
  const clearPageCache = () => {
    // Unregistration is what releases the old shell. Disposable cache cleanup
    // must never prevent the new application from starting.
    void caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("tarocub-shell-"))
      .map((key) => caches.delete(key).catch(() => false)))).catch(() => undefined);
  };
  // An uncontrolled fresh document can start immediately. Remove a waiting
  // legacy registration too, without delaying or restarting the current UI.
  if (!worker.controller || !owns(worker.controller.scriptURL)) {
    try { sessionStorage.removeItem(marker); } catch { /* no identity storage */ }
    void registrations().then((items) => Promise.all(items.map((item) => item.unregister()))).catch(() => undefined);
    clearPageCache();
    return;
  }
  // Replace the document BEFORE the cached application can open connections or
  // register its old worker again. Cleanup in main.tsx would be too late.
  // Do not call window.stop(): it can leave Chromium's frame scheduler stopped
  // and make a failure/retry screen unresponsive. Only constant markup enters.
  document.open();
  document.write("<!doctype html><html><head><meta charset='utf-8'><title>TaroBot</title></head><body></body></html>");
  document.close();
  const html = document.documentElement || document.appendChild(document.createElement("html"));
  const body = document.createElement("body");
  html.replaceChildren(body);
  body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#202126;font:15px/1.6 system-ui,sans-serif";
  const card = document.createElement("main");
  card.style.cssText = "box-sizing:border-box;width:min(480px,calc(100vw - 40px));padding:28px;border:1px solid #dedee4;border-radius:18px;background:white";
  const title = document.createElement("h1"); title.textContent = "正在更新 TaroBot 页面"; title.style.cssText = "font-size:20px;margin:0 0 12px";
  const detail = document.createElement("p"); detail.textContent = "正在移除旧版页面缓存。配对信息和聊天草稿会保留。";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "TaroBot " + version;
  const retry = document.createElement("button"); retry.textContent = "重新尝试"; retry.hidden = true;
  retry.style.cssText = "padding:8px 16px;font:inherit;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer";
  card.append(title, detail, status, retry); body.append(card);
  let busy = false;
  let attempt = 0;
  const fail = (code) => {
    busy = false; title.textContent = "TaroBot 页面更新未完成";
    detail.textContent = "配对信息和聊天草稿仍然保留。请重新尝试；若仍失败，请将此页截图发给我们。";
    status.textContent = "TaroBot " + version + " · " + code; retry.hidden = false; retry.disabled = false;
  };
  const recover = async () => {
    if (busy) return;
    const current = ++attempt;
    busy = true; retry.disabled = true;
    let timeout;
    try {
      // A worker which remains controlling after reload must not cause a loop.
      // Failure to record this guard stops automatic recovery safely.
      sessionStorage.setItem(marker, version);
      timeout = setTimeout(() => { if (attempt === current) fail("native_shell_timeout"); }, 10_000);
      for (const registration of await registrations()) await registration.unregister();
      if ((await registrations()).length) throw new Error("native_shell_unregister_failed");
      if (attempt !== current) return;
      clearTimeout(timeout);
      location.reload();
      // A committed navigation discards this timer with the old document.
      setTimeout(() => { if (attempt === current) fail("native_shell_reload_stalled"); }, 15_000);
    } catch { if (attempt === current) fail("native_shell_recovery_failed"); }
    finally { clearTimeout(timeout); }
  };
  retry.onclick = () => { void recover(); };
  try {
    if (sessionStorage.getItem(marker) === version) fail("native_shell_still_cached");
    else void recover();
  } catch { fail("native_shell_storage_unavailable"); }
})();
