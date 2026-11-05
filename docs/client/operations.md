# Local development and operations

Use these commands against the intended Hub and its own state directory.
For public access, follow [remote setup](remote-access.en.md); do not restart an
unrelated Feishu or Telegram fleet as part of App host or relay maintenance.

```sh
npm ci
npm ci --prefix client
npm run build
npm run build --prefix client
node dist/src/index.js init --name "Development host" --state-dir /path/to/private/dev-hub
node dist/src/index.js hub run --state-dir /path/to/private/dev-hub
```

Init selects loopback-only ports; use the displayed address in a browser.
The local service manager supports `hub service start`, `stop`, `restart`,
`status`, and `logs`, each accepting `--state-dir`. Repeated start is idempotent.
Stop uses a private Unix socket, not an unverified PID. These commands start a
detached process; OS boot supervision is separate deployment work.

## Pairing and instance configuration

```sh
node dist/src/index.js hub devices approve 12345678 --state-dir /path/to/dev-hub
node dist/src/index.js hub devices list --state-dir /path/to/dev-hub
node dist/src/index.js hub devices revoke DEVICE_ID --state-dir /path/to/dev-hub
node dist/src/index.js hub bots register BOT_ID --key-file /private/instance/gateway.key --state-dir /path/to/dev-hub
```

The example code is a placeholder; use the client's fresh code. Add a `gateway`
section to the intended instance's `config.json`:

```json
{
  "gateway": {
    "enabled": true,
    "hubUrl": "ws://127.0.0.1:8788/instance",
    "secretPath": "/private/instance/gateway.key"
  }
}
```

Configuration is additive. Missing Gateway configuration leaves Feishu behavior
unchanged. Invalid Gateway settings are logged and disable that optional
surface, without stopping the Feishu service. Actual fleet activation remains
subject to the existing busy/restart controls.

## Standalone Bot recovery protection

App-created Bots use TaroCub's existing `restart-loop.json` policy: three recent
unclean endings within ten minutes temporarily suppress startup recovery for one
worker run. Hard kills are detected from its stale lock; handled fatal startup
or cleanup exceptions are also counted. The Bot can still receive new commands.
Look in Bot → Activity records → Audit for `service.startup_maintenance`, or in
service details for the recovery-pause notice. This is a retained historical
record, not proof that a later worker is still paused.

The guard preserves pending final answers and continues replaying already
committed Gateway publications. After investigating the failure, a successful
idle restart clears the crash window and the next boot attempts recovery again,
subject to the existing delivery limits. It does not fix invalid configuration,
storage failures or every possible source of process crashes. Deployment/fleet
restart remains a separate operator action.

Hub separately supervises managed workers: within a rolling ten-minute window
it retries the first three unexpected exits after 1, 2 and 4 seconds, then pauses
on the fourth. Failures outside that window do not accumulate. Service details
show the pause and the worker's recent redacted output. After investigating,
“空闲后重启” starts a stopped Bot and clears its automatic-retry budget. This
supervisor budget is in memory and resets when the Hub restarts; it is separate
from the worker's persisted recovery guard above.

“已安排空闲后重启” appears only after the worker confirms receipt. Active work,
pending approvals, questions and queues still delay exit. “已启动 Bot，正在连接。”
confirms process creation; wait for online status before using it. A disconnected
process is retained until exit, not replaced while potentially still executing.
If confirmation times out, the App reports that the result is uncertain: check
service status before requesting another operation. Replaying the same HTTP
receipt returns the previous result without restarting another process. Full
state backup preserves these receipts; interrupted receipts never automatically
repeat the restart. A normal planned exit is not counted as a diagnostic incident.

## Upload size configuration

Add `"maxFileBytes": 1073741824` to the Hub state's `config.json` to allow files
up to 1 GiB. Omitted values use 536870912 bytes (512 MiB). Use a positive safe
integer, not a string or an `MB` suffix. Restart that Hub to apply the setting;
clients learn the policy when they reconnect. This does not restart Bot or
Feishu processes. Chunk size remains 8 MiB and SHA-256 checks still apply.
Lowering the limit preserves complete attachments and unfinished chunk receipts;
unfinished files above the new limit cannot progress until the limit is raised.

