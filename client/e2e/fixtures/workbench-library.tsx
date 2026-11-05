import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
import "../../src/bot-name.css";
import "../../src/layout-density.css";
import "../../src/motion.css";
import "../../src/porcelain-details.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientCache } from "../../src/storage.js";
import { HubConnection } from "../../src/connection.js";
import { emptyWorkbench, emptyBoard, workbenchScope } from "../../src/workbench-model.js";
import { emptyMarkdown } from "../../src/workbench-markdown.js";
import { emptyDesign } from "../../src/workbench-design.js";
import { WorkbenchLibrary } from "../../src/WorkbenchLibrary.js";
import { WorkbenchLibraryContext, type WorkbenchFileTarget, type WorkbenchLibraryHost } from "../../src/workbench-library-context.js";
import { CreationDialog } from "../../src/CreationDialog.js";
import { restoreAppearance, applyAppearance } from "../../src/appearance.js";
import { setLocale } from "../../src/i18n.js";
restoreAppearance(); applyAppearance({ theme: "light", palette: "mono", monoAccent: "warm-gray", animations: true });
const english = new URLSearchParams(location.search).has("en"); if (english) setLocale("en");
const opens: Array<{ host: string; file: WorkbenchFileTarget }> = [], hosts: WorkbenchLibraryHost[] = [];
for (const [key, name] of [["hub-one", "Mac mini"], ["hub-two", "工作电脑"]]) {
  const identity = { deviceId: "device", hubPublicKey: key, publicKey: `key-${key}`, name: "test", routes: [] };
  const cache = new ClientCache(`workbench-library-ui-${key}`); await cache.initializeIdentity(identity);
  const connection = new HubConnection(identity, cache); connection.state = { ...connection.state, status: "online", user: { id: "owner", name: "Owner", role: "owner" } } as typeof connection.state;
  hosts.push({ id: key, name, connection });
  await cache.saveConversations([{ id: "project", title: key === "hub-one" ? "产品讨论" : "客户方案", botIds: ["bot"], archived: false, type: "direct", createdAt: 1 } as any, { id: "archive", title: "已归档项目", botIds: ["bot"], archived: true, type: "direct", createdAt: 1 } as any]);
  const scope = workbenchScope(key, "owner", "project");
  const note = { id: "note-one", kind: "markdown" as const, title: key === "hub-one" ? "会议记录.md" : "合同要点.md" };
  const board = { id: "board-one", kind: "whiteboard" as const, title: key === "hub-one" ? "产品流程白板" : "客户方案白板" };
  const design = { id: "design-one", kind: "design" as const, title: key === "hub-one" ? "首页设计" : "封面设计" };
  await cache.saveWorkbench(scope, -1, { ...emptyWorkbench(), closed: [note, board, design] });
  await cache.saveWorkbenchMarkdown(scope, -1, emptyMarkdown(note.id, "Important saved content"));
  await cache.saveWorkbenchBoard(scope, -1, emptyBoard(board.id));
  await cache.saveWorkbenchDesign(scope, -1, emptyDesign(design.id, design.title));
  if (key === "hub-one") {
    const lost = workbenchScope(key, "owner", "removed");
    await cache.saveWorkbenchMarkdown(lost, -1, emptyMarkdown("orphan-note", "Keep unless explicitly selected"));
    const archive = workbenchScope(key, "owner", "archive");
    await cache.saveWorkbench(archive, -1, { ...emptyWorkbench(), closed: [{ id: "archived-note", kind: "markdown", title: "旧项目记录.md" }] });
    await cache.saveWorkbenchMarkdown(archive, -1, emptyMarkdown("archived-note", "Archived conversation"));
  }
}
const fixture = { hosts, opens, workbenchScope, hideSecondHost: () => {}, release: undefined as (() => void) | undefined,
  hold: async (kind: string, id: string) => { const scope = workbenchScope("hub-one", "owner", "project"); await new Promise<void>(resolve => { void navigator.locks.request(`tarobot-${kind}:${scope}:${id}`, async () => { await new Promise<void>(release => { fixture.release = release; resolve(); }); }); }); },
};
Object.assign(window, { workbenchLibraryFixture: fixture });
function App() {
  const [busy, setBusy] = useState(false), [visibleHosts, setVisibleHosts] = useState(hosts);
  fixture.hideSecondHost = () => setVisibleHosts(hosts.slice(0, 1));
  return <WorkbenchLibraryContext.Provider value={{ hosts: visibleHosts, open: async (host, file) => { opens.push({ host: host.id, file }); }, consumed() {} }}>
    <CreationDialog title={english ? "Workbench files" : "工作台文件"} close={() => {}} busy={busy} showHost={false} mobilePage className="library-ui-preview">
      <WorkbenchLibrary connection={hosts[0]!.connection} active onBusy={setBusy} onOpened={() => {}}/>
    </CreationDialog>
  </WorkbenchLibraryContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
