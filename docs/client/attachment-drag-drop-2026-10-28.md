# Attachment drag and drop — 2026-10-28

The user reported that dragging an attachment into TaroBot had no useful effect.
The old client accepted HTML file drops only inside the main conversation body
or side panel. A drop over the sidebar/title area was swallowed by the navigation
guard, and modal rejection was silent. The change makes the destination and
outcome visible throughout the desktop window.

## Behavior

- With one visible conversation, dropping over its window, including the sidebar
  and title area, adds the files to that conversation's draft. The hover card
  names the destination and the pane uses the selected accent color.
- In ADHD mode, files go only to the pane under the pointer. Board space gives a
  targeting hint; it never guesses a chat. The side panel similarly owns its
  area, including when its host/engine cannot accept attachments.
- Existing draft text stays intact. A drop does not send a message; Send uses
  the existing shared upload/caption flow and its limits and permission checks.
- Folders are skipped with an explanation; valid files in the same drop remain.
  Zero-byte files are not mistaken for folders (the existing upload service may
  still reject an empty upload). Unreadable/empty file transfers give an error.
- Modals, menus, read-only/archived conversations and in-flight sends reject with
  a hint. An inline report/widget is not a modal. QR import retains its own
  handler. Plain text/link drags retain browser behavior.
- Changing the host/conversation or removing the target cancels the captured
  gesture. Leaving, Escape, ordinary pointer input and a dragover heartbeat
  remove stale hover decoration. The heartbeat does not erase the captured
  scope, so it cannot silently redirect an old drag to a new conversation.

## Review and corrections

Actual Claude Opus 5.5 independently reviewed the implementation and owned the
new disk-backed Chromium regression spec. Review caught and corrected:

1. Matching every `dialog[open]` incorrectly blocked chats containing an inline
   report/widget. Only modal dialogs, modal ARIA dialogs and menus now block.
2. During a text-only send, the upload controller can be busy without upload
   progress. Hover now observes sending state; the shared file intake also gives
   an error if it races with a send, rather than silently discarding the files.
3. Escape could poison subsequent drag gestures. A new gesture starts cleanly.
4. Removed DOM targets/OS cancellation can omit leave/end events. Bounds checks,
   pointer cleanup and a visual-only heartbeat prevent a stuck highlight.
5. Chromium suppresses `drop` when `dropEffect` is `none`, so rejection must be
   explained during hover. The target now supplies its specific reason; a modal
   rejection is portalled into the modal to remain visible and accessible.

## Boundaries

This is GUI input convenience, so the CLI is not applicable. Host APIs, upload
policy, model adapters, native filesystem permissions and installed runtimes are
unchanged. The main native window retains `dragDropEnabled: false` and uses the
WebView's HTML File path. Enabling the native Tauri drop handler would also change
text/link drag behavior and the fs plugin's automatic drop scope; it is not needed
for this implementation.

The browser suite distinguishes constructed DataTransfer events from Chromium's
disk-backed drag pipeline: the latter negotiates `dropEffect`, reads real file
bytes and exercises directory entries. Neither proves Finder/WKWebView or Windows
Explorer/WebView2 behavior. CUA did not obtain a valid native drag delivery receipt
in this session. Native Finder/Explorer drags, protected/cloud locations and file
promises from Photos/Mail remain unverified. This is a source change, not a release
or an update to the user's installed App.

## Verification

Evidence directory: `/Volumes/gdrive/taro-tmp/attachment-drop-20261028`.

| Check | Result | Evidence |
|---|---|---|
| Opus disk-backed Chromium drag cases | 11 passed | `opus-chromium-final.log` |
| Existing attachment/picker/paste/QR/side/safety cases, Chromium | 12 passed across the suite and isolated retry | `final-chromium.log`, `final-chromium-retry.log` |
| Same existing cases, WebKit | 12 passed | `final-webkit.log` |
| Client TypeScript and production bundle | passed | `client-build-r3.log` |
| Standalone Host build | passed, 459 modules | `host-build-final.log` |
| Native Finder/Explorer delivery | **not verified** | native limits above |

The initial Chromium run timed out waiting for a pairing code before the first
drag case reached its assertions; its isolated retry passed. The first Opus r3
run used a one-shot synthetic hover whose hint expired before the assertion;
draft hydration may have delayed it. The final spec models recurring dragover
while a drag is held, and explicitly stalls it for the heartbeat check. All
11 cases passed.
These initial failures remain in the evidence rather than being described as a
single clean run. The existing non-blocking Capacitor keyboard chunk warning
remains. Root and client lockfiles match the source of the shared dependency
directories; no dependency version was changed.

Tests verify mixed files/folders, exact uploaded bytes, retained text, no automatic
send, side/ADHD routing, modal/QR ownership, inline reports, read-only targets,
upload and durable text-send receipts, scope cancellation, hover cleanup and
ordinary text/link drags. Live archive and hidden-host routing were source-reviewed
but are not separately exercised by the new disk-backed suite.

## Compatibility follow-up

The final review prompted a guarded modal lookup: older WebViews that reject
`:modal` fall back to open dialogs while excluding collapsed report/widget cards.
The feedback portal uses the same lookup. An outside-coordinate leave also requires
a null related target and a coordinate strictly beyond the left/top boundary. A
captured target becoming hidden cancels the gesture instead of selecting another
chat. These are defensive checks; no claim is made that a native-engine failure
was reproduced. Native pointer-event behavior during OS drag remains unverified.

The first push's Source checks and Secret scanning jobs did not start because
GitHub reported failed account payments or a spending-limit restriction. They
are not passing CI results; local build and test evidence is listed above.

Follow-up validation: `client-build-r4.log` passed; the three directly affected
existing drag/QR/side cases passed in both Chromium and WebKit (`r4-chromium.log`,
`r4-webkit.log`). Opus added one selector-rejection compatibility case and it
passed (`opus-chromium-compat.log`), verifying collapsed/expanded reports, modal
hint visibility, retained draft files and QR ownership. Its follow-up review
approved the patch as a source change; native acceptance remains pending.
