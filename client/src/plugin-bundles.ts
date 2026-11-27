// Sandboxed HTML entry bundles for built-in catalog plugins.
// Each bundle runs inside <iframe sandbox="allow-scripts"> with an opaque origin
// and communicates exclusively via the tarobird.plugin.v1 postMessage host API.

export const INFINITE_CANVAS_BUNDLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Infinite Canvas</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #f8fafc; color: #0f172a; }
  body[data-theme="dark"] { background: #111419; color: #e2e8f0; }
  .toolbar { position: fixed; top: 12px; left: 12px; right: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.92); border: 1px solid rgba(15,23,42,0.12); z-index: 10; backdrop-filter: blur(8px); }
  body[data-theme="dark"] .toolbar { background: rgba(24,28,36,0.92); border-color: rgba(226,232,240,0.14); }
  .toolbar-group { display: flex; align-items: center; gap: 6px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: rgba(37,99,235,0.12); color: #2563eb; font-weight: 600; }
  body[data-theme="dark"] .badge { background: rgba(96,165,250,0.16); color: #93c5fd; }
  button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; border: 1px solid rgba(15,23,42,0.16); background: transparent; color: inherit; cursor: pointer; }
  body[data-theme="dark"] button { border-color: rgba(226,232,240,0.2); }
  button:hover { background: rgba(148,163,184,0.16); }
  .viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; background-image: radial-gradient(rgba(100,116,139,0.25) 1px, transparent 1px); background-size: 24px 24px; }
  .viewport:active { cursor: grabbing; }
  .stage { position: absolute; inset: 0; transform-origin: 0 0; }
  .card { position: absolute; width: 220px; padding: 12px; border-radius: 12px; background: #ffffff; border: 1px solid rgba(15,23,42,0.12); box-shadow: 0 6px 20px rgba(15,23,42,0.08); cursor: move; }
  body[data-theme="dark"] .card { background: #1c212b; border-color: rgba(226,232,240,0.14); box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
  .card h4 { margin: 0 0 6px; font-size: 13px; }
  .card textarea { width: 100%; min-height: 68px; border: 0; resize: vertical; background: transparent; color: inherit; font: inherit; font-size: 12px; outline: none; }
</style>
</head>
<body>
<div class="toolbar">
  <div class="toolbar-group">
    <strong id="title">Infinite Canvas</strong>
    <span class="badge" id="status">Sandbox</span>
  </div>
  <div class="toolbar-group">
    <button id="add-card" type="button">+ Note</button>
    <button id="zoom-out" type="button">-</button>
    <span id="zoom-label" style="font-size:12px;min-width:42px;text-align:center">100%</span>
    <button id="zoom-in" type="button">+</button>
    <button id="reset-view" type="button">Reset</button>
  </div>
</div>
<div class="viewport" id="viewport"><div class="stage" id="stage"></div></div>
<script>
(() => {
  const PROTOCOL = "tarobird.plugin.v1";
  let reqSeq = 0;
  const pending = new Map();
  function callHost(method, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = "req_" + (++reqSeq);
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
  let state = { x: 40, y: 76, zoom: 1, cards: [
    { id: "c1", x: 30, y: 30, title: "Architecture", text: "Pan anywhere on the canvas or add cards." },
    { id: "c2", x: 290, y: 90, title: "Sandbox", text: "Isolated origin with scoped local storage only." },
  ] };
  const stage = document.getElementById("stage");
  const viewport = document.getElementById("viewport");
  const zoomLabel = document.getElementById("zoom-label");
  function save() {
    void callHost("storage.set", { key: "canvas-v1", value: JSON.stringify(state) }).catch(() => {});
  }
  function render() {
    stage.style.transform = "translate(" + state.x + "px," + state.y + "px) scale(" + state.zoom + ")";
    zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
    stage.innerHTML = "";
    for (const card of state.cards) {
      const el = document.createElement("div");
      el.className = "card";
      el.style.left = card.x + "px";
      el.style.top = card.y + "px";
      const h = document.createElement("h4");
      h.textContent = card.title;
      const ta = document.createElement("textarea");
      ta.value = card.text;
      ta.addEventListener("input", () => { card.text = ta.value; save(); });
      el.append(h, ta);
      el.addEventListener("pointerdown", (e) => {
        if (e.target === ta || e.button !== 0) return;
        e.stopPropagation();
        const pointerId = e.pointerId;
        try { el.setPointerCapture(pointerId); } catch {}
        const startX = e.clientX, startY = e.clientY, origX = card.x, origY = card.y;
        let active = true;
        const move = (ev) => {
          if (!active || ev.pointerId !== pointerId) return;
          card.x = origX + (ev.clientX - startX) / state.zoom;
          card.y = origY + (ev.clientY - startY) / state.zoom;
          el.style.left = card.x + "px";
          el.style.top = card.y + "px";
        };
        const finish = (ev) => {
          if (!active || (ev && ev.pointerId !== undefined && ev.pointerId !== pointerId)) return;
          active = false;
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", finish);
          el.removeEventListener("pointercancel", finish);
          el.removeEventListener("lostpointercapture", finish);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch {}
          save();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", finish);
        el.addEventListener("pointercancel", finish);
        el.addEventListener("lostpointercapture", finish);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      });
      stage.appendChild(el);
    }
  }
  viewport.addEventListener("pointerdown", (e) => {
    if ((e.target !== viewport && e.target !== stage) || e.button !== 0) return;
    const pointerId = e.pointerId;
    try { viewport.setPointerCapture(pointerId); } catch {}
    const startX = e.clientX, startY = e.clientY, origX = state.x, origY = state.y;
    let active = true;
    const move = (ev) => {
      if (!active || ev.pointerId !== pointerId) return;
      state.x = origX + (ev.clientX - startX);
      state.y = origY + (ev.clientY - startY);
      stage.style.transform = "translate(" + state.x + "px," + state.y + "px) scale(" + state.zoom + ")";
    };
    const finish = (ev) => {
      if (!active || (ev && ev.pointerId !== undefined && ev.pointerId !== pointerId)) return;
      active = false;
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", finish);
      viewport.removeEventListener("pointercancel", finish);
      viewport.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      try { if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId); } catch {}
      save();
    };
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", finish);
    viewport.addEventListener("pointercancel", finish);
    viewport.addEventListener("lostpointercapture", finish);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
  document.getElementById("add-card").addEventListener("click", () => {
    const n = state.cards.length + 1;
    state.cards.push({ id: "c" + Date.now(), x: 60 + (n % 4) * 40, y: 60 + (n % 3) * 45, title: "Note #" + n, text: "" });
    render(); save();
  });
  document.getElementById("zoom-in").addEventListener("click", () => { state.zoom = Math.min(2, +(state.zoom + 0.1).toFixed(2)); render(); save(); });
  document.getElementById("zoom-out").addEventListener("click", () => { state.zoom = Math.max(0.5, +(state.zoom - 0.1).toFixed(2)); render(); save(); });
  document.getElementById("reset-view").addEventListener("click", () => { state.x = 40; state.y = 76; state.zoom = 1; render(); save(); });
  callHost("host.hello").then((info) => {
    if (info && info.theme === "dark") document.body.dataset.theme = "dark";
    if (info && info.locale === "zh") {
      document.getElementById("title").textContent = "无限画布";
      document.getElementById("status").textContent = "沙箱隔离";
      document.getElementById("add-card").textContent = "+ 卡片";
      document.getElementById("reset-view").textContent = "重置视图";
    }
    return callHost("storage.get", { key: "canvas-v1" });
  }).then((raw) => {
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cards)) state = parsed;
    }
  }).catch(() => {}).finally(render);
})();
</script>
</body>
</html>`;

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
