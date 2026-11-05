# Remote screen fullscreen close — 2026-11-04

The owner reported a black App window after connecting a screen, entering
fullscreen and clicking X. The supplied screenshot is entirely black. The
installed App was rendering normally when inspected in this turn; its exact
black-screen incident has not been reproduced against the real remote Host.

## Repair

The viewer previously disconnected and unmounted immediately when X was clicked.
Its fullscreen cleanup ran asynchronously after removal. Focused negative tests
confirmed that a delayed or rejected exit lost the viewer and its retry controls.

X now stops the remote session immediately, waits for fullscreen exit, and only
then closes the panel. Failed exits retain a disconnected panel with an error and
retry controls. A close token is invalidated by unmount or a Host change, so a
late completion cannot close a replacement viewer. Reconnect, repeated X and
fullscreen toggles are disabled while closing.

The first repair, which waited only for the HTML promise, failed the real
Electron quick-close test: native fullscreen ended and window bounds returned,
but `document.fullscreenElement` remained set and the disconnected panel stayed
fullscreen. That failed iteration is retained in `native-green.log` and
`native-green.noindex/failure.json`; it is not passing evidence.

The final repair also waits for macOS fullscreen transition completion. The
existing native window read reports whether `isFullScreen()` differs from the
last completed native fullscreen event. The screen controller serializes entry
and exit through that state, with a bounded five-second wait. It never forces
the window out of pre-existing fullscreen or borrows another element's HTML
fullscreen. This follows Electron's documented requirement to use completed
[fullscreen events](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag)
before dependent operations on macOS.

The change is local viewer/window presentation and lifecycle. The Host's screen
authorization, transport, capture/input, grants and `tarobot screens` CLI remain
unchanged; no new headless command is needed.

## Evidence

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/screen-fullscreen-close-20261104`.

- `browser-red.log`: both focused cases failed before the repair, because the
  fullscreen panel and exit controls had already been removed.
- `browser-green.log`: the initial four lifecycle cases passed. These were not
  sufficient native evidence, as the subsequent Electron failure showed.
- `native-final.noindex/verification.json`: final isolated Electron 45.1.0,
  production permissions and `DesktopServices` window reads; ordinary fullscreen
  exit, X during entry, and X after completed entry all restore HTML/native state,
  original 1100 × 760 bounds, and editable local chat. Three native entry/exit
  event pairs are recorded. Restored-window screenshots were visually inspected.
- `browser-frozen.log`: all 38 remote-screen cases passed. The shared image-viewer
  fullscreen case initially failed because this worktree lacked its `client/dist`
  fixture link (page snapshot: `not_found`). After pointing that link to the final
  client build, `image-frozen-retake.log` passed the same case without changing its
  assertions or timeout. The temporary link was removed afterwards; both logs
  are retained.
- `final-unit.log`: 18 controller/viewer tests passed; `desktop-services.log`:
  seven native service tests passed, including completed-event state tracking.
- `host-final-build.log` and `client-frozen-build.log`: Host build (490 modules),
  UI translations, TypeScript and client production build passed. Existing Vite
  chunk-size/dynamic-import warnings remain. No packaged App was built.
- The evidence root's `verification.json` records these outcomes and source
  file hashes; the full logs remain alongside it.

The first exploratory `native-red.log` reported success using only an early
state/bounds read; its event list did not yet include the second completed native
exit. `native-close-baseline.log` added that event assertion and passed on the old
source. Neither reproduces the owner's original black screenshot. The interim
`browser-final.log` ran while the final exit wait was being edited and is excluded
from the final source-bound result; `browser-frozen.log` is the replacement.

## Remaining boundary

The Electron fixture uses synthetic pixels and a mock screen transport. It does
not capture a real desktop, send real remote input, or exercise another machine
or WAN. No release, local installation, grant, TCC permission, service restart or
version change was performed. Mac 1.0.129 has not received this repair or the
preceding neutral-label/narrow-layout repair. Real installed-App verification of
this reported path remains pending, as do the earlier canvas/PPT acceptance items.
