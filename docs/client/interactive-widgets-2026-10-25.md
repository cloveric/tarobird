# General-purpose interactive widgets

This change lets models choose an authored interaction appropriate to the task:
parameter exploration, filtering, linked views, local calculations and controlled
handoff to the conversation composer. It also improves the generic fixed report
renderer. It does not hard-code financial instruments or individual charts.

## Ownership and compatibility

- `gateway/widget-guidance.ts` supplies format selection and examples on demand
  to every engine. Updated 2026-10-31: default to authored HTML/SVG/JavaScript for
  all new visuals; structured reports require an explicit user request. Existing
  report messages retain their renderer and interaction. This supersedes the
  original fixed-data recommendation.
- `client/src/widget-runtime/worker.js` executes authored scripts in the existing
  terminable Worker. `viewer.js` owns the real DOM and native input controls.
- `Widget.tsx`, `public/widget-sandbox.html` and `widget-compose.ts` provide the
  bounded composer handoff. `App.tsx` binds the handoff to its own conversation.
- `Report.tsx` provides series toggles and record inspection for existing report
  v1 data. Hidden series keep their original colors and line patterns. Numeric
  summaries and underlying rows remain intact; line charts use a padded visible
  data range with explicit ticks and a scale note, while bars retain a zero
  baseline. All-hidden is explicit and has a restore action.

Existing tool definitions v1–v5, message envelopes, report schema, Host APIs,
pairing and publication permissions are unchanged. Native, compatibility-fence
and headless `widgets publish --html-file/--report-file` entrypoints still share
validation, receipts and history. No version bump, installer, release or local
production Host replacement is part of this source change.

The Host/CLI receives updated authoring guidance on build. It needs no new
management command: controls are client presentation, and composer handoff
prepares the existing ordinary message. Existing CLI publication keeps working
with the desktop closed. A future release that includes this Host guidance must
package the standalone CLI from the same source as the bundled Host.

## Choosing an interaction

The fixed-report path remains data-driven: every line/bar report gains toggles
for its declared series, pointer inspection, touch selection, a compact record
picker and keyboard previous/next actions. Filtering, the details table and
expanded view use the same source rows. Hiding a series changes the chart, not
the numeric source or aggregate definitions. No stock-specific column names or
indicators are special-cased.

For interactions beyond that schema, the model authors local HTML/SVG and
JavaScript appropriate to the question. Examples include a parameter calculator,
a filtered catalog, linked comparisons or a step-by-step explanation. The
shared guidance explains controls, theme tokens, phone layout, empty states and
optional draft handoff. This is a bounded execution environment, not a bundled
chart library or a promise that every generated UI is automatically correct.

## Compose contract

```js
if (window.tarobot?.prompt?.compose) {
  button.onclick = async () => {
    const accepted = await tarobot.prompt.compose(
      'Please compare the selected scenarios: ...'
    );
    // accepted means the text was added to this conversation's draft only.
  };
}
```

Label the button “填入输入框” / “Add to composer”, or explain its destination
beside it. The model includes the selected values and a concrete question in
plain text. Feature detection preserves old clients and local-only interactions.

A request requires a real click/submit event, a one-use short-lived gesture
capability, an active visible focused frame, and a matching frame lifetime.
Automatic loading, timers, hover, synthetic guest events and replay are not
permission to change the App draft. Requests are bounded and cannot contain a
slash command. The parent validates text again and appends rather than replacing.

Success is **not** transmission, CLI receipt, model receipt or task completion.
The user sends via the normal composer. Existing text, files, quotation,
recipients and supplement/queue choice remain owned by that composer. No hidden
call can bypass outbox idempotency, group rules or native input controls. A
switched/archived/read-only conversation or a forwarded/other-Bot-origin widget or a composer still loading/sending may
refuse without changing the draft. Repeated requests cannot duplicate insertion.

The implementation deliberately does not impersonate OpenClaw's immediate
`prompt.send`: its return value and UI are explicitly draft preparation.

## Scope and interaction state

Fixed report filters, series visibility and selected record survive view switches
and inline/expanded transitions. Data replacement resets stale row selection.
Custom widget state survives expansion in the same frame. Hiding/unmounting a
widget still terminates its Worker; local selections without an explicit state
update reset when the widget is recreated.
Authors may explicitly keep a small selection object through `tarobot.state.set(value)` and validate `tarobot.state.initial` at startup. The App retains at most 64 entries of 16 KiB each, scoped by Host/user/conversation/message/block and source hash. This cache is window memory only; refresh, eviction or changed source resets it. Updates are bounded/coalesced; set returning true means a valid update queued for transfer, not a durable receipt. The [second mobile/parity audit](interactive-widgets-mobile-parity-2026-10-25.md) adds a terminal state acknowledgement before normal conversation/pane changes and virtual-row retirement. A failed or unresponsive runtime has a bounded grace period and a scoped warning; permission loss still tears down immediately. App termination cannot guarantee a flush. No implicit form replay, whole-heap snapshot, durable custom-code state or background execution is introduced.

