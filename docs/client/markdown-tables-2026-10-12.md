# Message table reading — 2026-10-12

Message tables previously shared a `width: 100%` layout with prose. On narrow
screens, long CJK cells could wrap into a handful of characters per line and
make a single row occupy most of the chat viewport.

## Behavior

- Columns now retain their content width inside a horizontally scrollable table,
  with a bounded inner box for long prose and unbroken tokens. Amounts, dates,
  links, emphasis and Markdown column alignment are preserved.
- Only the table scrolls horizontally. Ordinary narrow tables have no extra
  toolbar. Wide tables show a swipe hint; wide or tall tables can be expanded.
- Expanded tables use a full phone viewport or a large desktop dialog. The
  header row stays visible during vertical scrolling. The reader follows the
  current sanitized Markdown tree, including streamed changes.
- Escape, native Back and the close button dismiss the reader. The existing
  horizontal offset and composer draft survive. Removing the source table also
  removes the dialog. Quote thumbnails remain passive and contain no new controls.
- The full-screen phone reader owns its safe-area padding; it is excluded from
  the generic bottom-sheet height limit. Arrow keys scroll focused tables in
  both Chromium and WebKit, without taking over links or modified shortcuts.

No message text, attachment, prompt, context or server state is transformed.
Long notes remain fully readable; the UI does not silently shorten financial
figures or explanations. For explanation-heavy output, a short summary table
with details below it is another authoring option, not an automatic rewrite.

## Verification

The production client was served by an isolated Hub with fixture messages at
1360, 390 and 320 CSS pixels. Both engines passed the table journey: local
scrolling, bounded page width, one-line amount, right alignment, full-screen
bounds, sticky header, live table updates, short-table controls disappearing,
long-token bounds, passive quotes, Escape/native Back, draft preservation and
source unmount. Chromium additionally passed trusted touch swipes at both
phone sizes without opening the message action sheet. Phone safe-area padding
was checked with nonzero top/bottom insets.

At 390px, the sample's table width was 682px in Chromium and 680px in WebKit;
the long-note column was 277px, with a row height of 108.56px. The amount stayed
on one 22.4px line. These are fixture measurements, not a measurement of the
user's screenshot. Sanitized captures and receipts are in
[`evidence/markdown-tables-2026-10-12`](evidence/markdown-tables-2026-10-12).

- Chromium: 20 checks passed across `markdown-tables`, `markdown`, `card-layout`,
  `message-actions` and `message-reading`; the final three table checks passed
  again after the WebKit keyboard correction and safe-area assertions.
- WebKit: final three table checks passed; five Markdown and four message-action
  checks passed; desktop and phone history-anchor checks passed.
- The separate WebKit `message-reading` **ios-touch** fixture failed before its
  assertion, with `Fixture needs a visible anchor and delayed Markdown above it`.
  An isolated archive of the unchanged parent `94706d6` reproduced the same
  failure at the same line. This remains an open test-setup issue; it is not
  counted as a passing iOS acceptance check.
- Host build and tests: 223 files passed, 2875 tests passed, one skipped.
- Client TypeScript/Vite build passed. Android unit checks, release lint and
  release assembly passed.

## Android package

`0.1.411-test.1` uses package `com.tarocub.client`, versionCode `2026101226`,
and the same signing certificate as `0.1.410-test.1`. All 376 bundled web assets
were compared byte-for-byte with the synchronized production build; the signed
APK's package/version, signature and launcher icons were verified.

This is an Android-only package update. The shared desktop code is on main,
but this change does not replace an installed macOS App or the user's phone.
Browser tests and package verification do not establish physical-device or
installed native WebView acceptance. No production host, relay, legacy adapter
or installed service was restarted.
