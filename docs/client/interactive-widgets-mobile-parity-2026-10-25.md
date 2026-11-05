# Interactive widgets: second OpenClaw and mobile audit

The first implementation (`daba282`) added generic report controls and authored
interaction. This follow-up tests the boundaries against actual OpenClaw source,
ordinary generated JavaScript patterns, browser engines and a physical iPhone.
It does not claim full browser compatibility or modify the installed production
App/Host. No release is included.

## Reference and scope

OpenClaw is pinned to
[`274a86d02febe855ca2aeea71f44000531689e0a`](https://github.com/openclaw/openclaw/tree/274a86d02febe855ca2aeea71f44000531689e0a).
Primary references:

- [show-widget contract](https://github.com/openclaw/openclaw/blob/274a86d02febe855ca2aeea71f44000531689e0a/docs/tools/show-widget.md)
- [inline wrapper and bridges](https://github.com/openclaw/openclaw/blob/274a86d02febe855ca2aeea71f44000531689e0a/src/canvas/wrap.ts)
- [visualization authoring skill](https://github.com/openclaw/openclaw/blob/274a86d02febe855ca2aeea71f44000531689e0a/skills/visualize/SKILL.md)

The audit separates chat-inline widgets from pinned Dashboard widgets. Dashboard
data/action/cron grants and `state.emit` are not default inline capabilities;
`state.emit` is a notification, not durable storage. Source inspection is not
an independent run of OpenClaw's native apps.

| Area | OpenClaw | TaroBot after this follow-up |
|---|---|---|
| Generic interaction | Authored real browser DOM; local controls, forms, SVG/Canvas and allowed libraries | Generic fixed reports plus authored HTML/SVG, linked filters, parameter calculations, multi-step plans and process steps |
| Execution | Isolated iframe/WebView, full browser APIs inside its sandbox | Terminable Worker, virtual DOM and sanitized real controls; no authored script on the App UI thread |
| External dependencies | Approved CDN libraries/modules/styles/fonts | No remote scripts, modules or arbitrary network; embed bounded observations from normal tools |
| Geometry/animation | Browser layout, Canvas/WebGL and browser animation APIs | Event/observed-element geometry and CSS transitions; no complete synchronous layout, Canvas/WebGL or smooth continuous Worker-DOM animation guarantee |
| Follow-up question | Web Control UI can directly submit a user turn after activation checks; native inline prompt bridge is documented as absent | Explicit user action fills the current conversation's draft across App clients; acceptance is not sending or model receipt |
| Local state | No general inline persistence API in the referenced contract | Explicit bounded per-window state; terminal flush on normal navigation, not disk persistence |
| Error repair | Syntax preflight; bounded automatic runtime feedback in Control UI, not native inline | Script/handler location at publication; visible diagnostics and an explicit repair-draft action, no automatic model turn |
| Phone reading | Web implementation supports much taller inline content; native policy not independently verified | Compact inline height and expanded reader; keyboard band, focused-input reveal, iOS input zoom protection and wide-table hint tested |

## Confirmed defects and repairs

1. **Last state lost on rapid departure.** The Worker and relay each coalesced
   updates. Removing a frame before the pending update arrived lost a selection.
   `widget-state-lifecycle.ts` now requests a terminal snapshot, commits it under
   the exact frame/key/request/scope/source identity, and releases the frame only
   after the trusted viewer terminates its Worker and acknowledges. The normal
   no-widget navigation path is still synchronous. Healthy acknowledgements
   finish immediately; the 900 ms bound is for broken/unresponsive frames.

2. **A valid dense SVG was quarantined during ordinary slider dragging.** A real
   mouse drag over a 1,600-cell chart reproduced the rate limit. Rendering now
   coalesces the newest snapshot according to payload cost and reserves transport
   headroom for state/heartbeat traffic. Deferred updates do not advance the
   sent-control snapshot or ACK. Hard byte, node, message and CPU limits remain.
   This is bounded throughput, not a claim of high-frame-rate dense rendering.

3. **`innerText` assignment silently left old content visible.** LinkeDOM only
   supplied a getter. Assignment now writes plain text with explicit line-break
   nodes; it does not parse the text as HTML or claim a CSS-aware rendered-text
   getter.

4. **iPhone input focus zoomed the entire view and clipped right controls.** The
   independent native audit reproduced it. Only iOS widget input/select/textarea
   controls receive a minimum 16 CSS px. Body text and Android/desktop typography
   are unchanged; larger user font choices remain larger.

5. **The expanded reader ignored the keyboard's visible band.** Both authored
   widgets and fixed reports now follow the existing native viewport variables
   and safe areas. After a smaller iframe viewport arrives, the viewer scrolls
   only the actual focused text editor into view. It grants no activation and
   does not ask authored code to refocus. A physical software-keyboard test
   caught the second issue after CSS alone had fixed only the outer rectangle.

6. **Wide report details hid their horizontal affordance.** A hint appears only
   when the real table overflows. The region can scroll by touch, trackpad or
   keyboard, and the expanded report respects asymmetric safe areas. Data,
   columns and text size are retained.

7. **Runtime failure had no actionable model handoff.** A bounded diagnostic is
   text, never executable markup. “把问题填入输入框” appends a repair request to
   the owning conversation's existing draft. It does not send, stop, steer or
   replace files/quotes. Diagnostics are identified as untrusted component data.
   The shared validator reports script number or handler and line/snippet before
   publication; neither preflight nor diagnosis executes supplied source.

8. **Touch-emulated desktop Chromium was mistaken for iPad.** Its MacIntel plus
   touch points activated iOS scroll compensation and temporarily shifted a
   short landscape widget under the conversation header. Platform detection now
   excludes desktop Chromium/Firefox engines while retaining actual iOS user
   agents. The landscape test also explicitly exercises the iOS path so excluding
   an emulator is not a substitute for testing that path.

9. **A newly mounted static preview could accept input before its handlers
   existed.** A select visibly changed, then the first Worker render replaced it
   with its default value. Scripted previews now remain inert until the first
   real Worker snapshot has been applied. Transport readiness is separate from
   interactive readiness, so even an initializing Worker can be retired. Controls
   are also disabled during retirement. Script-free readable content remains
   selectable; unsupported controls are not presented as working controls.

10. **Normal Host switching was treated as permission loss.** The retained App
    previously discarded its widget before terminal state could be saved. A
    two-Host regression reproduces the lost counter at baseline and verifies
    independent state and drafts after the fix, including identical conversation
    and message IDs. Actual identity/permission loss still discards immediately.

11. **Static fallback could report a state-loss warning without evidence.** The
    Worker now explicitly reports either its last state or known absence of
    state before unsupported fallback. Unknown failure still reports uncertainty;
    it is never turned into a false successful save. Read-only views show the
    readable summary instead of an empty interactive rectangle, and revoke
    closes an already-expanded reader. The race between retirement and an
    initialization overflow has its own red-to-green test: the known final
    fallback state is acknowledged exactly once instead of timing out.

## Lifecycle, compatibility and entrypoints

`Widget.tsx` retains a running message row while its state lease drains.
`use-widget-state-selection.ts` keeps conversation selection, recipient and draft
on the same actual conversation until normal retirement completes. App, ADHD
pane changes and Host workspace changes share the owner-level barrier. Multiple
widgets drain as one owner; the first acknowledgement cannot restart execution
while another widget is still retiring. New copies wait only for their own
retiring scope/source, not unrelated panes.

Real permission/identity loss discards immediately. Stale or foreign replies
cannot update another scope. Timeout/invalid snapshots retain the last confirmed
state and show a warning for that source. Killing/reloading the App still clears
the in-memory cache. Authored controls that never call `tarobot.state.set` still
reset when recreated. The setter should be called synchronously in the input
handler, before an `await`; the runtime already coalesces transport. It cannot
recover changes that authored code has not submitted to the state API.

The diagnostic draft action is idempotent against rapid repeat clicks. Reload
clears the previous diagnostic and enables a new repair request. Forwarded
widgets do not offer this action because they cannot hand a draft to the source
Bot. Diagnostic text is bounded, stripped of direction/control characters and
quoted as data. None of these actions send a message automatically.

The message/report envelope, frozen tool definitions v1–v5, native bridge guards,
Host routes, publication idempotency and old-client readable summaries are
unchanged. The new terminal protocol is between client-bundled layers; it does
not require a new Hub capability. Old clients simply retain their old runtime.
The relay also accepts a previously loaded viewer's ready-only transport
handshake; unsupported old terminal protocols are bounded by the same timeout,
not misreported as a confirmed save.
Native App tools, compatibility delivery and `tarobot widgets publish` continue
to share the validator. Host/CLI builds include the updated guidance and syntax
errors; there is no new management command or production Host restart here.

## General interaction and mobile review

`docs/examples/widget-decision-workbench.html` combines task-appropriate linked
filtering, a two-step plan with Back/review, and a selectable four-stage process.
It is an illustrative test/example, not a hard-coded product template. A second
scenario explorer covers range/select/checkbox calculations and draft handoff.
Guidance covers pointer events, vertical page scrolling, local state, empty
results, touch inspection, domain validation, small screens and reduced motion.
Unsupported APIs are explained rather than replaced with successful-looking
no-op shims.

Browser widths include 320, 390, 430, 844×390 and 1360; both Chromium and WebKit,
light/dark, real control events, keyboard navigation, safe-area and viewport
contracts are exercised. Browser viewport simulation is not physical-device
acceptance. Native validation uses the connected iPhone 15 Pro Max with an
independent `com.tarocub.widget-audit` bundle and isolated TLS Hub; the user's
production App, data and pairing remain intact.

The explicit iOS reading-compensation case runs on WebKit, with a documented
platform skip in Chromium; the ordinary 844×390 case runs in both engines using
their own user agents. A diagnostic experiment forcing a Safari UA on Chromium
failed 2 of 3 runs: virtual-list compensation put the iframe behind the App
header, and actual hit testing clicked the header. Removing or changing the
screenshot did not cure that impossible engine/platform combination. The same
complete iOS case passed 3 of 3 WebKit runs. Production iOS compensation was not
changed to accommodate the spoofed Chromium environment. This is not physical
iPhone landscape acceptance.

Evidence is retained under
`/Volumes/gdrive/taro-tmp/widget-parity-mobile-20261025`. The initial independent
Opus 5.5 xhigh corpus/dense probes, direct read-only source review, baseline
failures, browser logs/traces and `native/` screenshots are separate evidence
sets. Final counts and native boundaries are recorded below.

## Verification and review record

The actual Claude Opus 5.5 xhigh review was run separately from the internal
coding agents. Its source review found the init/retirement unsupported race,
expanded-revoke issue and diagnostic Unicode separator issue. Each was checked
and repaired; the first two have failing-before/passing-after browser evidence.
Its suggestion to treat unknown initialization state as a successful save was
not adopted. The read-only review is not presented as Opus running the final
App or independently passing the test suites.

- Full unit suite: 490 files, 6,692 passed and 5 conditional skips. After the
  final focused repairs, the four relevant unit files passed all 22 tests;
  example/publication validation passed all 8 again.
- Final bundled mobile/layout, composer handoff and lifecycle/performance
  checks: Chromium 36 passed / 2 conditional skips; WebKit 36 passed / 2
  conditional skips (`r7-chromium.log`, `r7-webkit.log`). Skips are the
  WebKit-only iOS branch in Chromium, Chromium-only allocation metrics in
  WebKit, and the opt-in busy CPU profile in both. Earlier diagnostic failures
  are retained, not silently relabelled as passes.
- State lifecycle coverage: 14 browser cases passed in each engine; the final
  expanded-revoke and legacy-handshake checks passed 2/2 in each engine.
  Runtime startup/retirement/fallback cases passed 6/6 in each engine.
- Controls: Chromium 19/19; WebKit 18 passed with the existing synthetic IME
  case skipped. Actual iPhone Chinese composition is separate native evidence.
  CPU-isolation cases passed 16/16 in each engine. The CPU/byte/node protections
  were preserved.
- Client typecheck, translations, client production build, 445-module
  standalone Host build and `git diff --check` passed. The runtime source and
  public relay match the frozen r7 assets used for final verification.

The earlier WebKit scroll-edge regression did not reach its required edge:
the widget bottom was 25 while the scrollport top was 64 after a deferred row
measurement. The test now establishes and asserts the actual zero-area edge
before exercising real IntersectionObserver re-entry. The expected successful
re-entry was retained. An earlier Chromium load-error probe ran while another
build replaced lazy assets; it passed on three fixed-build repetitions and the
subsequent frozen candidate. Builds are kept stable during final browser/native
verification.

### Physical iPhone evidence

The physical device is an iPhone 15 Pro Max running iOS 27.0.1. The first native
round reproduced full-page zoom, a panel extending behind the software keyboard,
and a focused editor remaining outside the shortened panel. The repaired r2
candidate passed actual software-keyboard Chinese candidate selection, keyboard
dismissal, preserved draft handoff, return-to-conversation state, native selects,
checkboxes and sliders. Fixed report series toggles and long-table horizontal
and vertical gestures also passed. A gesture beginning inside the table at its
bottom continued into the next seeded chat message.

The final frozen **r7** build was then installed in the same independent Audit
bundle and paired to a fresh isolated Host. Cold entry, native select/checkbox,
expansion, automatic bottom-editor reveal with the real keyboard, actual
`qt` → `全天` Chinese candidate entry, keyboard dismissal and draft-preserving
handoff all passed again. Rapid leave/return after changing the range and after
a checkbox tap retained the newest choices, the question and the main draft.
The 50 ms script interval used between tap and Back is not a measured device
latency claim. The transient initial disabled frame was too short to observe
manually; the first-frame race is covered by browser tests instead.

The final native receipt is `native/r7/native-acceptance.md`. Root verified all
447 candidate files and all 3 example HTML hashes against the tested manifest.
App entry is `App-YWVoCg-Y.js` (`6072c87979cd…`), widget entry is
`Widget-CkWChlcT.js` (`14d51b7169b3…`). SQLite readback again showed 3 seeded Bot
messages and 0 user messages. The fixture was backed up, terminated and both
listeners verified closed. The production phone App's version and container
URL remained unchanged. Final physical screenshots were delivered separately
from browser screenshots.

Native screenshots and read-only fixture DB checks are under `native/`; the
seeded fake Host contained zero user messages after handoff. These are real
touch/keyboard/layout results, not real model-response acceptance or measured
frame-rate claims. Reloading the App resets widget window-memory state as
documented, while ordinary App drafts and pairing survive.

Physical landscape was **not verified**: the device orientation command returned
portrait. Android hardware, Duo hardware, alternate iOS versions, native dark
theme, VoiceOver and sustained frame-rate measurements were not tested. Browser
landscape, dark theme and 320/390/430 widths are separate evidence.

## Remaining gaps

- Full browser DOM, Canvas/WebGL, third-party chart libraries, complete geometry
  and advanced animation remain unsupported. Adding them safely needs a separate
  execution/rendering design, not a few silent shims.
- The inline frame still has a bounded height and can contain its own scroll
  region. The expanded reader is available; this is not equivalent to OpenClaw's
  taller web-inline layout. Do not claim universal scroll-chain behavior from a
  long-table test alone.
- No generic durable component state, generated-widget PNG export, automatic
  runtime model repair, Dashboard data/action grants or inline remote refresh is
  added. The user-controlled repair draft and current-window state have explicit
  boundaries.
- A good authoring recipe and tested examples do not prove every model-generated
  widget will be attractive or correct. Generated content must still be inspected
  for units, empty states, accessibility and phone layout.
