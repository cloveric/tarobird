import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { LocalImagePreview } from "../../src/LocalImagePreview.js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installNativeContextMenu } from "../../src/native-context-menu.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/message-images.css";

function specimen(long: boolean): Blob {
  const height = long ? 4800 : 1800;
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}">
    <rect width="1200" height="${height}" fill="#f5f1e8"/><circle cx="1020" cy="180" r="420" fill="#e2c6ad"/>
    <path d="M0 720 Q400 300 1200 790 V${height} H0Z" fill="#6e8177"/><path d="M0 1000 Q650 650 1200 1200 V${height} H0Z" fill="#2f4d49"/>
    <g font-family="system-ui,sans-serif"><text x="80" y="140" fill="#243b36" font-size="30" letter-spacing="8">TAROBOT / PHOTO VIEWER</text>
    <text x="80" y="300" fill="#243b36" font-size="100">山色与留白</text><text x="80" y="370" fill="#44534b" font-size="36">完整画面 · 自由查看</text>
    <text x="80" y="${height - 100}" fill="#f5f1e8" font-size="42">${long ? "长图底部 / END OF IMAGE" : "1200 × 1800"}</text></g></svg>`], { type: "image/svg+xml" });
}
function Audit() {
  const [image, setImage] = useState<Blob>(), [name, setName] = useState(""), last = useRef("");
  const [pasted, setPasted] = useState("");
  useEffect(installNativeContextMenu, []);
  useEffect(() => {
    const timer = setInterval(async () => {
      const dialog = document.querySelector(".image-preview-lightbox"), photo = dialog?.querySelector("img"), reader = dialog?.querySelector(".image-preview-scroll"), box = photo?.getBoundingClientRect();
      const state = { open: !!dialog, controls: dialog?.getAttribute("data-controls"), image: photo?.alt, width: box?.width, height: box?.height,
        scrollX: reader?.scrollLeft, scrollY: reader?.scrollTop, fullscreen: await getCurrentWindow().isFullscreen(), windowFocused: await getCurrentWindow().isFocused(), documentFocused: document.hasFocus(), active: (document.activeElement as HTMLElement)?.getAttribute("aria-label"),
        viewport: { width: innerWidth, height: innerHeight }, menu: dialog?.querySelector('[role="menu"]')?.textContent,
        clipboardAvailable: typeof navigator.clipboard?.write === "function", copyStatus: dialog?.querySelector('[role="status"]')?.textContent,
        error: dialog?.querySelector('[role="alert"]')?.textContent };
      const value = JSON.stringify(state); if (last.current !== value) { last.current = value; await invoke("audit_record", { state }); }
    }, 250);
    return () => clearInterval(timer);
  }, []);
  return <main style={{ padding: 40 }}><h1>图片浏览器 · 原生验收</h1><p>独立测试窗口，使用正式查看器代码；不连接生产主机。</p>
    <button onClick={() => { setName("山色与留白.svg"); setImage(specimen(false)); }}>打开竖图</button>{" "}
    <button onClick={() => { setName("长图.svg"); setImage(specimen(true)); }}>打开长图</button>
    <p><textarea aria-label="粘贴验收" placeholder="复制图片后，在这里按 ⌘V" onPaste={event => {
      const file = [...event.clipboardData.files].find(file => file.type.startsWith("image/")); if (!file) return;
      event.preventDefault(); const url = URL.createObjectURL(file), photo = new Image(); photo.src = url;
      void photo.decode().then(async () => {
        const receipt = { pastedImage: true, mime: file.type, width: photo.naturalWidth, height: photo.naturalHeight };
        setPasted(JSON.stringify(receipt)); await invoke("audit_record", { state: receipt });
      }).finally(() => URL.revokeObjectURL(url));
    }}/></p><output>{pasted}</output>
    {image && <LocalImagePreview blob={image} name={name} close={() => setImage(undefined)} save={() => {}}/>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Audit/>);
