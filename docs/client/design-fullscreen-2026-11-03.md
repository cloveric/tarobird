# Installed Design/PPT acceptance and fullscreen repair — 2026-11-03

The installed Mac 1.0.128 player offered “Full screen (F)” and then disabled it
with “Full screen isn’t available here”. Native CUA reproduced the failure.
The editor's Permissions-Policy allowed fullscreen; Electron's permission
request handler rejected every child document. Source 7f65323 remains the
published and installed version. This repair is a subsequent source change,
not an installed repair or a new release.

The fixed loader gives each opaque editor document a distinct UUID fragment.
Electron allows only `fullscreen` for the owned App's exact bootstrap document
with that fragment, matching exactly one live direct child across the entire
frame tree. Nested/duplicate URLs, stale or foreign contents, widgets and
arbitrary data documents are denied. Media, clipboard and automatic fullscreen
permissions remain restricted. No vendored editor bytes or native bridges were
changed. The static loader and Electron policy share one bootstrap constant.

Actual Opus 5.5 independently diagnosed the failure and reviewed the repair.
The root agent verified the execution transcript's model fields. The review
identified the multiple-editor ambiguity of a static URL; the per-instance
fragment and native two-editor test address it. Its initial statement equating
written negative tests with passing tests was explicitly corrected; only
completed receipts below count as runtime evidence.

Validation:

- The added native fullscreen assertion failed against the original policy.
- 368 Electron contract tests passed, including positive and negative permission
  paths; 7 focused client resource/input tests passed.
- 11 real-editor Electron checks passed: no-gesture denial, nested and duplicate
  URL permission denial, button/F fullscreen entry and exit with two editors,
  opaque-origin isolation, saving/reopening, theme/resize and quit recovery.
- 17 existing real-editor canvas Electron checks also passed with the new loader,
  including Unicode artboards, local assets and native quit/save recovery.
- Host and client production builds passed. The client retains existing chunk
  size and mixed static/dynamic import warnings.

Native test corrections are retained in the private lab: wait for the native
fullscreen transition before toggling again; account for auto-hidden controls;
let a Playwright-injected activation expire for the no-gesture case; inspect
the actual denied permission callback and native/DOM fullscreen state instead
of awaiting an Electron nested-frame promise that remains pending; retire and
reopen each test editor through its save handshake between denial scenarios.
The original failed runs were not relabeled passing.

The installed App independently passed version/Host connection, canvas Unicode
edit/history/reopen/backup, and two-slide PPT Unicode/notes/reopen/windowed
navigation/PPTX XML readback. Two fresh installed-App conversations also verified actual Claude `pptx` and
`baoyu-ppt` invocations, respectively, with native PPTX delivery/XML/previews and
Baoyu saved revision/readback plus both authored pages visible. Installed
fullscreen still fails until a later
explicitly authorized update. No production model, permission grant, owner
project or installed signed bundle was modified for the repair. Remote screen,
physical phones and wide-area networking are outside this new evidence.

CLI impact: this is a desktop permission policy and static editor loader change.
No Host command, identity, transport or authorization API changes; no new CLI
command is needed. Future publication must still bind App and canonical CLI to
one source revision under the repository's release rules.
