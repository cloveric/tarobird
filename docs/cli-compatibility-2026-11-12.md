# AGY, DeepSeek Harness and Kimi compatibility

This change updates Host adapters shared by the desktop App, mobile App and
standalone CLI. It does not install or upgrade the owner's engines, change
permission defaults, publish a release or replace a transport.

## Antigravity 1.5.6

The JSON `finished_reason` field introduced in
[1.4.11](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.4.11)
now takes precedence over `status` and an earlier DONE assistant step in both
the persistent stream and native-goal paths. `print_timeout`, `interrupted`,
`error`, and unknown nonempty reasons cannot produce a successful result.
Partial streamed text remains visible, but the turn is classified incomplete
and not eligible for blind replay. Diagnostic stderr preserves that error type.
Authentication/quota errors before any answer or tool work retain their existing handling.
Older results without the field retain the verified stale-status workaround.

The native `/btw` feature exists, including tool support in
[1.5.0](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.0).
The installed 1.5.6 print command explicitly rejected `/btw` with zero model
turns/tokens. Its ACP handshake did not advertise fork; `session/fork` and
`session/btw` returned method-not-found. This does not prove every upstream
interface lacks a side-query facility, but no supported native branch API for
our transport was verified. No side button or fake context-free fork is enabled.
Supporting it remains pending a verified programmatic interface or a separately
reviewed transport change. Literal `/btw` model text is not a native side query.

### Follow-up audit

The follow-up found two AGY replay hazards. First, a tool-only turn could fail
before emitting assistant prose and be returned as a generic, retryable error.
Tool activity is now tracked independently of response text and display IDs in
both execution paths. Second, diagnostic stderr could match the older startup
authentication or unsupported-flag recovery rules even after an incomplete
turn. Those rules now refuse typed incomplete errors. Genuine startup recovery
remains covered by the existing tests.

Eight new negative regressions reproduced these issues before their fixes:
six tool-only cases and two cases that started a second worker from misleading
diagnostics. A real AGY 1.5.6 single-turn smoke check also returned the expected
answer with `status: SUCCESS` and no `finished_reason`, confirming the native
success shape. This smoke check is distinct from adapter tests and does not
establish installed-App acceptance.

An independent DeepSeek review reproduced both findings against the original
commit and identified a third, pre-existing adjacent case: a native SUCCESS
receipt after tool execution with no answer text was also classified retryable.
The primary review reproduced it in both execution paths before fixing it.
It still fails the existing empty-answer contract, but now fails as incomplete
before publishing a successful result event. No retry is suggested for work
whose tool effects may already have occurred.

The review's broader suggestions were assessed separately. A tool reported as
ACTIVE can already have side effects, so it still blocks blind replay; requiring
DONE would weaken this protection. Potential future Kimi error-message variants,
unknown future AGY finish values and additional DSH lifecycle test combinations
are not treated as confirmed defects or reasons to rewrite the transports.
Failed-turn usage accounting and real native unload-during-registration remain
separate validation questions; this pass makes no new acceptance claim for them.

The final regression set adds ten negative cases to the previous 658 tests:
all 668 tests in 17 files passed, along with the Host build. TypeScript retains
the same 178 baseline diagnostics with no additions. No engine upgrade,
release or installed-App update is included.

## DeepSeek Harness 0.2.2 release candidates

The App plugin now awaits `sessionProjections.register()` before publishing
hooks or accepting private-pipe requests. It uses the returned handle's async
`dispose()` and retains compatibility with older synchronous disposers.
The rc.1 callable-thenable compatibility object is awaited, not mistaken for an
already-ready legacy handle. Registration rejection closes the inherited pipes;
context unload or pipe loss during registration disposes a late handle without
recreating consumers. Disposal is idempotent. After successful startup, losing
only the delivery pipe still retains usage accounting until plugin disposal.

Real rc.1 and an isolated rc.2 installation both passed Host startup, native
session creation and native App-tool registration using empty synthetic accounts.
The rc.2 installation did not replace the installed rc.1 engine. These checks
prove startup/plugin compatibility, not real-model execution, AgentTeam support
or a full certification of every rc.2 feature. Existing stop/steer, permission,
native tool origin, goals/usage and protocol tests remain in the regression set.

## Kimi Code 2.5.3

A fresh engine home returned ACP `Authentication required` for `session/new`.
The adapter now preserves Kimi identity for a localized instruction to run
`kimi login` on the Bot's Host. It neither executes commands from terminal-auth
metadata nor starts account login automatically. Quota errors that include
authentication wording remain quota errors.

Real-model checks passed initial reply, cancellation during streamed output,
and a subsequent prompt recalling a synthetic marker in the retained session.
The adapter omits `response.sessionId` when the native binding is unchanged;
the probe was corrected to respect this contract rather than treating omission
as a new session. No physical-phone or Windows runtime acceptance is claimed.

The 2.5.3 ACP handshake and official server source expose no steering method;
an actual `session/steer` request returned JSON-RPC -32601. The new HTTP steering
endpoint is a different interface. Kimi keeps the existing queued-message
behavior; no steering capability is advertised or simulated using cancellation
and a replacement prompt. The Windows stdio MCP fix is upstream-owned and was
not separately exercised on Windows in this check.

## Verification and remaining boundaries

- Before the fixes, 12 targeted AGY/DSH regressions failed; DSH also produced an
  unhandled registration rejection. Two Kimi login-guidance regressions failed.
- All 658 tests in 17 focused files passed. The set includes the three adapters, private App tools and async
  lifecycle, error rendering, DeepSeek protocol/Host/usage, Kimi hooks/workspace/
  side sessions, shared steering and Bridge reply/retry/side-session behavior.
- Host build passes. Root TypeScript checking retains 178 pre-existing
  diagnostics; normalized file/message diagnostics match the recorded baseline,
  with none added in the changed code. This is not a clean whole-project typecheck.
- Raw native frames, runtime logs and probe corrections stay outside the public
  repository. Initial DSH probe failures were fixture mistakes (a missing
  keepalive and synthetic credential-file mode); they were corrected before
  the successful rc.1/rc.2 checks and are not treated as product defects.
- Source tests and native CLI probes do not establish installed-App, physical
  iOS/Android, or Windows acceptance. No release was requested in this change.

Regression files: `antigravity-adapter`, `deepseek-app-tools`,
`deepseek-plugin-lifecycle`, `deepseek-goal-usage`, `deepseek-harness-host`,
`deepseek-harness-protocol`, `deepseek-harness-adapter`, `kimi-acp-adapter`,
`kimi-side-session`, `kimi-hook-relay`, `kimi-workspace`, `error-classification`,
`core-steer`, `core-side-sessions`, `bridge`, `bridge-retry`, `bridge-side-sessions`.