## Backup and export

`hub run` checks once per minute, applies audit retention, makes a daily
checkpointed SQLite snapshot, then collects unreferenced attachments older than
seven days. Failures retry on the next tick.

Automatic snapshots use `backups/auto-YYYY-MM-DD.sqlite` (UTC), with the seven
latest successful days retained. A restart on the same day checks and reuses the
existing snapshot. A new snapshot is completed under a temporary name and
published before older automatic copies are removed; a failed or corrupt
snapshot does not trigger rotation. Manual exports, full backups, legacy
timestamp-named copies, symlinks and other directories are not removed by this
policy. Legacy copies still consume space and need a separate operator review.

Audit history retains up to 90 days and 100,000 rows: 10,000 rejection samples/
summaries or unapproved pairing requests, and 90,000 other events. Rejection floods cannot displace device
approval/revocation records from the other partition. Chat history and device
trust are not subject to audit retention. SQLite may reuse freed pages rather
than immediately shrinking the live database file. Manual operations:

```sh
node dist/src/index.js hub backup /private/backup/hub.sqlite --state-dir /path/to/dev-hub
node dist/src/index.js hub export /private/export/new-directory --state-dir /path/to/dev-hub
node dist/src/index.js hub gc --state-dir /path/to/dev-hub
```

Export uses the snapshot's attachment manifest, protects against concurrent
garbage collection and copies complete blobs. It does not export private Hub
identity or Google credentials. Preserve `identity.json` separately in a secure
backup if restoring the same trusted Hub; replacing it requires device pairing.

For recovery of the Hub **and its client-created Bots**, use the separate full
state bundle. Stop this Hub normally and wait for its managed workers to exit;
the backup command acquires their instance locks and refuses active services. It
does not stop services itself. Existing database-only commands remain unchanged.

```sh
node dist/src/index.js hub backup /private/backups/new-hub-bundle --full --state-dir /path/to/dev-hub
node dist/src/index.js hub restore /private/backups/new-hub-bundle --state-dir /path/to/dev-hub
```

The backup destination's parent must already exist. Restore requires the original
canonical Hub path to be absent: preserve any old directory elsewhere before
restoring, and never run both copies of the same Hub identity at once. Restore
refuses existing directories, including empty ones, and does not merge/overwrite
state. Keeping the original path preserves workspace identities used by native
engine sessions. Relocation to a different Hub path is not supported by this
command. Review the returned dependency list before starting the restored Hub.

The bundle contains `manifest.json` (format `tarocub-hub-state`, version 1) and
`state/`. It includes the checkpointed Hub database, identity, device enrollments,
complete attachments, resumable upload chunks, Hub-local config/credentials, and
`bots/` state including Gateway keys, sessions, receipts, cron/board/workflow state
and default workspaces. Workspace VCS/dependencies and executable bits are retained.
Existing backup directories, the Hub service log, process locks and sockets are
excluded and listed in the manifest. Workspace files named `*.lock` are retained.
The manifest is published only after all file copies, hashes and database-backed
attachment references validate. A missing blob/chunk or oversized/changed file
fails the operation; it is never silently omitted.

This bundle contains private keys and may contain credentials. Keep it in private
storage and restore only a trusted backup. Files are owner-only, with owner execute
preserved where needed; directories are `0700`. Limits are 100,000 entries, a
16 MiB manifest and 1 TiB total file data. Bodies stream in 256 KiB blocks. Restore
checks schema, safe paths, duplicate names, sizes, SHA-256 values, SQLite integrity,
Bot key/database agreement and attachment/chunk receipts. Workspace symlinks are
stored as metadata and recreated after regular files; their targets are never
followed for copying or restoration writes. A killed restore leaves an incomplete
marker that prevents Hub startup; retain that directory for inspection and retry
from the intact bundle into the absent original path. Caught failures remove only
the destination owned by that restore operation.

