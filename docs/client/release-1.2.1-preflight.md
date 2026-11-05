# TaroBird 1.2.1 scoped patch

The owner authorized a small patch release for the desktop pre-ready quit error.
The published baseline is 1.2.0, source
`6d102164287ffc3df62b351173b6967fafee1384`; the fix is
`1972d6d16b8b525b45cf0c3b5b75fc01ed8f15d9`.

Only the shared Electron exit handler changes product behavior: call
`globalShortcut.unregisterAll()` only after `app.isReady()`. A rejected second
instance can quit before ready. Normal shortcut cleanup, tray disposal, restart,
unsaved-work cancellation and Host lifetime retain their existing behavior.

Two negative regressions reproduced the exception before the fix. The affected
Electron suite and a real Electron early-exit/normal-exit/two-process probe pass
on macOS. Native Windows execution remains a separate, uncompleted acceptance
scope. The two-process probe uses a window stand-in and does not certify the
installed App UI. Headless Host/CLI and mobile behavior are unchanged.

Publish macOS, Windows, Android, iOS and the matching CLI from one new frozen source. Windows
uses a formal manual Release without an automatic-update manifest until native
update acceptance is complete. Android and iOS are rebuilt as 1.2.1 at the owner's request to keep versions
aligned; their functional source is unchanged. No local production
App replacement or Host restart is part of this publication request.

This release follows the owner-authorized scoped-patch profile. Dependency
resolution, editor/skill files and unaffected source are compared with 1.2.0;
unchanged model/editor/Host tests remain baseline evidence, not fresh results.
Fresh affected tests/builds, package-content checks, signing/notarization,
artifact privacy scans and published downloads are still required. Record their
actual final source SHA and receipts outside the repository. This preflight is
not a publication or physical-device acceptance receipt.
