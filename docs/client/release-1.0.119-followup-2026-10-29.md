# 1.0.119 release-gate follow-up

The initial 1.0.119 full hook at `82e49170445af2f9dd00ccc50eceb9185a9db906`
failed: 7,088 tests passed, 19 failed and 5 were skipped. No package was
published or installed from that candidate. Evidence is retained under
`/Volumes/gdrive/taro-tmp/release-1.0.119-20261029`.

## LAN listener allocation

Three real LAN tests failed with `desktop_host_lan_not_listening`. An isolated
Host reproduced the failure outside Vitest. The child TLS listener failed with
`EADDRINUSE`: after the availability probe released its `listen(0)` port,
another local application's outgoing TCP connection acquired that port. Four
of five minimal probes reproduced this collision. No production Host or
unrelated process was restarted to diagnose it.

New non-loopback listeners now choose a random candidate in 20000–32767 and
check the same candidate on every intended interface. This avoids common OS
outgoing ephemeral ranges; it does not eliminate every possible bind race or
override customized OS ranges. Occupied candidates and Windows explicitly
reserved ports are retried, up to 16 times. Unavailable interfaces still fail
immediately. Saved ports and loopback-only allocation remain unchanged.

This is shared Host behavior for the desktop and CLI; no new command or data
migration is required. Opus 5.5 reviewed the candidate and recommended the
Windows error handling and deterministic conflict coverage, both included.
Five allocator tests cover occupied ports, probe release, loopback behavior,
permission errors, unavailable interfaces and bounded retries. The real LAN
conflict test now forces a conflict with the first explicit candidate, so it
continues to exercise retry rather than passing without hitting that path.

## Test fixture and assertion repairs

Five voice-settings failures came from duration-only ffprobe mocks after the
audio-stream privacy guard was added. The fixtures now distinguish stream
JSON from duration output. Production audio privacy checks are unchanged.
Voice-settings, cloud routing and voice review passed all 64 focused tests.

The large mixed-attachment test serialized more than 100 MiB of binary upload
payload into JSON merely to search for an error notice. This exceeded its
five-second timeout even in a serial run. It now examines notice fields,
while retaining actual 125 MiB delivery, artifact-count and success checks.
No timeout was increased and no delivery behavior changed.

The other ten timeout failures passed in a serial retry without source
changes. The first full run had substantial memory and indexing pressure;
that observation is not a reason to waive the release gate. The final frozen
source must pass a fresh full hook before packaging.

Focused final delta: 22 tests passed across the allocator, real desktop Host
and attachment bounds suites. Final full-hook and packaged/install evidence
are recorded separately; this document does not establish release or local
installation completion.

## Browser timing harness follow-up

The release browser gate covered 75 unique scenarios on the frozen application
commit `022868b5baea02bafbb90e8b061e68b79fcf8e3a`. The first WebKit run passed
46 of 47 cases; the normal side-window opening case failed its intermediate
pending-state assertion. Two isolated repeats reproduced the same failure.

Trace timestamps showed that four real `requestAnimationFrame` callbacks took
roughly 750–830 ms in this headless WebKit environment. Three sampling stages
crossed the intended two-second native-window fallback deadline. The panel
then appeared at the right edge of the current window, as designed; final
geometry and close assertions passed. This did not establish a product-side
wrong-edge animation defect.

A copy of the test outside the frozen checkout installed Playwright's clock
only for the normal-opening case and advanced four animation frames explicitly.
The application and two-second fallback were unchanged. All eight side-window
cases passed with that harness; the other seven timeout/fallback scenarios
retained real timers. The remaining Chromium group passed all 28 cases.

The original failure, repeated failures, traces, corrected harness, patch and
all report hashes are preserved in the release evidence. The browser receipt
records the correction explicitly rather than reporting the original 47 cases
as an unchanged pass. The test-only correction is committed with the final
release verification after publishing the frozen application. Browser fixtures
do not establish physical-device or native-window acceptance.

## Android release-helper identity check

The signed APK correctly used `com.tarobot.client`, version 1.0.119 and
versionCode 2026102901, but the reused operational verification helpers still
contained two escaped legacy-ID expectations: the package name and launcher
activity. The first package check therefore failed before publication.

Only those two release-helper assertions were corrected to the authorized new
identity. The frozen source, APK bytes and signature were unchanged. The failed
log and helper copies were retained; package, icons, launcher and combined
Android/iOS asset checks were then rerun against the already signed APK. Passed
builds and model checks were not repeated.
