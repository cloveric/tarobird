# Voice settings: independent Opus review and repairs

Scope: follow-up to `2607e09` and `1f26ba2`, which are already on main. This
change is delivered as a separate PR. It does not install or release an App,
change the owner's live settings, read credentials, or make paid cloud calls.

## Behavior repaired

- Thresholds are persisted as whole seconds. Decimal minutes such as 500/60
  round-trip without a false unsaved draft or reset to 15 minutes. Only floating
  point noise is normalized; truly fractional seconds remain invalid.
- A policy snapshot is captured before asynchronous adapter inspection and
  checked again afterward and before commit. An external operator replacing
  the file during inspection causes a revision conflict rather than lost data.
- All-cloud errors reach both the progress card and final voice reply in the
  selected language. Empty/missing cloud text and unavailable video audio are
  distinguished from an adapter failure. Original attachments remain available;
  failed cloud-only attachments tell the agent not to re-upload automatically.
- Known video containers upload extracted audio only. Trusted audio attachments
  (including audio/webm microphone recordings) keep their existing path; unknown
  video-like files are stream-probed, with extraction on uncertain results.
  Extraction uses argv, `-nostdin`, no video/subtitle/data or copied metadata,
  a 120-second bound and a 64-MiB output bound. Oversized/failed extraction never
  uploads the original. Private scratch files are removed after success,
  failure, or cancellation. A cleanup failure is best effort, not a guarantee
  against process termination or OS failure. Automatic mode can fall back to
  local ASR; fixed cloud mode cannot. Agent instructions carry the same rule.
- Legacy environment modes are case-insensitive; unknown nonempty values stop
  cloud routing. Hub, CLI status and worker use one parser; doctor and App
  explain invalid legacy modes. No new dependency is introduced.
- Previously approved cloud scope is shown as a state, not a prechecked
  withdrawal control. First managed save, enabling cloud, changing adapter,
  auto-to-cloud, or lowering the automatic threshold requires explicit approval.
  Reducing scope reuses server-confirmed consent. Revocation means choosing
  all-local and saving. The API still requires consent and revision checks.
- Pending saves show the request being retried. Configuration read failures have
  specific non-secret diagnostics. Owners may discard a *local pending receipt*
  without deleting/resetting host settings or pretending to undo a saved change.
  Unmanaged Bot-specific configuration and old workers are explicitly called out.

## Compatibility and recovery

October 28 audit follow-up: MIME/extension and an attachment's `audio` hint are
not sufficient proof of its streams. Original-file cloud upload now requires
`ffprobe` to confirm audio-only streams; uncertain inputs are extracted with
`ffmpeg` before upload. Hosts using cloud ASR must provide these audio tools on
the Host process's PATH. If neither verification nor extraction succeeds,
cloud-only mode reports a local audio-processing error and uploads nothing;
automatic mode retains the configured local fallback. This supersedes the
trusted-audio shortcut described in the original change above.

Existing v1 policies retain their meaning and read as v2. The current capability
remains v2; the new `legacyModeInvalid` response flag is optional. Read failures
return HTTP 503 with `voice_settings_unavailable` or a suffixed reason:
`file`, `permissions`, `oversized`, `format`, `future`, or `unreadable`.
API/CLI authorization, audit and request receipts stay on the same host path.
No new CLI command is needed: `tarobot integrations voice status` / `tarobot integrations voice set` reuse
these fixes. UI-only consent/draft presentation has no additional CLI behavior.

Do not blindly reset a broken policy. First preserve a private copy of the
host's `voice-settings.json`, inspect the diagnostic and any newer host version,
and verify that the expected host is being operated. Restore a known-valid policy
or repair ownership/private permissions only after identifying the cause. Never
follow a symlink or overwrite a newer format. Removing a policy reactivates legacy
Bot/environment routing, so it is **not** a safe way to disable uploads. Managed
workers fail closed to local while their policy cannot be read; unsupported old
workers do not acquire that behavior merely because the App was updated.

Downgrading to a host without policy support ignores this file and can restore
legacy upload behavior. Disable legacy cloud configuration before such a rollback
if upload must remain off. App/API consent is not an OS sandbox: a Bot with full
filesystem access as the same OS user can edit policy/adapter files directly.
File persistence and database audit are separate operations; a durable receipt
allows save reconciliation, but this is not a cross-filesystem/database transaction.

## Opus findings and disposition

Real CC1 session: Claude Opus 5.5 [1m], configured effort xhigh. It independently
reviewed committed source and UI screenshots, then discussed the proposed repairs.
The reviewer did not change files or run paid transcription. Private full reports
are retained in the task evidence, not published with local identifiers.

