# PR #105 integration review

PR: <https://github.com/cloveric/tarobot/pull/105>

Reviewed PR head `e8d66e679ca9d566bf78ed6684c79b1aeb053539` against
`main` at `75334c2fa599f25b3624d1bcdd4813b4544d0fa9`. The change preserves
the selected completion motion: one live cheer, then two small hops every
2.4 seconds while unread. Reloaded rows skip the cheer. Reading the reply
stops the animation; the device-local animated-avatar setting still applies.

## Confirmed findings and fixes

1. **Live rows could hop in unison.** A negative delay based on reply time
   cancels the stagger in animation start times. An actual React/CSS browser
   reproduction completed one row, then five more together. Despite different
   reply times, the measured cycle progress was approximately 0.6146 versus
   0.6129; the five simultaneous rows were identical. Use a stable per-row
   React identity to derive the offset instead. No per-frame JavaScript,
   polling, or additional timer is introduced. The regression failed before
   this fix and passed afterward.
2. **The source CI job was missing prerequisites.** The PR's failed run
   `41260023308` could not resolve TypeScript-backed imports in Electron tests,
   and the Windows installer planning test lacked the pinned NSIS plugin.
   Both failures reproduce on unchanged `main`; they are not avatar regressions
   or an unavailable GitHub billing quota. The workflow now uses `--import tsx`
   and the existing `setup-nsis` command with an isolated plugin directory.
   The setup command verifies the pinned plugin checksum; no integrity check
   or test is bypassed.

The added browser fixture mounts the actual `AgentAvatar` component and CSS,
exercises staggered and simultaneous completions, and reads real animation
progress. Existing Hub-backed cases cover working/failed/pending precedence,
read receipts, reload, settings off/on, and desktop/iOS/Android layouts.

## Validation

- Avatar state/face unit tests: 11 passed in 2 files.
- Electron bridge and packaging regressions with the corrected prerequisites:
  313 passed, 0 skipped, including the local NSIS compilation fixture.
- Client translation check, TypeScript check and production build passed;
  the standalone Host build also passed.
- Chromium avatar regressions: 8 passed (3.0 minutes).
- WebKit avatar regressions: 8 passed (2.5 minutes).

Local evidence is retained under
`/Volumes/gdrive/taro-tmp.noindex/pr105-review-20261101/`, including the
negative phase trace, corrected phase run, baseline CI failure and corrected
Electron suite logs.

This is presentation-only; Host protocol, model adapters and headless CLI
behavior are unchanged, so no new CLI command is applicable. Browser layouts
are not physical phone acceptance, and installer fixtures are not a Windows
installation test. This merge does not publish a release or replace any
installed App. GitHub checks on the final pushed commit must be reported
separately from local validation.
