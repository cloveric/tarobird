# Workbench delete labels — 2026-10-31

The owner asked whether “Delete local note/board” removes everything on the
device or everything in the conversation. The existing operation removes only
the selected document ID inside the current Host/user/conversation scope, from
this device's cache. Other notes/boards, conversations, Bots, chat messages and
exported files are retained. The device qualifier describes where data is
stored; it does not mean device-wide deletion. “Delete this conversation's
notes” would also overstate the scope.

Desktop and phone now use “删除这篇笔记 / Delete this note” and
“删除这张白板 / Delete this board” in tab menus and the closed-content list.
The confirmation names the selected document and explicitly describes the
conversation/device scope, preserved content and export option. The closed-list
capacity message asks for individual deletions. Accessible delete-button names
use the same wording plus the document title.

“关闭标签 / Close tab” continues to retain note/board content for reopening.
“已保存在本机 / Saved on this device” remains accurate and is unchanged. The
separate remove-Host/reset warnings still describe their broader data scope.

Only labels and confirmation copy change. Controller/storage delete operations,
permissions, Host/Bot tools and headless CLI contracts are unchanged; no new CLI
entry is applicable. No owner content is deleted and no release/install is done.

Verification: client translations, TypeScript and production build passed.
The existing Chromium/WebKit closed-note flow verifies cancel, retention,
explicit deletion and the selected-title/scope confirmation. Browser evidence
is not native or physical-device acceptance.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/workbench-delete-labels-20261031/`.
