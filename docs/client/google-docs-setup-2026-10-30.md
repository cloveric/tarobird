# Google Docs configuration and export error handling

The installed App's Google Docs export action could report `internal_error`
when no OAuth client was configured. The Hub's callback existed, but opening the
missing client file threw an ordinary error that became HTTP 500. There was no
Google Docs entry in settings. Two related CLI defects prevented reliable setup:
the default directory was the old headless location, and `auth --client-file`
did not retain the client file selection for subsequent App exports.

## Resulting behavior

- Export returns sanitized public error codes for configuration, authorization,
  credential-vault and Google service failures. Desktop inline actions and phone
  message sheets share localized, actionable text. Provider payloads, credential
  contents and private paths are not included in API errors.
- Desktop General settings has a host-scoped Google Docs status button and
  expandable setup guide in Chinese and English. It explains OAuth Desktop app
  JSON and the host-terminal/browser steps. Mobile shows a short instruction to
  complete setup in the host's desktop app; it omits the check button and terminal
  guide. Native iOS/Android keep this behavior at wide widths, while a narrow
  native desktop window retains its desktop controls. Non-owners are directed
  to the host owner. This is not an embedded account-login flow.
- `GET /api/gdocs/status` is owner-only and revalidates the actor after the
  credential-vault wait. It does not call Google. The interface checks only on
  explicit request and discards results after a host/user/role change or unmount.
- `tarobot gdocs configure --client-file FILE` validates and atomically imports
  a private copy under `<host>/gdocs/google-oauth-client.json`. It requires an
  initialized host, preserves unrelated live config, and survives deletion of
  the downloaded original. `auth --client-file` performs the same import.
- Directory selection shares `resolveHostDirectory` with the host CLI, including
  explicit selection, environment selection and the existing identity-conflict
  checks. Legacy client-file config still works until explicitly superseded.
- Stored authorization is structurally validated. It is described as saved,
  not as verified Google access. macOS Keychain and Linux Secret Service remain
  supported; Windows authorization is still unsupported. Existing credential
  item identifiers stay unchanged for compatibility.

The existing message-version receipt remains authoritative. A completed export
reuses its document, a known document can resume writing, and an unknown create
outcome blocks automatic duplicate creation. Partial-write errors are not
reported as success. This change does not alter document sharing or Google
account permissions.

## Verification boundary

Focused tests use temporary initialized hosts and mock Google/token-vault
responses; the HTTP and browser flows use real local Hub servers. Coverage
includes missing/invalid configuration, legacy fallback, private import,
canonical CLI selection, persistent `auth --client-file`, malformed credentials,
safe API errors, owner enforcement, OAuth state/PKCE, document read-back and
receipt reuse. Browser checks cover desktop/phone exports, the setup entry,
Chinese/English text, narrow layouts and existing message-action regression.

Validation on 2026-10-30:

- Focused logic/API/CLI suites: **27 passed** (`gdocs-setup`, `gdocs`,
  `hub-control-revocation`). Root standalone build passed (466 modules).
- Client build, client TypeScript and translation checks passed.
- Chromium: **7 passed** across `google-docs-setup` and `message-actions`;
  the two new setup journeys passed again after final UI wording changes.
- WebKit: the two new setup journeys and four message-action regressions
  passed; the existing offline-forwarding case failed at the forward-button
  click because `.conversation-notices .error-banner` intercepted it. A focused
  retry reproduced it. The unchanged base `2000edd20cefea0112afa6204cb56909314964cd`,
  rebuilt with the same dependencies, failed at the same click. This pre-existing
  offline UI problem remains unresolved by this Google Docs change.
- Root-wide TypeScript has **138 diagnostics**, identical to that same base with
  matching dependencies after normalizing paths and shifted source line numbers.
  No new diagnostics remain. This is not a claim that root-wide type checking passes.
- Staged secret scan and diff whitespace checks passed. Desktop/phone screenshots
  were inspected for wrapping and layout; the guide is collapsed by default.

No live Google account was configured and no document was created in Google as
part of this fix. Live OAuth consent and a real document write/read-back remain
pending owner setup. Browser coverage is not physical-device acceptance. The
source change is not a release or an update of the installed App/CLI.

Setup steps: [operations](operations.md#google-docs) and the bundled
[Google Docs skill](../../skills/tarocub-gdocs/SKILL.md).

## Mobile setup guidance, 2026-10-31

The phone no longer repeats the desktop status check or terminal instructions.
It directs the owner to complete setup in the host's desktop app, after which
the phone can export. The existing host scope label identifies that host.
Non-owners are directed to the owner. Desktop setup controls remain available.

Chromium and WebKit each passed all four existing export/settings journeys
(eight passes total), covering desktop, a narrow phone viewport, and simulated
iOS/Android platform identities at wide viewports. Chinese/English guidance,
absence of mobile setup controls, the desktop guide and missing-config export
errors were checked. Client build, TypeScript and translation checks passed.
This is browser verification, not native-device or live OAuth acceptance.

CLI impact: presentation only. Host authorization, status/export APIs and
`tarobot gdocs` commands are unchanged. No credentials were configured and no
new release or installed-App update was performed for this follow-up.
