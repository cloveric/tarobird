# Browser extensions and Google sign-in fallback — 2026-11-01

The person can add Chrome extensions to TaroBot's managed web pages and manage
them from **Page tools → Extensions**. Google's explicit rejection of sign-in in
the built-in browser now offers a click-to-continue in the system browser. No
release or installed-App replacement is part of this change.

## Installation guidance clarification — 2026-11-02

The manager now explains the installation path immediately above its URL/ID
field: copy the extension's Chrome Web Store address, paste it into TaroBot,
choose **Add from Web Store**, then review and confirm permissions. The store
page's own **Add to Chrome** button is unavailable inside TaroBot.

The compatibility section separately states that installation does not require
compatibility mode. The mode enables installed extensions' network rules and
does not activate the store's button. The existing local/LAN access notice and
native confirmation remain in place. Chinese and English copy are updated;
installation and permission behavior are unchanged. This is desktop UI guidance
with no headless CLI change.

Validation: client and root builds passed; three existing Chromium cases passed
(conversation scope, personal scope, store installation with compatibility off
and removal confirmation). The rendered conversation-scope dialog was visually
checked. These tests use a native bridge fixture, not a fresh real-store install.
This guidance is not included in the already frozen 1.0.127 artifacts.

The later [extension settings change](browser-extension-options-2026-11-02.md)
adds manifest-declared options pages. The original acceptance results below
predate that change; toolbar popups remain outside its scope.

## What Electron 45 provides, and what TaroBot adds

Electron 45.1.0 (Chromium 156) loads **unpacked** extensions per persistent
session (`session.extensions.loadExtension`), forgets them on exit, and
implements a subset of the extension APIs
([Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)).
It cannot load `.crx` files and has no Chrome Web Store install pipeline, so the
store's **Add to Chrome** button does not work inside TaroBot pages. Native probes
showed content scripts, `runtime` messaging, `storage.local`, `scripting`,
declarativeNetRequest and blocking `webRequest` working. Missing were
`webNavigation`, `contextMenus`, most of `action`, `tabs.create`/`getCurrent` and
`windows`. Tab events are defined but never dispatched.

TaroBot therefore:

- installs from a **Chrome Web Store address/ID**, a local **.crx/.zip** or an
  **unpacked folder**. Store downloads come from Google's update service and must
  carry a valid developer signature, the store publisher proof and the expected
  ID (`crx3.mjs`). Local CRX files must carry a valid developer signature.
- stages an immutable App-owned copy (`extension-archive.mjs`). ZIP names, case/NFC
  and file/directory collisions, Windows-invalid names, links, encryption and sizes
  are checked before anything is inflated. The limits are 128 MiB per package,
  512 MiB unpacked, 32 MiB per file and 20,000 files. Folders are copied without
  following links. The person reviews that copy's normalized manifest in a native
  dialog before it is committed. File/registry commit failures restore the previous
  package; native load failures remain visible for retry or removal.
- keeps a registry, attaches extensions to each page session when it is created,
  and offers enable/disable, reload and removal. A reset voids pending installs.
  Loads are bounded; a late load is reconciled.
- supplies the missing APIs through `extension-bridge.mjs`. This is a
  session service-worker preload that installs its API additions only in extension
  workers, on both `chrome` and Chromium's separate `browser` namespace. Main answers from
  its own records of managed pages in that extension's session:
  - `webNavigation` events, `getFrame` and `getAllFrames`
  - real tab created/updated/activated/removed events
  - `contextMenus`, shown in the page's right-click menu
  - `action` state
  - `tabs.create`, which opens a web page in the same scope
  - `windows`

  Tab URLs and titles follow Chrome's rule: `tabs` permission or a matching host
  permission. This is a bounded bridge, not Chrome API parity. TaroBot shows no
  toolbar button and renders no extension popup or options pages.
- reports each extension's declared features as supported / needs compatibility
  mode / not available. This is a manifest review, not proof of execution.

## Scope, authority and compatibility mode

- Extensions run in the **personal browser** by default. Conversation webpages
  need a per-extension native confirmation, because Bots read and operate those
  pages. Extensions never load into the App session.
- `workbench_browser_extensions` is a trusted desktop command, separate from the
  `workbench_browser` action contract. Bots, the Hub, Gateway tools and the CLI
  cannot invoke extension management or the native API bridge. The headless CLI is not applicable
  to these device-local browser preferences. Extensions can still change pages a
  Bot later reads in a scope where they run.
- TaroBot's request filter blocks public-page subrequests to loopback services,
  including the local Host. It is not a general LAN/DNS firewall. Electron gives any `session.webRequest` listener precedence over every
  extension's `webRequest` and declarativeNetRequest handling. In default mode,
  ad and request blocking rules therefore do not take effect; element hiding does.
