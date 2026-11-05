# Security model

A trusted client can cause a privileged bot to run commands. Device approval is
therefore an authorization decision, not merely a login convenience.

**Scope decision, 2026-10-05:** the operator explicitly deferred application-layer
end-to-end encryption ("先不加密，以后再说"). This defers the additional content
encryption layer only; remote TLS, device pairing, authorization and native Hub
identity verification remain required. Desktop and mobile Apps remain the product
focus, with the browser used for preview/debugging. Relay operation stays TLS
passthrough; this decision does not introduce plaintext file/message storage on
the relay or close the native security acceptance items below.

**Current boundary, 2026-10-11:** browser preview uses ordinary fetch/WebSocket
TLS and cannot inspect and pin its actual peer certificate. The nonce signature
does not prevent a terminating relay from forwarding authentication and reading
the HTTP token. Use preview only in a trusted development environment; this is
not the native transport guarantee or an enforced server-side browser ban.
Android APK and iOS simulator SDK builds have since passed; physical devices,
final packages and real remote transport remain separate
[acceptance gates](acceptance-gates.md). The following October 5 findings retain
their historical scope. Current report follow-up and remaining authorization
issues are tracked in the [October 11 review disposition](review-disposition-2026-10-11.md).

**Open release blocker, 2026-10-05:** the existing nonce-only Hub signature is
not bound to the TLS endpoint. An isolated active proxy with another trusted
same-host certificate successfully relayed the handshake, read the token and
altered a message. Desktop source now enforces the TLS proof with pinned native
HTTP/WS. An isolated macOS WebView/IPC harness rejects the proxy before sensitive
requests and passes authenticated HTTP/WS and file transfer, using a temporary
in-process CA without changing system trust. Installed-app/platform acceptance
remains open. Installed clients and
r25 do not enforce it. The later r26 development bundle（本地材料：`evidence/macos-r26-2026-10-05.json`）
includes the desktop native implementation, with integrity and isolated transport
checks; full installed-product acceptance remains open. Android source now includes native pinning with isolated
JVM evidence. The [Android bounded WS follow-up](android-socket-bounds-2026-10-05.md)
adds frame/header/fragment limits before delivery and bounded cleanup of stalled IO. iOS source now includes URLSession/Security binding, demand reads,
and a registered Capacitor plugin, with real Foundation tests on Mac. Neither
physical Android nor iPhone acceptance is complete. SDK compilation alone does
not close the transport acceptance gap.
See [iOS implementation and limits](ios-native-transport-2026-10-05.md).
See [Android implementation and limits](android-native-transport-2026-10-05.md).
See [desktop implementation and limited evidence](desktop-native-transport-2026-10-05.md).
Passive TLS-passthrough privacy evidence does not close this gap.
See [reproduction, implementation scope and remaining work](tls-identity-2026-10-05.md).

- Hub bind validation rejects wildcard and public interfaces by default. Each
  listener can explicitly opt into `exposure: "public"` only with TLS; it never
  enables worker APIs there. Tailscale binds require TLS. Instance routes require
  a permitted loopback listener plus an individual bot key.
  See [host deployment](host-deployment.md).
- Pairing approval is owner-only, expires after five minutes and is one-use.
  Challenges expire after 30 seconds and cannot be replayed. Failed attempts are
  limited and audited. The Hub signs each client nonce with its persistent key.
- Browser device private keys are non-exportable WebCrypto keys in IndexedDB.
  This protects against ordinary export, but is not a native OS vault. Native
  Keychain/Keystore integration remains a required platform acceptance item.
- Short HTTP tokens are stored only as hashes in Hub memory and are rechecked
  against device revocation. Trusted UI revocation closes current sockets;
  revocation by another local CLI process is observed within the 500 ms sweep.
- Devices revoked while offline receive a nonce-bound, Hub-signed denial on
  reconnect when both sides support `auth-status.v1`. The client verifies its
  pinned key/device identity before persisting revocation and stopping retries.
  Forged or stale notices cannot set this marker. Cached history is retained;
  this is access revocation, not remote erasure. See [recovery](offline-revocation.md).
- Conversations enforce membership, bots enforce grants and author ownership.
  Google export requires the owner role because it uses the owner's Google
  account. Google refresh tokens reside only in a dedicated OS keychain item.
- SQLite and identity files are private. Backups/exports are also private but
  contain sensitive history and device metadata; store them accordingly.
- Rejection audits keep ten detailed samples per kind per minute, then aggregate
  counts every five seconds and at orderly shutdown. A crash or storage failure
  can lose unflushed counts; they are not an exact durable per-request journal.
  Source samples use the actual peer socket, never untrusted forwarded headers;
  a passthrough relay may therefore appear as loopback. Daily maintenance keeps
  audit rows for up to 90 days, with separate limits of 10,000 rejection or
  unapproved-pairing rows and 90,000 other events, so anonymous traffic cannot
  evict approval/revocation receipts through its quota.
  These quotas do not prune messages, events, attachments or trusted devices.
- Attachment IDs cannot become filesystem paths. Every bot file still enters
  through the existing delivery preflight. The Gateway size allowance changes
  neither credential-path denial nor the workspace sandbox.
- Static HTML uses a restrictive CSP, rich text never executes raw HTML, and
  attachments download with `nosniff`, sandbox policy and attachment disposition.
  Cross-origin clients must be explicitly allowed. Loopback HTTP is development
  only; remote connections require HTTPS and a matching pinned Hub identity.
- Google OAuth uses loopback redirect, state, PKCE and fixed Google endpoints.
  Tokens go to the keychain through stdin, not process arguments. Logs record
  safe status codes; they do not include token exchange payloads.

Tests cover unknown/revoked devices, challenge replay, expiry, membership,
traversal names, hostile origins, MIME/header validation and schema downgrade
refusal. This document describes implemented controls, not a claim that all v1
security and deployment acceptance has been completed.
