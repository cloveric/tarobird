# Desktop list options

## Current entry — 2026-10-30

Right-click a folder name to use its existing pin/order/rename actions and
**Manage folders / 管理分组**, followed by the device-wide **List options /
列表选项**: **Group by host / 按主机分组** (when several Hosts are available)
and **Show disconnected Bots / 显示未连接 Bot**. The list-settings heading
separates them from the selected folder's own actions.

The search-row ellipsis and secondary-Host manager ellipses are removed.
Search and folder/Host badges keep the sidebar's available width; no standalone
options row remains. Right-clicking a Host heading manages that Host. Bot menus
also include the shared settings. Bot/group/global-pin section labels expose
the list context menu; keyboard users can focus a heading and press Shift+F10.
Labels without a collapse action also open the menu on Enter/Space or click.
Folder names keep ordinary click-to-collapse behavior.

Empty directory space retains right-click and Shift+F10 access, so a list with
no folders or visible Bots can still change visibility and create its first
folder. This fallback does not create implicit folder metadata or regroup a
mixed list: existing cross-Host recency ordering stays intact.

## Ownership and lifecycle

`SidebarListOptions` provides the shared preference controls.
`SidebarListSettings` joins the existing folder/Bot action menu, passing its
original connection. `FolderListOptions` resolves that connection against the
current directory Hosts. A Host-heading action resolves its `data-host-id`;
only unscoped blank-area/section actions default to the active available Host.
Coincident folder/Bot/conversation IDs on different Hosts never select a manager
by ID alone.

The manager lives at the stable directory owner and portals to `document.body`,
so activity reordering cannot remove its native dialog from the top layer.
Closing it restores focus to the clicked heading. Hidden workspaces, a replaced
connection, list/Host-filter changes, a phone/desktop layout transition and bulk
selection dismiss or disable its UI. The menu closes when regrouping removes
its original heading; preferences remain saved and can be read on reopening.

Menus reuse `DesktopMenu` for viewport clamping, keyboard movement, Escape/Tab,
click-outside dismissal and focus restoration. English labels wrap inside the
menu. Check marks and keyboard focus retain current accent and forced-color
styles. Phone list options and phone folder action sheets retain their existing
controls. Host data, folder writes, permissions and CLI APIs are unchanged;
this is App presentation and has no additional headless command.

## Verification

The focused bilingual browser journey covers mixed/grouped Hosts, same-ID
folders, owner-scoped managers, Bot section keyboard access, checkbox changes,
focus restoration, a 200 px sidebar, reload, ADHD and responsive dialog cleanup.
The empty-list journey creates the first folder via the context/keyboard entry.
Existing sidebar-layout and folder-manager/lifecycle journeys cover recency,
drafts, same-ID actions, mobile controls, pending order and leaving a Host.
Client translation/TypeScript/Vite and the standalone Host build passed.
Twenty-three distinct Chromium cases passed: three new list-menu cases, two
Bot-context cases, ten sidebar-layout cases, six folder-manager/lifecycle cases
and two menu-scroll cases. The three list-menu cases and both menu-scroll
cases also passed in WebKit (five cases). Repeated attempts are not counted
as extra coverage.

The regression pass exposed two harness assumptions: a checkbox locator was
required to survive intentional regroup dismissal, and keyboard focus did not
wait for the pending viewport resize after switching Hosts. The helpers now
click the requested state change and wait for normal actionability before
opening the keyboard menu. A separate context-menu scroll check also drove a
shared fix: unrelated pane scrolls no longer dismiss a menu, while scrolling
an ancestor of its trigger still does. Both anchored and context forms passed.

Screenshots use synthetic loopback Hubs. Browser results do not establish
installed Electron or physical-phone acceptance. This change does not publish
a release, install an App or restart a production Host.

## Earlier placement

The October 28 change moved long English checkboxes into a desktop ellipsis;
21 distinct browser cases covered that version. An earlier October 30 revision
placed the ellipsis beside search and secondary managers beside Host headings;
12 distinct Chromium cases covered that version. The current group-name context
entry supersedes both placements at the owner's request.