- **Compatibility mode** (opt-in, default off, per exact page scope) removes that
  filter for one scope after a private policy extension's declarative rules
  report ready (a nonce through the filter) and the scope's existing page
  documents have been closed. Tabs retain their identity and visible pages
  reload under the policy; an already committed document cannot safely retain
  its old network configuration. Those rules keep blocking page requests to
  loopback. Pages used by a Bot, downloads, media, page tools, fullscreen or
  user takeover refuse the switch. Possibly unsaved input is listed for an
  explicit reload decision; cancellation or a changed page keeps the input.
  The native confirmation states the cost: the person's
  extensions' background scripts can reach this computer and the LAN, including
  the Host. Turning it off restores the filter first, then restarts that scope's
  extensions. A Host removal or full reset ends it, and so does a policy that
  never reports ready. Saving the preference unsuccessfully also restores the
  default filter. A failed activation is not retried on every page sync; the
  person can retry explicitly or the next App run can try once. Clearing
  website data checks that the policy remains loaded without removing and
  reinstalling it under live pages; a missing policy restores default protection.
  Unload probes in compatible scopes use a private held-response scheme instead
  of the filter.
- Full local reset removes installed extensions with the personal profile; a Host
  removal keeps the installed packages but unloads them from that Host's sessions
  and removes those session mappings, so later extension changes cannot revive
  the removed Host. Explicitly attaching a re-added scope loads them normally.
- An update describes its actual inherited scope and enabled state. Replacing a
  verified package with a less verified package under the same ID requires a
  separate confirmation explaining signature loss and inherited data. Changes
  to the reviewed installation while the dialog is open cancel the pending
  install, preserving the newer choice/version or removal. See the
  [post-release audit and native evidence](post-1.0.123-audit-2026-11-01.md).

## YouTube captions compatibility — 2026-11-13

In default mode, the page session now retains its actual Electron version in
the User-Agent sent only to `https://www.youtube.com/api/jnn/*`. Removing that
engine token produced intermittent empty caption responses in isolated tests,
even with CC selected. The App token stays removed; the page and all other
requests keep the existing User-Agent. No browser permissions, cookies or
credentials are changed.

This correction is disabled together with the native filter in **extension
compatibility mode**, so it cannot override installed extensions' network
rules. Caption failures in that mode remain possible. A full page reload
recovered the isolated failing cases; toggling CC alone did not. This is a
workaround, not a guarantee or a request to change the user's extension setup.

Verification includes isolated Mac Electron playback of the affected lecture,
with ad and main-video captions distinguished, and browser policy regressions.
Windows installed-App playback and signed-in sessions remain unverified. No
release or installation accompanies this source change.

## Google sign-in

Google may refuse sign-in from browsers embedded in other applications
([Google Account Help](https://support.google.com/accounts/answer/7675428)). TaroBot
does not change how its pages identify themselves to get around this. On
Google's explicit `accounts.google.com/…/signin/rejected` page, the browser shows
a notice with **Continue in system browser**. The continue target must be an
https Google page without credentials, otherwise the account page is used. A
sign-in there does not sync back into the TaroBot page.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/browser-ui-followups-20261101`
(`opus-evidence/`, root `root-regression/`).

- Electron unit/contract suite **303/303**, including `browser-extensions.test.mjs`
  and `extension-bridge.test.mjs`. Root's independent manager, compatibility and
  bridge negatives **8/8** pass (`root-regression/final8.log`). The load-timeout
  fixture was updated for the worker bridge and asserts that the unresolved native
  loader was actually called; the earlier mock-only early return is not timeout evidence. The existing native browser smoke passes **26/26**.
- Real AdBlock 6.51 (store-signed CRX, verified) ran in an isolated Electron 45.1.0
  profile through the production manager and bridge (`adblock-run-4.noindex`).
  Requests were counted at a local fixture server:

  | Phase | Ad requests | `###ad_banner` | Worker |
  |---|---|---|---|
  | No extension | all load | visible | — |
  | Installed, default mode | all load | hidden | running; 3 rulesets enabled |
  | Compatibility mode on | first-party `/ad_728.js`, third-party `0019x.com` and `/ads/banners/` image all blocked; control script loads | hidden | running |
  | Compatibility mode off | all load again | hidden | running |

  AdBlock's own context menu items appear. Its worker logged
  `[ipm]: No remote configuration`; the measured blocking and hiding still passed.
  Root additionally verified disable and removal: the worker stops, the registry
  entry is removed, and subsequent navigation has neither cosmetic injection nor
  request blocking (`root-regression/adblock-lifecycle-run.noindex/result.json`).
  This does not claim previously changed DOM is immediately restored without reload.
- The compatibility native check (defaults, scope, page→loopback blocked,
  unload probe keeps the page, off restores) passed 6/6 on the final code.
- The extension manager and page tools pass **16/16 Chromium UI checks**, including
  exact conversation/personal scope, opt-in cancellation, failed install retry, old
  native versions, permission presentation, removal confirmation, narrow layout and
  Google rejection handling. Client translations/TypeScript/Vite build and an
  Electron main bundle using production bundling options plus `node --check` pass.
  These are source verification, not a distributable App build.
- Not covered: AdBlock's popup/options UI (TaroBot renders no extension pages),
  physical UI, a packaged or installed App, Windows, and the owner's profile.
  Dialog answers in native runs are fixture decisions.

## Implementation references

The worker bridge uses Electron's [service-worker preload and IPC APIs](https://www.electronjs.org/docs/latest/api/service-workers), following the approach of
[the MIT electron-chrome-extensions project](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions).
Chrome extensions remain user-installed third-party packages: none, including
AdBlock, is committed or bundled with TaroBot. Compatibility is limited to the
APIs and fixture behavior above; other extensions and real sites need their own checks.
