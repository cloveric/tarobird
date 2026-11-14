# Google sign-in in the desktop browser

Google account pages previously loaded inside the Electron browser, including
authorization popups. Google requires OAuth authorization in an external user
agent, so successful application verification cannot make that embedded flow
supported.

Requests to the exact HTTPS Google Accounts origin now stop before loading
in the managed page and offer a native, cancel-first choice to continue in the
default browser. This covers typed/opened addresses, restored pages, navigation,
redirects and popup links. Subframe attempts are blocked without opening a
browser. Lookalike hosts, credential-bearing URLs and non-default ports do not
qualify for the handoff.

The prompt explains that website sign-in stays in the external browser and that
app authorization completes through the originating application's callback.
No cookies are copied and no embedded Google login success is claimed. Bot
receipts report `needs_user`, with `committed: false` and the external-open
result. Personal browser and conversation browser use the same native behavior.
Queued prompts revalidate the tab, navigation, document generation, visibility,
scope and operation before launching anything. A cancelled or retired action
cannot later open the external browser.

Google's policy: <https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers>.

## Verification

- Electron browser module tests cover direct open, cancel/accept, navigation,
  popup, main-frame redirect, blocked subframes and stale navigation/document
  cancellation, plus the existing isolation and lifecycle regressions.
- Host and client builds, including client type checking and translations.
- These checks do not establish a live Google account login, OAuth approval,
  Windows runtime behavior, or installed-App acceptance. Google account login
  still belongs to the person in their system browser.

CLI impact: no headless browser or Google credential contract changes. Existing
Google Docs authorization still uses its host-local external-browser URL and
PKCE callback. Gmail and Calendar tools and OAuth verification are separate.
This source patch does not publish or install an App release.