| Finding | Disposition |
| --- | --- |
| A: cloud failure uses shorter-audio advice | Fixed, including no-text diagnosis and no automatic agent retry |
| B: 500-second floating point draft | Reproduced before fix; whole-second normalization and browser regression |
| C: damaged policy cannot be reset | Specific diagnostics and discard-local-receipt exit fixed; no destructive reset endpoint |
| D: short-video cloud upload includes frames | Audio-only extraction, microphone-kind exemption, metadata stripping and cancellation tests |
| E: unmanaged page implies uniform settings | Clarifies Bot-specific legacy behavior before first managed save |
| F: invalid/capitalized legacy mode | Shared safe parser, doctor/App diagnostics |
| G: adapter filesystem checks may hang | Deferred: no hanging default-home filesystem reproduced; needs shared in-flight detection/concurrency design |
| H: checked consent looks revocable without save | Scope-aware explicit approval and static existing-consent state |
| I: retry payload not visible | Pending mode/threshold is displayed; same request ID retained |
| J: richer effective-state history | Deferred product enhancement |
| K: cloud latency/cost and no-text guidance | No-text guidance fixed; real cost/latency not claimed without cloud verification |
| L: additional local availability warning | Existing local-ASR status retained; no new save gate |
| M: direct adapter setup button | Existing guided setup retained; no new installation flow |
| N: missing legacy path labeled already configured | Renamed compatibility location |
| O: simpler CLI argument defaults | Existing explicit CAS interface retained; no divergent defaults |
| P: old workers retain old routing | Explicit upload warning |
| Q: old-host rollback ignores policy | Documented above |
| R: policy write/audit are not one transaction | Receipt recovery retained; boundary documented above |
| S: stale routing comments | Updated |

Codex also reproduced/fixed the external-file replacement race and allowed a
first managed all-local save without forcing a meaningless setting change. Opus accepted
keeping reset/recovery and filesystem timeout redesign separate. A client request
has a 15-second timeout, but this does not cancel an OS filesystem call on the
server: stalled operations can occupy libuv workers, and repeated requests can
accumulate. This remains a limitation, not a tested failure or a solved problem.

## Codex validation

- Focused routing/settings/Gateway/threshold tests: 86 passed.
- Final Chromium settings suite: 16 passed, including phone and desktop layouts,
  all modes, consent changes, exact threshold preservation, readback/retry,
  initial local adoption (absent and invalid legacy mode), and damaged-policy exit.
- Host build and client build (including translation and TypeScript checks): passed.
- Compiled CLI test invoked status and all three modes against an isolated existing
  Hub; replay retained revisions and only three writes were audited.
- Real local ffmpeg/ffprobe decoded a generated MP4 into one mono 16-kHz audio
  stream. This test actually ran here; machines without the binaries skip it.
- First full regression (before the final five video-container cases): 5,178
  passed, 5 skipped. Final full regression: 5,182 passed, 5 skipped, **1 timed
  out at the unchanged 5-second limit** in `host-cli-entry`. Its 17-test file
  then passed independently with the same timeout and no test/code changes.
  The final parallel run is therefore not described as entirely green.
- Gitleaks 8.30.1 staged scan and whitespace checks: passed.
- WebKit initially lacked its executable. After installing it into the temporary
  task directory, page creation still timed out before any App navigation. No
  WebKit/Safari acceptance is claimed. GitHub CI billing availability is checked
  separately at PR delivery; it is not replaced by the local test counts.
No real user audio was inspected or transcribed. Audio privacy tests use locally
generated synthetic video and fake cloud adapters. Native iOS/Android/Windows,
real cloud credential/billing and production rollout are separate acceptance gates.

## Opus final review

Opus independently ran 66 focused host/Gateway/routing tests and 2 client
threshold tests on the final repair tree. Both sets passed. Its code review
found two P2 gaps: missing video containers in the extraction guard, and the
initial unmanaged all-local save being disabled. Both were repaired. Opus
re-ran its isolated reproduction for `.3gp/.3gpp/.mpeg/.mpg`, observed only the
extracted WAV reach the fake adapter, and confirmed both P2 findings closed.
The shared extension table also applies to the local decoding path.

Three P3 items were handled: the CLI command name, exact-second display in a
pending receipt, and duplicate failure markers. Opus reviewed the rendered
390px/1360px cloud-mode screenshots and found no additional layout issue. It
did not run the browser suite itself; those results are Codex's checks below.
No unresolved disagreement remains. Deferred improvements and environmental
acceptance limits above remain explicit.