`externalPaths` reports configured workspaces/profiles, TLS/push/OAuth/client paths
outside the Hub and external symlink targets. Relative configuration paths are
reported verbatim because their meaning depends on the service working directory.
Environment-derived dependencies are not inventoried. Back up custom workspaces,
shared MCP credentials, global engine login/history (including explicitly selected
`CODEX_HOME`/`CLAUDE_CONFIG_DIR`) and pre-existing registered Lark/Telegram instances
separately. `unmanagedBots` and `engineStateIsExternal` make those exclusions visible.
The verified real Codex recovery is on the same computer with its existing CLI
login/history; it is not evidence of cross-machine engine migration. Daily automated
backups still snapshot the database only; full bundles are explicit offline operations.

## Google Docs

In **Settings → General → Google Docs**, the host owner can check configuration
and saved authorization and expand the setup guide. This is a status/help entry;
the OAuth flow still starts in the host terminal. Phones and other clients use
the connected host's authorization, rather than each configuring a Google account.

Enable the Google Docs API in a Google Cloud project, configure its OAuth consent
screen (including your test user when applicable), and create a **Desktop app**
OAuth client. Download the JSON to the host. This is OAuth, not a normal API key.

```sh
tarobot gdocs configure --client-file /private/installed-app.json
tarobot gdocs auth
tarobot gdocs status
```

`configure` validates and imports a private copy into the initialized host's
`gdocs/google-oauth-client.json` (file mode `0600`), without rewriting live Hub
configuration. `auth --client-file FILE` also imports before starting authorization.
The downloaded source file is no longer needed after import. Open the printed URL
in a browser **on the host computer**, because OAuth returns to its loopback
listener. Refresh tokens stay in the host's OS credential vault. Do not paste
configuration files, authorization URLs, or tokens into chat.

These commands now use the same canonical host selection as the App/host CLI,
including `TAROBOT_HOST_DIR`. Add `--state-dir /absolute/host` to each command when
selecting a different host. An ambiguous old headless host requires explicit
selection; identities are not merged. Explicit `--client-file` reads take
precedence; otherwise the managed copy wins over legacy `config.gdocs.clientFile`
and `<host>/google-oauth-client.json`. Existing legacy config remains readable.
Managed imports belong to the host's private full backup; the credential vault
is external and must be authorized separately on another computer.

Current authorization supports macOS Keychain and Linux Secret Service, not
Windows hosts. `status` checks configuration and stored token structure without
contacting Google; a saved token is not proof of current Google access. Export
reports missing config, invalid config, authorization and vault failures as
distinct actionable errors instead of `internal_error`.

`gdocs create --title TITLE --file FILE` and `gdocs update --id ID --file FILE`
write UTF-8 source text and verify it by reading back. Update replaces the first
tab and refuses a stale revision. Markdown remains source text. The client
message's export action reuses a durable receipt for that exact message version.
If a create request had an unknown remote outcome, it reports that uncertainty
instead of creating another document automatically.

The vendored `skills/tarocub-gdocs/SKILL.md` is included by the existing skill
installer. Installing it into live engine homes is deferred with deployment.