The original Worker watchdog, resource limits, sanitization, theme, quarantine,
opaque frame and native bridge guards remain. No arbitrary Host API, network,
external library, Canvas/WebGL or UI-thread script execution is added. Ordinary
local controls and SVG/CSS remain the authoring target; this is not a claim of
complete browser DOM compatibility. Old clients require an App update to gain
new control semantics; their readable text fallback is retained.

See `docs/examples/widget-scenario-explorer.html` for an adaptable local
calculator with range/select/checkbox controls, a local form, a comparative SVG,
reset and composer handoff. Its values are clearly labeled illustrative data.

## Bounded DOM support

The runtime supports native text/range/checkbox/radio/select controls with live
properties, local form submit/reset, text `FormData`, pointer capture and common
keyboard/pointer/focus events. It preserves the distinction between a control's
current value and its HTML default. The renderer and Worker exchange bounded
state with event acknowledgements; ordinary authored code never runs on the App
UI thread.

Forms render as neutral containers with `role=form`. Ordinary form type
selectors are mapped to that container; prefer classes for portable styling,
and do not rely on form-only pseudo-classes such as `:invalid`. Use
`form.elements.name`, not direct named properties. Common constraint validation is supported, with native feedback where the
current frame and gesture permit it. This is not complete HTML constraint
validation; authors must validate domain requirements and provide inline
explanations. File inputs and contenteditable synchronization remain unsupported.

Event handlers execute after native events cross the Worker boundary. They
cannot synchronously cancel native scrolling or a real checkbox click; authors
should use `disabled` and explicit zoom controls. Geometry is current for the
event target/ancestors and observed elements, not arbitrary synchronous layout.
The small state cache and composer handoff do not grant new Host or network
permissions.

## Verification

Evidence and independent review are retained under
`/Volumes/gdrive/taro-tmp/interactive-widgets-20261025`.

- Full Vitest before the final narrow review: **486 files, 6,663 passed,
  5 conditional skips**. Guidance/compose/state and tool-contract follow-up:
  **33 passed**. Final review then added the chart-domain suite (**14 passed**)
  and repeated guidance/compose/state (**12 passed**).
- Host standalone build, client translation check, TypeScript and client build
  passed. The standalone graph remains 445 modules, without legacy transports.
- Broad integrated Chromium before the final visual/receipt follow-up: **77 passed, 1 conditional skip** across inline
  widgets, controls, compose, settings, Worker isolation and performance.
- Broad WebKit coverage of those same files: **75 passed, 3 conditional skips**
  (Opus inline/isolation/performance/compose 56+2; controls 15+1; root settings
  4). Root independently reran compose+settings: **12 passed**. Do not add this
  duplicate compose run to the total. Skips concern opt-in/Chromium-specific
  measurements and Chromium-only IME instrumentation.
- After the final review, all affected report/compose/control suites passed
  again: **40 Chromium; 39 WebKit + 1 Chromium-only IME skip**. This includes
  14 report cases per browser, narrow layouts, touch/keyboard inspection, series
  identity, all-hidden reset, filters, data replacement, line/bar axis boundaries
  and a 5.5-second delayed draft-handoff receipt. These overlap the broader run;
  they must not be summed as unique cases.
- Six independent runtime probes, compared with native DOM behavior where
  applicable, confirm the fixes for ACK/keyup input rollback, asynchronous
  property updates, literal attributes versus live `:checked`, form validation,
  custom-error clear/reset semantics and quoted CSS selectors. Their final
  assertion receipt is `report-audit/final/verified-results.json`.
- A real authenticated Codex model (`gpt-6.1-sol`, low) generated a new calculator
  through the normal App tool path on the final build. Actual controls produced 2,960 → 3,320 →
  4,580 → 3,320 for the tested parameter changes, respected phone/desktop and
  light/dark layouts, and filled the draft without sending. The generated HTML
  and screenshots are in `live-model/reviewed`. Its isolated thread was archived by
  the guarded acceptance cleanup; production conversations were not used.

The runtime was implemented and iteratively reviewed with CC1 / Claude Opus
5.5 xhigh. Root and an independent reviewer reproduced the reported failures
and checked the corrected controls against the original probes. Source hashes
for that acceptance are worker `6d4e9566…` and viewer `f801375a…`; the final
browser build uses those same runtime bytes.

Opus also independently exercised the complete UI at desktop and narrow touch
widths, with light/dark themes, calculations, reset, series switches, filtering,
table details and draft preservation. Its final follow-up (`opus-final-review.md`,
section 8) accepted the corrected line scale, bounded receipt timing, temporary
status notice, guidance and example typography without a remaining blocker.
The explicit selection cache still has a documented best-effort limitation:
immediate teardown can lose the most recent update (the Worker and relay each
coalesce state). It is neither durable storage nor an acceptance guarantee.

The new regression cases retain the original privacy and watchdog checks:
network/native APIs remain unavailable, initialization/click loops are
terminated, hidden widgets release execution, hover cannot steal composer
focus, and forged/replayed handoff attempts cannot silently insert text.
Draft handoff tests include existing text, quotation, attachment, queue choice,
conversation change and forwarded-widget authority.

Screenshots are browser acceptance at phone and desktop widths, not physical
iPhone/Android or installed Tauri/WebView2 acceptance. WebKit is an engine
check, not proof of every native wrapper behavior. This change has not been
released or installed locally.
