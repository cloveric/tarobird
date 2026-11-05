# Browser extension settings — 2026-11-02

The extension manager previously supported installing, enabling, reloading and
removing extensions, but did not open an extension's own settings page. This was
a missing feature; compatibility mode did not supply it.

The manager now provides **Settings** for an installed extension with a valid
`options_ui.page` or `options_page`. Settings use the current browser's exact
session, including its extension storage and background worker. For a
personal-only extension viewed from a conversation's manager, an explicitly
labelled **Personal browser settings** button opens that scope without changing
the extension's allowed locations. Disabled extensions, older native versions
and packages without a usable settings page have an explanation.

## Native ownership and isolation

`workbench_browser_extensions` gains a trusted user `options` command containing
the installed extension ID and exact browser scope. It is not a Bot/Hub/headless
CLI browser action. Arbitrary URLs cannot be supplied by the UI. The page path is
read from the installed package, validated and resolved within that package.
Existing registries gain the derived availability field without migration.

The page uses a separate sandboxed native window in the extension's session. It
has no App preload, Node access or App bridge. Its main document stays within
that extension's origin; website links use managed pages in the same scope.
Permission requests and downloads from the settings window are denied by the
existing session policy. Opening settings does not enable compatibility mode
or give the extension access to more conversations. Windows are bounded and
reused per extension and scope. Removal, disabling, reload, scope removal,
profile reset and parent-window closure end the corresponding settings pages.

This adds manifest-declared settings pages, not a Chrome toolbar or extension
popup. Extension-specific APIs remain limited by Electron; third-party settings
pages are not automatically guaranteed to work. Export/download controls from
such pages are not enabled by this change.

## Cold-start finding

An isolated real Electron run with the store-signed AdBlock 6.51.0 reproduced a
blank options page when opened immediately after installation: `getSettings`
returned no configuration before its background worker was ready. A delayed
control rendered the full page. Explicitly starting the worker initially failed
while Chromium was still registering it; bounded retries succeeded after 761 ms
in the measured control, after which the page rendered without JavaScript errors.
No AdBlock package code or real user profile was changed by these probes.

The final opening flow starts an MV3 worker with bounded retries before loading
its options page. The queue remains available while waiting, and scope, enabled
state and requesting-window ownership are checked again before creating it.
Worker startup and page-load failures have distinct retry guidance. A crashed
page is closed so a new request can reopen it. A closing window remains tracked
until both the window and its contents are confirmed gone: a timed-out close
cannot be bypassed by retrying the compatibility switch.

## Verification

Evidence is under `taro-tmp.noindex/extension-options-20261102`.

- UI regression: **8/8 Chromium cases**, covering the existing install/compatibility
  controls and the new personal/conversation settings actions, disabled extensions,
  missing settings pages and explicit personal-scope fallback.
- Root and client production builds passed. Existing chunk-size and mixed static /
  dynamic import warnings remain.
- Opus 5.5 independently implemented and reviewed the native path; final focused
  native suites passed **52/52**, also independently rerun by root on the frozen
  source (`root-native-focused-final.log`). Source hashes are in
  `opus-files.sha256`; the earlier full Electron run passed **339/339** before
  the final close/crash refinements and is not counted as a final full-suite run.
- A real Electron 45.1.0 probe of the production command with unmodified,
  store-signed **AdBlock 6.51.0** passed **23 checks** (`native-final-2.noindex/result.json`):
  cold opening, rendered options, a UI setting changed and read back from the
  extension worker, persistence after close/reopen, personal/conversation storage
  isolation, no App-session loading, deduplication and disable/remove closure.
  That cold open took 1,493 ms; this is one local measurement, not a latency promise.
- The original cold-opening failure is retained in `native-1.noindex/result.json`.
  Intermediate harness runs were corrected to wait for AdBlock's change
  listeners and Electron's asynchronous window **and web contents** destruction; those failures do
  not establish an application regression.

The native probes use isolated profiles, hidden real BrowserWindows, fixture
native confirmations and programmatic clicks. They do not validate physical
input, a packaged/installed TaroBot build or Windows. The owner's installed
extensions and profile were not modified. No release or installation is included
in this feature change.

## Compatibility limits

- This opens manifest-declared options in a separate window, including extensions
  that declare `open_in_tab`. Toolbar popups and full Chrome API parity remain
  outside this change.
- AdBlock's general options and persistence were exercised. Custom-filter,
  subscription, account and theme workflows were not accepted as complete.
  Settings exports/downloads remain blocked by the existing session policy.
- Web links require a live managed webpage in the same scope; without one the
  existing extension link bridge cannot open a target.
- Default network isolation remains enabled. In the separately confirmed,
  optional compatibility mode, both extension background scripts **and settings
  pages** can reach local/LAN services; the manager and native confirmation now
  state both. Opening settings itself never enables compatibility mode.

## References

- [Chrome options pages](https://developer.chrome.com/docs/extensions/develop/ui/options-page)
- [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)
- [Existing extension installation and compatibility scope](browser-extensions-2026-11-01.md)
