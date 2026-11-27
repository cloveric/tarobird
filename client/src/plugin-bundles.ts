// Sandboxed HTML entry bundles for lightweight built-in catalog plugins.
// Heavy optional extensions (such as Infinite Canvas) are NOT inlined here;
// they are downloaded on demand from their signed artifact URLs.
// Each bundle runs inside <iframe sandbox="allow-scripts"> with an opaque origin
// and communicates exclusively via the tarobird.plugin.v1 postMessage host API.

export const QUICK_SCRATCHPAD_BUNDLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Quick Scratchpad</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #ffffff; color: #0f172a; display: flex; flex-direction: column; }
  body[data-theme="dark"] { background: #14171d; color: #e2e8f0; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid rgba(148,163,184,0.25); }
  textarea { flex: 1; width: 100%; border: 0; padding: 14px; resize: none; background: transparent; color: inherit; font: inherit; font-size: 13.5px; line-height: 1.6; outline: none; }
  button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.35); background: transparent; color: inherit; cursor: pointer; }
</style>
</head>
<body>
<header>
  <strong id="heading">Quick Scratchpad</strong>
  <button id="copy-btn" type="button">Copy</button>
</header>
<textarea id="pad" placeholder="Jot down quick notes (saved locally inside plugin sandbox)..."></textarea>
<script>
(() => {
  const PROTOCOL = "tarobird.plugin.v1";
  let seq = 0;
  const pending = new Map();
  function callHost(method, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = "sp_" + (++seq);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ protocol: PROTOCOL, id, method, ...extra }, "*");
    });
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.protocol !== PROTOCOL || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.ok) resolve(data.result);
    else reject(new Error(data.error || "host_error"));
  });
  const pad = document.getElementById("pad");
  pad.addEventListener("input", () => { void callHost("storage.set", { key: "text", value: pad.value }).catch(() => {}); });
  document.getElementById("copy-btn").addEventListener("click", () => { void callHost("clipboard.write", { text: pad.value }).catch(() => {}); });
  callHost("host.hello").then((info) => {
    if (info && info.theme === "dark") document.body.dataset.theme = "dark";
    if (info && info.locale === "zh") {
      document.getElementById("heading").textContent = "速记面板";
      document.getElementById("copy-btn").textContent = "复制";
      pad.placeholder = "随手记录想法（仅保存在插件沙箱本地存储）…";
    }
    return callHost("storage.get", { key: "text" });
  }).then((text) => { if (typeof text === "string") pad.value = text; }).catch(() => {});
})();
</script>
</body>
</html>`;
