import { createRoot } from "react-dom/client";
import { MessageContent } from "../../src/Content.js";
import { setLocale } from "../../src/i18n.js";
import type { HubConnection } from "../../src/connection.js";
import type { Message } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/expressive-themes.css";
import "../../src/layout-density.css";
import "../../src/porcelain-details.css";

// Production message renderer and save flow, isolated synthetic bytes. Native
// dialogs and filesystem IPC are doubles; no actual local file is opened.
const query = new URLSearchParams(location.search);
setLocale(query.get("locale") === "en" ? "en" : "zh");
document.documentElement.dataset.palette = query.get("palette") ?? "white-violet";
document.documentElement.dataset.theme = query.get("theme") ?? "light";
const state = { calls: [] as string[], fail: false, failDownload: false };
Object.assign(window, { savedLayout: state, isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: { data?: Uint8Array }) => {
  state.calls.push(command);
  switch (command) {
    case "plugin:dialog|save": return "/fixture/project-handoff.zip";
    case "plugin:fs|open": return 7;
    case "plugin:fs|write": return args.data!.length;
    case "quarantine_saved_file": case "plugin:fs|ftruncate": case "plugin:resources|close": return;
    case "open_saved_file": case "reveal_saved_file": if (state.fail) throw "saved_file_unavailable"; return;
    default: throw new Error(`unexpected_ipc:${command}`);
  }
} } });
const bytes = new Blob(["synthetic handoff file"]);
const source = { blob: bytes, retain() { return this; }, async dispose() {} };
const connection = { identity: { hubPublicKey: "fixture", deviceId: "device" }, file: async () => { if (state.failDownload) throw new Error("测试下载失败：当前连接已中断，请检查网络后重试。"); return source; } } as unknown as HubConnection;
const presentation = query.get("sample") === "presentation";
const author = query.get("author") === "user" ? "user" : "bot";
const message: Message = { id: "saved-file-layout", conversationId: "fixture", authorType: author, authorId: author, version: 1, status: "complete", createdAt: 1,
  blocks: [{ type: "text", text: presentation ? "淘通项目汇报（第3页更新为2026年1-9月数据）" : "项目交接包：配置模板、校验记录及后续步骤。已检查，不含私钥。" },
    { type: "file", attachmentId: "attachment", name: presentation ? "淘通项目汇报_更新1-9月.pptx" : "project-handoff-20261019.zip", mime: presentation ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/zip", size: presentation ? 65577 : 13610 }] };
if (query.get('caption') === 'none') message.blocks = message.blocks.filter(block => block.type !== 'text');
createRoot(document.getElementById("root")!).render(<main style={{ padding: 16, width: "100%", minHeight: "100vh", background: "var(--bg)" }}>
  <div className={`message ${author}`} style={{ position: "relative", width: Math.max(200, Math.min(700, Number(query.get("width")) || 440)), maxWidth: "100%", margin: 0 }}>
    <div className="message-body"><MessageContent message={message} connection={connection}/></div>
  </div>
</main>);
