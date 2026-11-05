# Ten images and one PDF: real-engine acceptance

2026-10-03. This covers the program/browser portion of original plan gate 5.
Claude Code 2.1.287 (`sonnet`, `low`) runs through the production managed worker
and an isolated real Hub. Independent desktop and phone browser contexts use
the actual pairing, composer, attachment cache and download controls. Chromium
and WebKit each passed the complete flow.

## What was verified

- One phone-composer send contains its text, ten PNGs and one PDF. The Hub stores
  one user message, and the native CLI receives all eleven unchanged files.
- Each image has a fresh eight-character code in its pixels; the PDF contains
  a separate code. None is given in the user prompt or filenames. The real model
  reads all eleven correctly into a JSON report.
- The compatibility `send.batch` path returns one ten-image card with a title
  for every image, plus the original PDF and the report with their captions.
- Both browsers decode every image. SHA-256 of each browser's cached attachment
  matches the original; both download buttons return the exact PDF and the
  parsed report. There is no horizontal page overflow at either viewport size.
- Normal viewport captures, including the beginning and end of the gallery,
  were inspected. A desktop grid and a phone single-column gallery are present.

The opt-in test is `client/e2e/live-media-batch.spec.ts`, with authored fixtures
in `client/e2e/fixtures/media-batch.ts`. Run from `client` with
`TAROCUB_LIVE_MEDIA_BATCH=1 TMPDIR=/tmp/t npx playwright test e2e/live-media-batch.spec.ts`;
add `--config playwright.webkit.config.ts` for WebKit. Ordinary test runs skip
before starting the Hub, CLI, or optional native canvas helper. The observer
only records input attachment paths and disables native session persistence;
it does not inject replies or tool results. Owned temporary workers and files
are closed and removed afterward.

## Test repairs and limits

Initial attempts exposed verification issues: CSP correctly rejects fetching a
`blob:` URL as a connection; Chromium response interception returned empty bodies
despite decoded images; and a five-second polling deadline interrupted WebKit's
still-progressing sequential upload. The test now reads only its own attachment
records from IndexedDB and waits for the complete atomic send. CSP, upload,
delivery and model behavior were not changed. Oversized locator screenshots
were replaced with ordinary viewport captures because the chat scroller clips
them. A separate card-state test now drains its queued task before teardown,
avoiding cleanup while that task can still write files.

This is not an iOS/Android native-container, cellular/VPS, all-model or all-engine
acceptance. Claude uses the compatibility delivery directive; it does not prove
native structured batch tools. Subsequent Codex native grid/batch work and
version-preserving migration are recorded separately in
[native batch delivery](native-batch-delivery.md). No deployed fleet, credential, signing or
release configuration changed.

Machine-readable results and source/screenshot hashes:
receipt（本地材料：`evidence/live-media-batch-2026-10-03.json`）.

## 2026-10-04 follow-up

The shared test now accepts `TAROCUB_LIVE_MEDIA_ENGINE=kimi|antigravity` as well
as the default Claude. [Current Kimi/AGY evidence and retained model error](compat-media-2026-10-04.md)
include both browsers and the newer phone IM. Only Claude disables session
persistence; Kimi uses a private home and AGY native history remains. Recognition
errors still fail the test but no longer prevent subsequent transport checks.
Current Claude native-versus-compatibility delivery is not identified by this
shared observer; use the separate native App-tools test for that assertion.
