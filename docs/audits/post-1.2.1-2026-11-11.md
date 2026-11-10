# Post-1.2.1 source audit

Scope: the official desktop/Android 1.2.1 release source
`94afa5903b22e184f61750c501dee8272d30a878` through
`1818166b2e6c4c490a9a77912745e6fb461a406e`: 74 commits, 251 changed files.
This is a source audit and repair, not a release, installation or physical-device
acceptance. Product and platform version counters are unchanged.

## Review and confirmed fixes

The primary reviewer and the Fable Bot independently reviewed the changes.
Fable reviewed engine turns, model discovery/settings, Bot communication,
updates, ZIP handling and attachment lifecycle; scoped secondary reviews covered
Workbench/editor resources, client UI, mobile/native transport and remote screen.
Findings were reproduced with isolated fixtures before production changes.

| Area | Reproduction | Repair |
| --- | --- | --- |
| Large attachment cache | Two windows simultaneously cache different 17 MiB files under a 24 MiB budget; both writes see free capacity. | Serialize capacity checks and copies across windows, retaining per-entry locks and active preview leases. |
| Deleted attachment cache | A download or Blob materialization finishes after the user deletes the attachment and restores its IndexedDB copy. | Recheck deletion, connection lifetime and cancellation inside the cache write transaction. |
| Attachment pagination | Deleting the only item on page 2 leaves 100 existing items inaccessible behind an empty list. | Move to the last remaining page and reload, guarded by request identity. |
| Connection labels | An old LAN address retained during network replacement is labelled ready using a mode-wide listener flag. | Show an address-confirmation state when existing host notices lack per-address readiness evidence. |
| Model discovery deadline | A stalled CLI takes 15 seconds, exceeding the Hub's 10-second Bot RPC; a settings write can complete after the caller has timed out. | Bound the entire discovery exchange, including initialization and all pages, to 4 seconds. |
| Model effort choices | The model picker uses discovered effort restrictions while the effort picker accepts a level excluded by that same CLI. | Use the same discovered Claude/Codex restrictions in both entry points, including cold-cache writes and models without effort. |
| Historical attachment references | After owner deletion, updating the original message or retiring its action buttons during Bot deletion fails with `attachment_not_found`. | Permit only that message's existing tombstone references. New messages and re-added references remain rejected; downloads still return 410. |
| Forwarding deleted attachments | Retirement succeeds but physical purge is interrupted; forwarding the old message can copy the residual bytes into a new live attachment. | Reject retired source attachments before forwarding, including when residual bytes remain. |
| Side conversation focus | Explicitly reopening a hidden side conversation leaves focus on its trigger instead of the input. | Request focus through the existing open path without rebuilding the session or clearing the draft; passive return still preserves focus. This issue also exists in the release baseline. |

The model deadline repair retains bounded discovery on cold-cache writes: skipping
it could accept an unsupported effort for a newly discovered model. Discovery
failure still uses the existing built-in fallback. No schema migration, permission
expansion or engine-session reset is introduced.
The cache review also reproduced a regression risk introduced by the initial
budget lock: a duplicate of an already cached file could wait behind an unrelated
copy. The final repair checks that cache hit under its entry lock before joining
the budget queue; the gated-copy regression passes.

## Validation

| Check | Result |
| --- | --- |
| Host build and final client translations/TypeScript/Vite build | Passed |
| Full Vitest suite with official Node 24 | 650 files passed; 8,444 tests passed, 7 skipped |
| Final disk-cache Chromium suite | 6 passed, including shared capacity, immediate cache hits, deletion and active preview leases |
| Integrated side conversation, deletion, pagination and connection-label Chromium suites | 39 passed on the final client build |
| Broader attachment/draft/Workbench/PPT/phone/side-window Chromium run | 111 passed, 4 skipped; the one reproducible side-focus failure was fixed and rerun in the integrated suite |
| Model discovery/settings focused suites | 56 passed across 4 files; six new tests failed before the repair |
| Attachment retirement/forwarding focused suites | 20 passed, including original-file 410, rejected new references and independent prior copies |
| Repository and browser-keychain isolation Node checks | 29 passed |
| Native core and addon | 63 + 33 passed; 2 core opt-ins ignored |
| Native updater | 71 exercised and passed; 2 real-archive opt-ins were not exercised |
| Isolated signed-fixture updater lab | 16 passed, including public-repository updates without credentials |
| Mobile/remote-screen baseline supplement | 44 unit + 38 Electron + 34 Chromium cases; 38 Swift geometry checks and the Foundation transport suspension/credit probe passed |

The broader browser run and the final integrated run overlap; their counts are
not additive. Baseline mobile/native inputs remained unchanged by these repairs.
The native TLS fixture loads the current working-tree Hub. Physical-device and
signed production-package claims remain outside these results.

The initial full-unit attempt used a Homebrew Node binary with an external
`libnode` dependency; the runtime-freezing guard correctly refused it. That attempt
was stopped and does not count as a passing suite. The final run uses an official
Node distribution and an isolated physical temporary root.

## Evidence boundaries and follow-up

- Browser regressions use Chromium on the developer Mac. WebKit remains restricted
  to disposable hosted runners; no personal keychain access was authorized or reset.
- Attachment deletion is not a remote wipe of previously downloaded copies. The
  late-write guard covers the connection performing deletion; another window's
  already-running download or another device's local copy is not globally revoked.
- The native iOS transport probe uses macOS Foundation and synthetic suspension;
  it does not certify real iPhone foreground reconnection or keyboard geometry.
- Windows clipboard formats, native window resizing, physical screen control and
  network latency still require installed-device acceptance. Synthetic input tests
  send no real OS input.
- Model discovery tests use CLI protocol fixtures and do not start real model turns.
  Actual CLI cold-start timing and rare background-task frame ordering remain
  separate acceptance topics.
- Updater source review is not signed-package, installation, rollback or public API
  rate-limit acceptance. No release artifact was built or uploaded by this audit.
- Hypotheses about private-fork update settings, trimmed-ICU runtimes and unusual
  engine frame ordering were not counted as confirmed bugs or used to justify
  speculative production changes.
