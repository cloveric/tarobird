# WebKit test keychain isolation

macOS Playwright WebKit can request access to **Playwright WebCrypto Master Key**
when a page persists a `CryptoKey` in IndexedDB. A temporary browser profile,
headless mode or closing the page does not isolate the macOS login keychain.
Starting new workers after timeouts can therefore produce repeated system
permission dialogs. This is a test-browser issue, separate from the installed
App's native device identity and its keychain permissions.

The [upstream report](https://github.com/microsoft/playwright/issues/20850)
describes this dialog and stalled tests. Its closure did not establish a fix.
The checked Playwright WebKit launcher does not expose Chromium's
`--use-mock-keychain` option; do not add unsupported Chromium flags to WebKit.

## Test entrypoints

`client/playwright.config.ts` installs `playwright-keychain-guard.mjs` as global
setup. On macOS, a resolved WebKit project fails **before any worker starts**
unless `TAROBIRD_TEST_DISPOSABLE_MAC=1` explicitly declares a disposable test
machine. The WebKit config and CLI `--browser=webkit` / `--browser=all` use the
same guard. A mixed config is conservatively blocked if it contains WebKit,
even when the invocation selects another project. Use the Chromium base config
for local work. Listing tests does not launch browsers and remains available.

- Run Chromium checks normally on the developer's Mac.
- Keep full WebKit journeys on the disposable hosted macOS browser jobs in
  `.github/workflows/client.yml`. Those jobs set the opt-in explicitly. Linux
  WebKit remains available, but does not substitute for macOS media coverage.
- Never set the opt-in on the owner's everyday desktop, infer it from `CI=1`,
  or add it to a shell profile to bypass the guard. It is a runner declaration,
  not a mechanism that isolates an existing keychain.
- Specs select viewport and touch behavior, but leave browser choice to the
  project config. The phone slide journey now runs with the selected engine;
  it no longer silently starts WebKit in a Chromium suite.
- Standalone browser probes must apply `assertWebKitTestEnvironment` before
  launching WebKit too. Do not launch an ad-hoc unguarded WebKit script on the
  owner's Mac. Test selection and this restriction also apply to agents.

If a prompt occurs, stop the test run and identify its browser process by exact
executable and parent run before closing it. Do not keep rerunning failed tests,
kill shared WebKit services or SecurityAgent, enter the owner's password, grant
permanent access, delete the keychain entry, or reset its ACL as a test fix.

## Verification boundary

`node --test client/scripts/playwright-keychain-guard.test.mjs` checks the OS and
runner policy, spec overrides, both configs and CLI browser selection. Its real
CLI probes use no browser fixtures: a failed guard can only write a marker, so
the regression cannot create the very permission popup it tests against.

This change prevents the known repository test entrypoints from repeatedly
triggering the owner's login keychain. It does not patch upstream WebKit or
claim that arbitrary external Playwright scripts are intercepted. Production
WebCrypto, private-key extractability, IndexedDB, native keychain behavior and
App/Host/CLI protocols are unchanged. No App release or installation is needed.