References: [Google installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Desktop client setup](https://developers.google.com/workspace/docs/api/quickstart/python#authorize_credentials_for_a_desktop_application),
[Docs create](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/create),
[Docs batch update and revision guards](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate).

## Dual-route listeners and monitoring

Keep the instance listener on loopback. With TLS enabled, it uses
`instancePort` (default 8789) separately from the client listeners. Configure the
Tailscale certificate on the Tailscale listener and the public-domain certificate
on a loopback TLS listener used by the outbound relay tunnel. `tls.sni` can map
multiple names to separate certificates. Additional TLS listeners never expose
instance enrollment/RPC, even when traffic arrives from a loopback relay.

`relay` in Hub configuration starts the outbound mTLS tunnel. The tunnel client
needs the relay CA, its own client certificate/key, relay hostname and port, and a
`targetHost`/`targetPort` that exactly matches a configured loopback TLS listener.
The relay holds only the tunnel server key; **the Hub domain TLS key stays on the
Mac**. `hub relay status` reports whether the configured tunnel is connected.

An optional `routeMonitor` block probes configured `/health` routes every 15
seconds and compares the reported Hub public key. This is a best-effort
availability signal, not the signed identity proof required for pairing.
Routes with a private CA can include the same base64 DER `certificateAuthority`
field used by pairing; the monitor trusts it only for that route, keeps normal
TLS hostname validation, and does not follow redirects. Routes without an
explicit CA continue to use system trust. Example placeholders:

```json
{
  "routeMonitor": {
    "routes": [
      { "name": "Tailscale", "url": "https://mac.example.ts.net:8788" },
      { "name": "VPS", "url": "https://hub.example.com" }
    ],
    "botId": "your-instance",
    "conversationId": "gw_existing_alert_conversation"
  }
}
```

Create the alert conversation with that bot first, and configure
`gateway.alertChatId` on the same instance to an existing Feishu chat receiving
operational alerts. A continuously failing route triggers after five minutes:
Hub persists one alert message (available through the surviving route), then asks
the local instance to deliver the Feishu notification. The Hub tracks these two
deliveries separately, and the instance records the outbound notification receipt.
Restarting the Hub does not start a second outage or duplicate the Hub message.
A recovered route resets the outage timer. This configuration is inactive unless
explicitly provided; development tests use fake delivery and do not send alerts.

## Client pairing, preferences and local reset

A trusted device can display its Hub QR code in Settings → Pair a new device.
The new device can scan it with its camera or choose a QR image. It then displays
a one-use code and approval QR. On the trusted device, scan that approval QR and
press **Approve pairing**. A scan alone never approves a device. A QR-supplied
Hub identity must match the pairing response.

Settings support Chinese/English UI, theme, font size, device renaming/revocation,
quiet hours and route editing. Bot-authored text is not translated when changing
UI language. Existing engine settings remain under the shared `/config` panel.

Messages, drafts and the ordered outbox are stored locally. Viewed attachments
up to 16 MiB are cached within a 128 MiB least-recently-used budget; larger or
uncached attachments require a connection. Explicit **Disconnect and pair again**
clears local history, attachment cache, drafts and unsent messages and deletes the
native device key. Hub history remains on the server. Appearance preferences stay.


## Attachments, app lock and desktop updates

For everyday actions, see the [Chinese client guide](user-guide.md).

Inbound shares use Android ACTION_SEND/ACTION_SEND_MULTIPLE and an iOS Share
extension. The main iOS target and `com.tarobot.client.share` extension both need
the `group.com.tarobot.client` entitlement in their provisioning profiles. App
keys and Hub credentials are not shared. The extension is an explicit dependency
of the main target and is embedded in its PlugIns directory. On iOS, save the
share and then open TaroCub; the extension does not force-open the containing app.

Native storage limits: 64 files per share and 16 queued shares. Each share's total
bytes may reach the most recently authenticated Hub's per-file limit (512 MiB by
default); the inbox total is twice that limit (1 GiB by default). The cached public
limit is reset on re-pairing; no identity or token is stored with it. The Hub checks
the current policy again on upload. Expired entries are collected when the inbox is accessed after
24 hours. The native bridge returns at most 1 MiB per read. The app reviews the
recipient and text, pins them on first send, uploads through the existing resume
protocol, and deletes its private copy after durable outbox acceptance. Re-pairing
also clears the inbox. Mobile compilation and share-sheet device tests are pending.

The shared iOS store can be compiled and exercised without an iOS SDK:

```sh
swiftc client/ios/App/Shared/ShareInboxStore.swift client/ios/tests/ShareInboxStoreChecks.swift -o /tmp/tarocub-share-checks
/tmp/tarocub-share-checks
```

