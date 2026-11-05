# Extension access and network interception — 2026-11-03

## Observed cause

The installed 1.0.126 extension manager was inspected through the native App UI:
AdBlock 6.51.0 was enabled but restricted to the personal browser, while
compatibility mode was active in the current conversation browser. Read-only
registry checks also showed personal-browser compatibility mode was off. No
extension permissions or compatibility settings were changed during diagnosis.

These are independent choices. Compatibility mode in a conversation does not
allow a personal-only extension to run there. In an allowed scope, AdBlock can
hide page elements with default isolation, while its network interception needs
that same scope's compatibility mode. Existing pages also need reloading after
an extension is installed, enabled or newly allowed in their scope.

The current manager's global “Enabled” label concealed this distinction, and
its feature details incorrectly said “Needs compatibility mode” when the actual
missing condition was browser access. This is a presentation defect, not
proof that the extension runtime never works.

## Changes

- A personal-only extension viewed from a conversation now says “Not allowed in
  this browser” and explains the existing Runs in choice and native confirmation.
- Network-rule details prioritize disabled status and missing browser access
  before compatibility mode.
- Compatibility mode with no enabled extension allowed in the current browser
  has an explicit notice. An allowed network extension with mode off/inactive
  has a separate network-blocking explanation.
- Accepted enable/scope changes remind the person to reload affected webpages.
- No automatic access widening, compatibility change, native API or policy
  modification. This is device-local UI; headless CLI does not manage these
  extension settings.

## Actual Electron comparison

A fresh isolated Electron 45.1.0 profile loaded the unmodified store-signed
AdBlock 6.51.0 CRX. Synthetic native confirmations were confined to the test
profile. A controlled HTTP fixture and process-local DNS mapping served three
known filter-matching resources and a normal control script. No owner profile,
site login or installed App was used for this comparison.

| Conversation state | Three ad resources reach fixture | Ad element hidden | Control script loads |
| --- | --- | --- | --- |
| No extension | 3/3 | No | Yes |
| Personal-only extension; conversation mode off | 3/3 | No | Yes |
| Personal-only extension; conversation mode on | 3/3 | No | Yes |
| Explicit fixture authorization for conversation; mode on; page reloaded | 0/3 | Yes | Yes |
| Extension remains allowed; mode turned off | 3/3 | Yes | Yes |

Evidence: `taro-tmp.noindex/extension-effective-scope-20261103/native-scope.noindex/result.json`,
`native-matrix.json` and `scope-adblock-smoke.mjs`. The underlying extension emitted
one remote-configuration error during the run; it did not prevent the tested
fixture blocking. This does not establish blocking on every website or video ad.
AdBlock's own allowlists, Acceptable Ads setting and unsupported browser APIs
can affect individual sites.

## Verification boundary

Opus 5.5 independently reviewed the finding and final UI diff, with no blocking
findings. Client production build and **9/9 Chromium browser regressions** passed. They cover access vs
compatibility, declined native scope confirmation, accepted changes and refresh
feedback, without implicit permission mutations. The final results are in
`ui-tests.log` in the evidence directory.

No release or local installation is included. Changing the owner's extension
from personal-only to conversation access remains subject to their explicit
confirmation. The reported website has not yet been supplied, so this is not
site-specific or installed-App ad-blocking acceptance.
