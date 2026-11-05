# Gateway test isolation

The October 11 review correctly found that only a few Gateway cases explicitly
rejected Feishu calls. A thrown error alone was also insufficient: a runtime
fallback could catch it and leave the test green.

## Enforcement

`tests/setup-gateway-guard.ts`, registered in the root Vitest configuration,
automatically guards every `tests/gateway-*.test.ts` file before its imports.
The real Feishu SDK's exported functions, constructors and nested HTTP methods
are replaced with throwing stubs. Ordinary Lark suites remain separate.

`tests/helpers/gateway-no-feishu.cjs` rejects child-process creation by default:
`spawn`, `execFile`, their synchronous variants, shell commands, `exec`, `fork`
and direct `ChildProcess.spawn`. This covers an absolute CLI path and a CLI
wrapped in Node or a shell without relying on executable-name matching.

The allowlist contains only the two existing crash/restart Node fixtures with
the exact guard preload, TS loader and inherited report, plus the installed
esbuild compiler service with its fixed service arguments. Both fixture children
preload the same guard before application imports, retaining real IPC and
SIGKILL/restart coverage. No model CLI or Feishu CLI is allowed.

Before throwing, the guard appends a synchronous receipt containing only the
violation kind and process ID to a private, per-suite temporary file. Assertions
after each case and after the suite reject any receipt, including one written
by a child or hidden by application error handling. Teardown restores the
intercepted functions/environment and removes only that suite's temporary data.
Arguments, SDK options, tokens and URLs never enter the receipt.

## Regression evidence

- Every Gateway suite ran with the global guard. The first run caught the voice
  fixture's shell-based Tingwu stand-in; its spawn failure was caught by the
  local-ASR fallback. That Gateway fixture now stubs the cloud transcription
  boundary while still asserting duration routing, caption/original-file
  preservation, cancellation signal and the explicit local override. The
  separate `asr-cloud-routing` suite retains its real disposable subprocess
  coverage; production ASR behavior did not change.
- CommonJS and native ESM canaries each attempt nine subprocess paths and five
  SDK paths, deliberately catching every error. All attempts are rejected and
  recorded. A positive control proves the disposable fake CLI can create its
  marker without the guard; the guarded run leaves no marker.
- A nested Vitest run collects a deliberately faulty Gateway fixture. Although
  the fixture catches both SDK and subprocess errors and its own assertion
  passes, the global hooks fail the run with both violation receipts. The main
  self-test requires that failure. The faulty `.case.ts` file is collected only
  by its dedicated canary configuration.
- Focused Node 24 run: **18 files / 155 tests passed**, including all Gateway
  files, the isolation canaries and cloud-ASR routing. Root/standalone-relay
  TypeScript build passed.
- The full pre-completion hook passed the build and **251 files / 3,918 tests**,
  with one existing explicit skip. Ordinary Lark/Telegram and cloud-ASR suites
  ran alongside the guarded Gateway files.

This is a regression guard against accidental test side effects, not an OS
sandbox for hostile test code or a blanket network firewall. Loopback Hub
integration remains available. It does not certify production fleet behavior,
public relay deployment, a live provider or a physical phone. No production
service was restarted or contacted for this change.