Implementation references: [Android receiving shared content](https://developer.android.com/develop/ui/compose/sharing/receive),
[Apple extension shared containers](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html),
[NSItemProvider temporary file representations](https://developer.apple.com/documentation/foundation/nsitemprovider/loadfilerepresentation(fortypeidentifier:completionhandler:)),
[Apple file metadata privacy reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).

File cards offer a bounded text/code preview and PDF preview. HTML/SVG are displayed
as escaped text. Unsupported formats can be saved for another application. On
macOS/Windows, Save As uses the native dialog and grants write access only to the
selected path. Writes use 1 MiB chunks. Mobile uses the system share sheet and an
app-owned cache copy; stale export copies are removed after 24 hours when exporting
again. Browser downloads preserve the original bytes. The iOS project includes the
filesystem timestamp privacy manifest.

Mobile Settings → App lock optionally requires the device's biometric or passcode
prompt. Enabling and disabling both require authentication. It locks on background
and hides recent-app previews (Android also prevents screenshots). This is a local
screen lock, not encryption of IndexedDB or a replacement for Hub device revocation.
The mobile simulator/hardware acceptance is still pending.

Desktop builds check for updates on startup and daily. Installing is always an
explicit button action; release notes and progress appear in Settings. Development
builds have no update feed. Windows private GitHub releases use the login,
build and publication flow in [Private GitHub updates](windows-github-updates.md);
one bootstrap install is needed before future in-app upgrades. The headless host
CLI retains its independent update/rollback commands.

For the existing public-feed desktop release path:

```sh
# Store signing secrets outside the repository. The public key comes from
# `npx tauri signer generate`. Never distribute the private key with the app.
export TAROCUB_UPDATE_URL=https://updates.example.com/latest.json
export TAROCUB_UPDATE_PUBLIC_KEY='<base64 Tauri public key>'
export TAURI_SIGNING_PRIVATE_KEY='/private/path/update-signing.key'
npm run desktop:release --prefix client -- --target universal-apple-darwin --bundles app,dmg
```

The build helper creates a temporary config, enables updater artifacts, pins the
public key, requires signed version metadata and prevents downgrades. OS signing
and notarization remain separate credentials. Publish the signed artifacts and
Tauri update manifest only in the authorized release step. No feed or signed
package has been published or live-installed during local development.


## UnifiedPush on Android

The Android app includes the official UnifiedPush connector. Install and open a
compatible distributor (for example ntfy), configure its server, and add that
server's HTTPS origin to `push.unifiedpush.origins` on the Hub. In Settings →
Notifications, refresh the distributor list, select one and connect it. The app
requests notification permission, registers a device-scoped instance and sends
the endpoint plus encryption keys to the authenticated Hub. Registration success
requires the Hub to accept the endpoint allowlist. Private device identity keys
are never sent to the distributor.

Notifications use Web Push payload encryption and distinct message IDs. The native
service ignores plaintext/malformed payloads and displays only generic text. A tap
opens the corresponding conversation/message. Reconnection refreshes registration;
changing to FCM or clearing local identity unregisters UnifiedPush first. No
distributor/Hub setup means the settings screen explains the requirement while
foreground realtime messages remain usable. Endpoint changes while the app is
asleep are persisted locally and synchronized with the Hub on its next connection.
Android compilation and real distributor delivery remain unverified on this host.

References: [UnifiedPush Android connector](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector/-unified-push/),
[PushService](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector/-push-service/).

## Relay installation and alert retry

See [Relay deployment command](relay-deployment.md) for the implemented
`hub relay deploy --host … --dry-run` and SSH status commands. No real VPS has
been changed. Route-alert delivery uses the same Feishu message UUID across
retries for 45 minutes, below the provider's one-hour dedupe interval. Completed
receipts never resend; ordinary commands and approvals remain at-most-once.
After that retry window, an uncertain notification requires operator inspection;
the Hub's persisted outage message remains available through the surviving route.
