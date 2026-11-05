# Stable reply width while thinking

Run cards used `width: fit-content`, so the same reply changed from 280px to
680px as reasoning grew. Folding reasoning for a tool call, or replacing the
process with a short final answer, shrank the card again. The Markdown parser's
fallback and formatted layouts could also have different intrinsic widths.

The client now recognizes reply cards by the preserved boolean
`extra.config.streaming_mode`. Its presence remains after completion (false),
so a reloaded historical reply keeps the same layout without guessing from
localized status text or remembering DOM measurements. These cards use the
available reading column, capped at 680px. Window resizing remains responsive;
ordinary short text receipts keep their compact width. The existing marker
also covers continuation and reminder cards. No server/protocol migration is
required.

## Verification

- Before the fix, the new real-Hub regression measured a 400px width jump
  (280px to 680px) when reasoning grew.
- After the fix, a ResizeObserver records every rendered width while actual
  run constructors pass through translation and Hub updates: initial status,
  short/long reasoning, tool panels, text, table, final answer, process toggles,
  reload, and narrowing/restoring the window. Normal, CLI and pixel themes pass
  in Chromium and WebKit. Ordinary receipts remain smaller.
- All 13 focused streaming/card-layout/reading cases passed in Chromium;
  the first new-test attempt timed out waiting for pairing, before any layout
  assertions. The test now awaits the pairing screen closing, as the existing
  streaming test already did, before checking workspace readiness.
- WebKit passed 12 cases initially. The existing iOS-touch reading fixture
  failed to arrange its visible anchor/delayed Markdown, before its assertion;
  an isolated rerun passed unchanged. All three new width cases passed on the
  first WebKit run. This is not physical iOS acceptance.
- Actual macOS WKWebView acceptance used a separately identified
  `com.tarobot.stream-width-preview` App with a disposable local Hub. Native
  screenshots at a 1200px window showed identical left/right card edges for
  short reasoning, long reasoning, tool execution, completion and a manually
  expanded final process. The installed App and real conversations were not
  changed. The preview was quit and its temporary Hub stopped.
- Root standalone build and client TypeScript/production build passed.

Mac installer version: 1.0.42 (Apple Silicon). The final DMG was mounted
read-only; its App passed deep/strict signature verification, selected-icon,
version, architecture and bundled-host checks. The signature is ad-hoc, without
Apple notarization. Installer SHA-256:
`7bafb48a9c66a09f01ddcd954f6675d1b4fed2f6b73e2a6389e280ffc54cb7f1`.
Build/test logs and browser traces are under
`/Volumes/gdrive/taro-tmp/stream-width-*`. The local installer is a separate
delivery from source on `main`; existing installations require updating.
