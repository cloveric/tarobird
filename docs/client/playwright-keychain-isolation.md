# WebKit test keychain isolation

macOS Playwright WebKit can request access to **Playwright WebCrypto Master Key**
when a page persists a `CryptoKey` in IndexedDB. A temporary browser profile,
headless mode or closing the page does not isolate the macOS login keychain.
Starting new workers after timeouts can therefore produce repeated system
permission dialogs. This is a test-browser issue, separate from the installed
App's native device identity and its keychain permissions.

An existing entry can trust an older WebKit binary's ad-hoc signature. After a
browser upgrade, the replacement signature may no longer match that ACL.
Approving a request after its test process has exited may not retain access for
the next process, so repeatedly clicking Allow is not a reliable test fix.

The [upstream report](https://github.com/microsoft/playwright/issues/20850)
describes this dialog and stalled tests. Its closure did not establish a fix.
The checked Playwright WebKit launcher does not expose Chromium's
`--use-mock-keychain` option; do not add unsupported Chromium flags to WebKit.

## Test entrypoints

The owner authorized Playwright WebKit on the development Mac on November 13,
2026. Local WebKit runs no longer require a disposable-runner opt-in.

`client/playwright.config.ts` keeps `playwright-keychain-guard.mjs` as global
setup, but it now prints a reminder instead of rejecting the run. The WebKit
config and CLI `--browser=webkit` / `--browser=all` continue into workers on
macOS. Chromium/Firefox-only and non-Mac runs remain quiet. Mixed configurations
emit at most one reminder. No environment variable or fabricated CI identity
is needed to permit local WebKit.

- Run the relevant WebKit checks locally with
  `npx playwright test --config=playwright.webkit.config.ts <spec>` from `client`.
  Hosted macOS browser jobs remain available for broader coverage.
- Specs select viewport and touch behavior; project configuration owns browser
  choice so the CLI-selected engine is respected. The base config selects Chromium.
- Standalone probes may call `warnWebKitTestEnvironment`; the existing
  `assertWebKitTestEnvironment` export is retained as a warning-only alias.
- A permission prompt is still possible. The reminder does not authorize or
  perform any keychain permission changes. Record a stalled or interrupted run
  as incomplete, preserve its evidence and diagnose the actual test/browser.
  Do not alter keychain entries or ACLs as an automatic test workaround.

## Verification boundary

`node --test client/scripts/playwright-keychain-guard.test.mjs` checks warning
selection, the legacy export, project browser selection, both configs and CLI
browser options. Its real CLI probes use no browser fixture: they prove that
workers run despite the reminder, without opening a browser or keychain prompt.
Actual WebKit journeys are separate evidence.

This policy change permits local WebKit tests; it does not fix upstream WebKit,
prevent system permission prompts or certify a particular run. Production
WebCrypto, private-key extractability, IndexedDB, native keychain behavior and
App/Host/CLI protocols are unchanged. No App installation is needed.
