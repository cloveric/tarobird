import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { MessageContent } from "../../src/Content.js";
import { RuntimeHostActiveContext } from "../../src/RuntimeHost.js";
import type { HubConnection } from "../../src/connection.js";
import type { Message } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";
import "../../src/porcelain-details.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.palette = "mono";
document.documentElement.dataset.theme = query.get("theme") ?? "light";
if (query.get("platform") === "macos") Object.assign(window, { isTauri: true });
if (query.get("platform") === "ios" || query.get("platform") === "android") Capacitor.getPlatform = () => query.get("platform")!;
const connection = {
  state: { status: "online" }, subscribe: () => () => {},
  acquireAttachment: (id: string) => ({ promise: fetch(`./media/${id}`).then(response => response.blob()), release() {} }),
} as unknown as HubConnection;
function Fixture() {
  const [active, setActive] = useState(true), [attachmentId, setId] = useState(query.get("file") ?? "tone.wav");
  Object.assign(window, { audioFixture: { setActive, setId } });
  const message: Message = { id: "audio-preview", conversationId: "fixture", authorType: "user", authorId: "owner", version: 1, status: "complete", createdAt: 1, blocks: [...(query.has("caption") ? [{ type: "text" as const, text: "刚刚开的会，请转写后修改两个文件。" }] : []), { type: "audio", attachmentId }] };
  return <main style={{ padding: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
    <div className="message user" style={{ width: Number(query.get("width")) || 300, maxWidth: "100%", margin: 0 }}>
      <div className="message-body"><RuntimeHostActiveContext.Provider value={active}><MessageContent connection={connection} message={message}/></RuntimeHostActiveContext.Provider></div>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
