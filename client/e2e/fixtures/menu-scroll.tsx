import { createRoot } from "react-dom/client";
import { SidebarListOptions, SidebarListHeading } from "../../src/SidebarListOptions.js";
import { useRef, useState } from "react";
import { DesktopMenu, DesktopMenuPortalContext } from "../../src/DesktopMenu.js";
function AnchoredMenu() {
  const trigger = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  return <><button ref={trigger} onClick={() => setOpen(true)}>列表选项</button><DesktopMenuPortalContext.Provider value={true}><DesktopMenu id="options" label="列表选项" open={open} close={() => setOpen(false)} trigger={trigger} placement="down-end"><button data-menu-keep="true">Keep open</button></DesktopMenu></DesktopMenuPortalContext.Provider></>;
}

createRoot(document.getElementById("root")!).render(<div style={{ display: "flex", gap: 40 }}>
  <div aria-label="Sidebar scroll" style={{ height: 220, width: 300, overflow: "auto" }}>
    <AnchoredMenu/><SidebarListOptions options={<button data-menu-keep="true">Keep open</button>}><SidebarListHeading>Context heading</SidebarListHeading></SidebarListOptions>
    <div style={{ height: 900 }}>Sidebar</div>
  </div>
  <div aria-label="Chat scroll" style={{ height: 220, width: 300, overflow: "auto" }}><div style={{ height: 900 }}>Chat</div></div>
</div>);
