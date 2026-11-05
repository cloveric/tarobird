# Post-1.0.115 UI audit (2026-10-27)

Baseline: `4fcfc997960f63b79a7a9111b669f1b5415eb86d` (App 1.0.115 / Host 0.1.460).
Independent UI candidate: `45e4aed103e876787258bf0c6bb9ba6d14f4d306`.

Root and Claude Opus 5.5 xhigh audited the intervening changes with isolated
Hosts and synthetic conversations. Production conversations and preferences were
not used as test fixtures.

## Confirmed corrections

- **OPUS-01: folded ADHD topics hid pending questions and approvals.** The
  top-level group previously looked only at its own messages. It now summarizes
  the already host-scoped `InboxRow.attention` while collapsed. Expanded and
  filtered views keep the indicator on the actual topic. Resolving a card updates
  the indicator through the existing activity projection; no new state or unread
  mutation is introduced. The user's default-collapse policy remains intact.
- **ROOT-02: pinning a topic removed it from ADHD's picker.** ADHD's inbox has no
  standalone pinned-topic section, although its child filter excluded pins as
  the ordinary Bot tree does. Keep all live topics under their group in ADHD.
  Pin/unpin still uses the original Host API; ordinary Bot-list pin presentation
  is unchanged. Each topic has one picker row and remains actionable.
- **OPUS-02/03: short reply-source text was centered, and empty row space
  navigated to the source.** Keep inline-size containment on a non-interactive
  wrapper, while the actual button is left-aligned and fitted to its content.
  Long excerpts still ellipsize in WebKit, fitted cards and narrow panes; the
  phone button retains its touch height. The regression checks both alignment
  and blank-space clicks, alongside source navigation and unchanged message data.
- **OPUS-04: non-monochrome recording timers lost contrast.** White Orange and
  White Teal measured 4.34:1 on the recording strip. Blend the fallback accent
  slightly toward theme text. Monochrome's existing accent tokens and cancellation
  red remain intact. The actual recorder tests now check all palette families,
  phone/desktop, light/dark and both timer/waveform colors.
- **OPUS-05: minimum-width ADHD sidebars lost conversation titles.** Pending
  question/approval text consumed the title column. At the narrow container
  breakpoint, use a compact accent marker with the original state in the row's
  accessible name and localized tooltip, and tighten only those rows' gaps.
  Wider sidebars retain the status words. This was reproduced against the first
  frozen build (10.25px in the single-Host fixture, 0px in Opus's multi-Host
  fixture). The first candidate was not published; all final platform packages
  were rebuilt from `c7c84ec6`. Superseded receipts remain archived, not reused.
- **OPUS-06: high-contrast modes hid the compact marker.** In forced-colors
  mode use the system CanvasText color with explicit color adjustment. The
  accessible state and tooltip stay intact. Chromium verifies the actual
  computed system color; ordinary themes keep their accent.
- **Test readiness:** the mobile lazy-loading placeholder also has `.mobile-home`.
  The test helper now waits for a real `data-tab` before choosing the messages
  options sheet or Bot controls. Both initial WebKit failures showed that
  placeholder in their traces, rather than a missing product control.
- **Test readiness:** Claude adapter tests waited only 50 zero-delay ticks for
  asynchronous policy and prompt-file reads before the fake process spawn.
  The whole-suite failure was that readiness timeout; both tests passed alone.
  Wait for the actual call, with a bounded five-second deadline, preserving
  the original policy, prompt and session assertions. Runtime code is unchanged.

## Scope retained

Light warm-grey setup buttons remain independent of accent selection. The new
warm-grey and lighter sage accents retain their separate readable text tokens.
Desktop unread indicators are red dots; phone avatar indicators retain counts.
The message-tab aggregate, recording waveform/timer and active reply indicators
follow their intended accent rules. Platform-specific density is unchanged.

ADHD keeps its flat light canvas, one fine rounded pane border and no duplicate
left border or resting shadow. Agent Bus and Return to chat have no permanent
button frame. Conversation titles retain adjacent Bot/model identity. Long reply
source text stays within the pane and still navigates to the original message.

This is App presentation and test infrastructure. No CLI command, engine
execution policy, protocol, Hub schema, backup setting or retention policy is
changed. The release rebuilds the same web client into the canonical Host/CLI.

## Evidence and remaining boundaries

The first broad Chromium pass completed 147 tests. The first WebKit pass
completed 142, skipped three guarded cases, and exposed the two readiness
failures above. The focused rerun passed those mobile and sidebar journeys in
both engines. The new pinning case first failed, exposing ROOT-02; the final ADHD topic matrix
passed 14 tests per browser. The independent audit then exposed OPUS-02/03/04;
root reproduced the 309.5px source offset and 4.3365:1 recording contrast before
fixing them. The final reply-source/Porcelain matrix passed 26 Chromium cases
and 25 WebKit cases, with one existing guarded WebKit skip. Final package
results are recorded in the release verification record.

The first root test launch also hit macOS `spawn Unknown system error -88` in
several workers. That attempt is not a passing gate. Fresh release dependencies
and independent full checks are required. The later complete run reached 6,885
passes, five conditional skips and the two bounded-wait failures above, without
that process-launch error. After the readiness corrections, the complete gate
passed 6,887 JavaScript tests (five conditional skips) and 77 native desktop tests.
The final release gate, including the subsequent reply-source and contrast
corrections, again passed 6,887 JavaScript tests (five conditional skips) and
77 native desktop tests. Both builds and repository checks passed.

The final r2 narrow-sidebar and resize matrix passed five Chromium and five
WebKit tests. It verifies the compact marker, retained accessible state, a
readable title column in both themes and restoration of the status words when
resized wider. The preliminary screenshot review caught a CSS-specificity
conflict; the final selector and regression explicitly cover its computed size.

Opus's final independent review includes all seven corrections, high-contrast
coverage and the final release-helper bindings. It has no open blocking items.
The final complete gate on `c7c84ec6` passed 506 JavaScript test files / 6,887
tests (five conditional skips), 77 native desktop tests, both builds and
repository checks. The subsequent packaging-environment correction and rebuilt
artifact parity are documented in the release verification record below.

Browser tests are not physical-device acceptance. Native Windows startup,
physical iPhone/Android gestures and APNs/FCM delivery are not established by this
audit. Final package, publication and local activation evidence belongs in
[the 1.0.116 verification record](../releases/1.0.116-verification.md).
