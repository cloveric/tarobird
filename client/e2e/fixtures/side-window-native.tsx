// Isolated fixture: real hook, native IPC and shared layout styles; no Hub/state.
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SidePanelResize } from "../../src/SidePanelResize.js";
import { Sidebar } from "../../src/Sidebar.js";
import { useSideWindowExpansion } from "../../src/use-side-window-expansion.js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/sidebar-resize.css";
import "../../src/side-conversation.css";
import "../../src/workbench.css";
import "../../src/conversation-details.css";

const workbench = new URLSearchParams(location.search || location.hash.slice(1)).get("surface") === "workbench";
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
let toggle: (open: boolean) => void;
function Audit() {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), [open, setOpen] = useState(false), [dark, setDark] = useState(false);
  toggle = value => flushSync(() => setOpen(value));
  const layout = useSideWindowExpansion(root, open);
  return <div ref={root} className={`app-shell ${open ? "has-side-panel" : ""}`} data-side-window={layout}>
    <Sidebar shown={false} active><div className="brand"><strong>TaroBot · 独立验收</strong></div><p>临时侧边对话</p>
      <button onClick={() => { setDark(!dark); document.documentElement.dataset.theme = dark ? "light" : "dark"; }}>切换浅深色</button>
      <button onClick={() => void run().catch(error => invoke("audit_record", { state: { error: String(error) } }))}>执行原生检查</button>
    </Sidebar>
    <main className="conversation-main"><header className="conversation-header"><strong>主对话保持原来的宽度</strong><button onClick={() => setOpen(!open)}>侧边对话</button></header>
      <div style={{ padding: 24, flex: 1 }}><p>打开侧边时，窗口向右扩展；屏幕放不下时，使用原来的分栏布局。</p><p>此窗口仅使用测试内容，不连接生产主机。</p></div>
      <div className="composer-wrap"><textarea aria-label="主对话草稿" defaultValue="主对话的草稿保留"/></div>
    </main>
    {open && <aside ref={panel} id="side-panel-audit" className={`${workbench ? "workbench" : "side-conversation"} conversation-side-panel`} hidden={layout === "pending"}><SidePanelResize panel={panel} visible={layout !== "pending"} controls="side-panel-audit" label="调整右侧栏宽度"/><header className="side-heading"><strong>侧边对话</strong><button onClick={() => setOpen(false)}>关闭侧边</button></header><div style={{ padding: 20, flex: 1 }}><p>临时问答</p><p>这里不改变主对话的消息和任务。</p></div><div className="side-compose composer-wrap"><textarea aria-label="侧边草稿" defaultValue="侧边的草稿"/></div></aside>}
  </div>;
}
const geometry = () => {
  const box = (s: string) => document.querySelector(s)?.getBoundingClientRect();
  return { viewport: innerWidth, main: box(".conversation-main")!.width, sidebar: box(".sidebar")!.width,
    side: box(".conversation-side-panel")?.width, layout: document.querySelector(".app-shell")!.getAttribute("data-side-window") };
};
async function stable(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 80; i++) { if (await check()) { await delay(100); if (await check()) return; } await delay(); }
  throw Error(`geometry did not settle: ${JSON.stringify(geometry())}`);
}
const assert = (value: boolean, message: string) => { if (!value) throw Error(message); };
const near = (a: number, b: number) => Math.abs(a - b) <= 2;
async function run() {
  if (!isTauri()) return;
  const w = getCurrentWindow(), monitor = (await currentMonitor())!;
  const record = async (name: string, extra = {}) => invoke("audit_record", { state: { name, ...geometry(), position: await w.outerPosition(), size: await w.innerSize(), ...extra } });
  const normal = async (width = 1000, edge = false) => {
    toggle(false); await delay(500); await invoke("audit_normal");
    await w.setSize(new LogicalSize(width, 700));
    const size = await w.outerSize();
    await w.setPosition(new PhysicalPosition(edge ? monitor.workArea.position.x + monitor.workArea.size.width - size.width : monitor.workArea.position.x + 30, monitor.workArea.position.y + 40));
    await stable(() => near(innerWidth, width));
  };
  await record("starting");
  await normal(); const before = geometry(), pos = await w.outerPosition(); await record("before");
  toggle(true);
  const openingFrames = [];
  for (let i = 0; i < 40; i++) {
    await new Promise(requestAnimationFrame);
    const side = document.querySelector<HTMLElement>(".conversation-side-panel")!, style = getComputedStyle(side);
    const frame = { ...geometry(), left: side.getBoundingClientRect().left, painted: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 };
    openingFrames.push(frame);
    assert(!frame.painted || frame.left >= before.viewport - 2, "side painted at old right edge before expansion");
    assert(near(frame.main, before.main), "opening frame changed main width");
  }
  await stable(() => geometry().layout === "expanded");
  assert(openingFrames.some(frame => frame.painted), "side did not enter after expansion");
  assert(near(geometry().main, before.main), "opening changed main width"); await record("opened", { openingFrames });
  toggle(false); assert(near(geometry().main, before.main), "closing briefly changed main width"); await stable(() => near(innerWidth, before.viewport));
  assert(near((await w.outerPosition()).x, pos.x), "close changed position"); await record("closed");
  await normal(1200); const crossing = geometry(); toggle(true); await stable(() => geometry().layout === "expanded");
  assert(near(geometry().main, crossing.main) && near(geometry().sidebar, crossing.sidebar), "crossing desktop breakpoint changed main/sidebar"); await record("breakpoint-opened");
  document.documentElement.style.setProperty("--desktop-sidebar-width", "480px");
  await normal(780); const narrow = geometry(); toggle(true); await stable(() => geometry().layout === "expanded");
  assert(near(geometry().main, narrow.main) && near(geometry().sidebar, narrow.sidebar), "narrow custom sidebar changed main width"); await record("narrow-opened");
  toggle(false); await stable(() => near(innerWidth, 780)); document.documentElement.style.removeProperty("--desktop-sidebar-width");
  await normal(1000, true); const edge = geometry(), edgePos = await w.outerPosition(); toggle(true); await stable(() => geometry().layout === "expanded");
  assert(near(geometry().main, edge.main) && (await w.outerPosition()).x < edgePos.x, "edge growth did not preserve main"); await record("edge-opened");
  toggle(false); await stable(async () => near(innerWidth, edge.viewport) && near((await w.outerPosition()).x, edgePos.x)); await record("edge-restored");
  await normal(); toggle(true); await stable(() => geometry().layout === "expanded"); await w.setSize(new LogicalSize(1450, 700)); await stable(() => near(innerWidth, 1450));
  toggle(false); await stable(() => near(innerWidth, 1000)); await record("manual-size-restored-to-original-width");
  await normal(); toggle(true); toggle(false); await delay(600); assert(near(innerWidth, 1000), "quick close left grown window"); await record("quick-close");
  await normal(); await invoke("audit_maximize"); await stable(() => w.isMaximized()); const maximized = geometry();
  toggle(true); await stable(() => geometry().layout === "split"); assert(near(innerWidth, maximized.viewport) && await w.isMaximized(), "maximized window changed"); await record("maximized-split");
  await normal(); await w.setFullscreen(true); await stable(() => w.isFullscreen()); const full = geometry();
  toggle(true); await stable(() => geometry().layout === "split"); assert(near(innerWidth, full.viewport) && await w.isFullscreen(), "fullscreen window changed"); await record("fullscreen-split");
  toggle(false); await w.setFullscreen(false); await stable(async () => !await w.isFullscreen());
  await normal(Math.floor(monitor.workArea.size.width / monitor.scaleFactor) - 100); const tight = geometry();
  toggle(true); await stable(() => geometry().layout === "split"); assert(near(innerWidth, tight.viewport), "insufficient room resized window"); await record("insufficient-room-split");
  await normal(); toggle(true); await stable(() => geometry().layout === "expanded"); await record("PASS");
}
createRoot(document.getElementById("root")!).render(<Audit/>);
Object.assign(window, { sideAudit: { geometry, run, toggle: (open: boolean) => toggle(open) } });
