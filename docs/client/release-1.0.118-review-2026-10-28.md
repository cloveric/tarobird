# 1.0.118 review

App 1.0.118 accompanies Host/CLI 0.1.463, wire protocol 1 and Hub schema 22
(upgrade input range 1–22). Android versionCode is 2026102801; iOS build is 1.
The previous published source is `5950ea656c74150498f41b44dc52f613d5c68fb8`
(App 1.0.117 / Host 0.1.462). This document records the review; artifact
publication, signing, installation and physical-device acceptance need their
own final receipts and are not established by this document.

## Reviewed scope

The owner requested review with Claude Opus 5.5, fixes and a release. The primary
review covered Host storage, CLI parity and compatibility; an independent
`claude-opus-5-5` review covered the changes from the previous published source
through `ba0fa5bf6a3617e4629f5ff47b3e787165343f67`, followed by the review fixes.
No critical/high issue was found in that initial review. This is not a guarantee
that every runtime/device path is defect-free.

The release includes notification content/privacy and native settings guidance;
device/network layout and QR photo saving; full-page phone settings and label
weights; ADHD surfaces, accent focus frames and avatar-free message layout;
file cards; personal App history clearing; two Host query latency repairs;
archived-conversation unread exclusion; bulk selection/deletion layout; and the
flatter mobile Messages icon. Personal clearing preserves canonical Bot messages,
native sessions, attachments, other members' history, drafts and later messages.

## Changes made during this review

- Restore the host-location label's bottom spacing inside the new settings-page
  body, including the default, White and Mono palettes.
- Express notification placeholder and bidi-stripping characters with explicit
  Unicode escapes. Runtime strings and regular expressions remain equivalent.
- Add `messages_personal_history`, an additive partial index on conversation ID
  for non-deleted shared messages. Its implicit rowid order removes the full
  temporary sort from clear-history planning and page selection. Existing
  membership checks, task/card protections, fixed message-ID boundary and
  100-record page limit are unchanged. Remaining counts still scan history.
- Move the slash-stop test's cold Gateway/runtime imports to suite loading.
  Preserve the default test deadline and all interruption/queue assertions.

The clear-history regression uses the actual executed SQL to check the query
plan, and checks insertion order when creation timestamps run backwards. The
clear-history, notification content and push suites passed 76 tests after these
changes. The prompt-queue suite passed all 47 tests at its existing deadlines.
The initial focused run had timing/cleanup failures while cold builds and
dependency installation competed for disk IO; these are retained as failed
attempts, not counted as passes. Final full-suite evidence is separate.

An isolated synthetic comparison used a target conversation with 20,000 messages
and another with 20,000 messages, each body containing 2,000 text characters.
For the first five clear pages, the original query's median was 363.4 ms and
the indexed query's median was 187.5 ms; planning was 222.4 ms and 85.5 ms.
The machine was shared with browser checks. These measurements demonstrate a
query-plan improvement, not a guaranteed device speed or a whole-history total.
An intermediate run with an invalid body-size argument is excluded.

A separate synthetic streaming-write check alternated without/with the index
twice, with 70 measured updates per round and 36,000-character bodies. Median
write times were 9.97/8.92 ms and 8.82/9.00 ms; p95 was 19.11/20.04 ms and
12.22/12.50 ms. It did not show a material write regression in this small sample;
it does not establish production load performance.

## Compatibility and known limits

- Update paired Apps before clearing very large histories. Older Apps still
  understand the deletion events, but can rebuild their local preview for every
  message and become slow while catching up. The new App avoids that repeated
  full-history read. No protocol-breaking bulk deletion event is introduced.
- An active task or actionable question/approval pauses clearing before changing
  that page. Earlier pages stay cleared. A stale card can block progress; the
  current error does not identify the exact blocking message.
- Notification previews now include message details by default. The new Host
  exposes per-device controls; older Hosts without the customization capability
  cannot supply those controls. OS notification privacy controls remain relevant
  until the Host is updated. Queued notices recheck current privacy preferences.
- A tool-delivered attachment may appear before the model generates its later
  text response. This release does not claim to fix that model/tool ordering gap
  or change daily Bot reasoning settings.
- The personal-history index is additive and does not change schema 22 or
  persisted rowids. Normal index maintenance supports old writers and offline
  VACUUM. The existing-host upgrade gate must still validate final packages.

## CLI and release boundaries

Host changes apply to the shared headless core. `tarobot messages clear` uses
the same authorization, boundary, page and retry rules as the App. Presentation
changes do not need separate CLI controls. The standalone 0.1.463 archive and
the Apps must be built from one frozen source revision and checked after upload.

At review time, GitHub source-check and secret-check jobs were not starting due
to the account's payment/spending limit. Local required checks and artifact
acceptance remain mandatory; blocked CI is not reported as passed. Native
Windows startup, physical Android/iPhone upgrades and push delivery are separate
from cross-compilation, Simulator, browser, signing and server readback checks.
