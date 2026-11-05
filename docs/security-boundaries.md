# Security Boundaries

## Optional concurrency-pool files

The default turn-pool directory may be beneath Linux's shared temporary
directory. Before creating a sibling lock or reading state, the host checks
that this default directory is a real directory owned by the current user and
not writable by other users. Pool reads reject symlink/non-regular files and
foreign ownership where the OS exposes it; writes use exclusive private
temporary files and atomic replacement. Explicitly configured directories
remain operator-controlled locations. POSIX mode tests are not Windows ACL
acceptance. Corrupt state fails closed; see [recovery rules](state-model.md#optional-shared-turn-pool).

## Expiring device invitations

Public `POST /api/pair` requires a 256-bit invitation from an authenticated
owner. There is no loopback, relay, legacy-client or configuration exemption.
Invitations last 5 minutes, admit one exact device/request, and only create a
pending request. Owner-signed approval of its 8-digit code remains necessary.
An identical admitted request may retrieve its receipt, using its high-entropy
request ID; this path cannot admit a new request. Invalid tokens allocate no
source-rate buckets, pending rows or audit entries.

Invitations are stored as hashes in bounded process memory and expire on either
wall or monotonic deadline. Restart invalidates invitations, not enrolled
identities or already admitted pending requests. Refresh/revoke closes new
admission only. On the first strict upgrade, pre-invitation pending requests
are retired once, after host identity admission and before listening. Paired
devices and their keys are unchanged. Local desktop/CLI controller bootstrap
still uses its existing authenticated local OS/control-pipe proof.

QR v1 route data is retained; the invitation is a separate query parameter.
Older readers can still repair a previously paired host's routes, but cannot
register a new device. New clients require a Host advertising
`pairing-invites.v1` (public discovery: `pairingInvites: 1`). There is no silent
fallback to static first-pairing codes. Until a first admission receipt is
known, the client persists the original invite, request ID and device identity
before sending; after receipt it removes the invite. This enables retry without
key replacement or duplicate pending requests. See the [design and verification](client/rotating-pairing-invites-2026-10-26.md).

## Opt-in client and native share surfaces

The v1 client adds a separate device-authenticated Hub surface. Pairing requires
owner approval, Ed25519 challenge proofs bind both peers, and short HTTP sessions
are revoked with the device. Gateway creates an authenticated facade sharing the
existing engine/session manager. The retired Telegram/Lark adapters are not
remote entry points in this repository. Client conversation, file and operation authorization
is enforced by the Hub before dispatch. See [client architecture](client/architecture.md).

Rate-limit sources from the built-in relay arrive through the mTLS v2 control
channel and an exact local socket registry, not client-controlled HTTP headers.
These values affect quotas/audit attribution only. Remote loopback reports stay
in the relay namespace, and worker APIs retain their listener boundary. Unknown
devices cannot consume a known device's challenge bucket; successful signatures
are not rejected by another caller's failure counter. Bounded tables reserve
known/local capacity. NAT, distributed saturation and dishonest relay operators
remain availability limits. Both runtimes require upgrading; see
[relay source isolation](client/relay-source-isolation.md).

Authenticated HTTP requests recheck trust after body receipt, at guarded queue
entries and before private responses. Pairing/revocation actor checks share the
write transaction. Active attachment streams are aborted on device revocation;
the identity sweep also detects external CLI revocations and session expiry.
Already received bytes and previously admitted side effects cannot be recalled.
See [HTTP revocation checks and scope](client/http-revocation.md).

Hub schema 11 retires an attachment ID when its last published reference is
recalled. New downloads, publication using that ID and upload retries are
rejected immediately; active references and independently forwarded copies
remain usable. Re-uploading owned bytes creates a fresh ID. Retirement is
transactional and survives restart; GC later removes the retained file and its
marker. Already downloaded/cached/copied bytes and admitted streams are not
revoked. See [quoted media acceptance](client/quoted-media-2026-10-05.md).

Realtime client writes validate device trust inside their database transaction,
after waiting in the writer queue. Card enqueue rechecks conversation membership
there too. Private socket output rechecks device trust before entering the writer;
known rejected connections cannot resume pending guarded sends. Stop RPCs keep
their independent queue but recheck the target before dispatch. Previously
committed work remains admitted. See [realtime revocation scope](client/socket-revocation.md).

Management operations validate after their own waiting boundaries: Bot creation
checks inside registration after preparation; file edits/scans/reveal check after
file/root reads; managed restart checks after receipt I/O before IPC/spawn; Google
export checks device, owner and conversation membership at durable admission
after OAuth. A denied restart preserves its prior receipt, allowing a trusted
retry. Already admitted Bot launches and external document writes finish their
durable bookkeeping; revocation does not roll them back. See
[management admission scope and evidence](client/control-revocation.md).

The client accepts `ready` only after verifying the pinned Hub's signature and
sending its device proof on that socket. A public `/health` key is not proof of
identity. Pre-authentication application frames cannot change cache/outbox state
or persist revocation; repeated/out-of-order handshake frames close the socket.
An authenticated `device_revoked` notice immediately stops sending and requests
a fresh signed denial on reconnect; the notice alone never persists revocation.
A stale page cannot revoke a subsequently paired identity. Clients advertising
`auth-status.v1` can also receive a separately signed `auth.denied` during a
failed handshake. Only a known revoked device gets this receipt. The client
checks its pinned Hub key, device ID, fresh connection nonce and the dedicated
revocation signing domain before stopping transport and persisting the marker.
An unsigned error/notice or replay from another connection cannot do this.
If a socket closes while handshake cache writes are pending, their completion
cannot restore its HTTP token, timers, route health or online status.
Older Hubs still reject offline-revoked devices without a durable recovery
reason. See [offline revocation recovery](client/offline-revocation.md).

`GET /api/network/host-routes` (`host-routes.v1`) is owner-scoped disclosure of
the host's own bound LAN/Tailscale addresses, checked against the pinned
`hostPublicKey`; it grants nothing. In browser builds this field is an unsigned
claim over browser TLS, matching other HTTP APIs; it is not a signed manifest. A route learned there is used only after the pinned identity
proof and a signed handshake on that route. The Hub may replace only its own
stale desktop-managed descriptor route, by compare-and-swap that an owner
command wins. See [route sync](client/tailscale-route-sync-2026-10-21.md).

Large Bot replies use negotiated physical fragments. Each physical frame stays
under 1 MiB, and base64 fragment data under 200 KiB. Reassembly verifies sequence,
length, UTF-8 and SHA-256 before the logical payload reaches schema validation,
storage or an engine. The Hub only accepts such input from authenticated local
instances; this does not lift the ordinary client command/text limits. Receivers
retain one partial transfer per socket, discard it on closure and reject a transfer
idle over 30 seconds on its next frame. The advertised total never determines an
allocation. Complete logical replies still require memory proportional to received
content, with no new arbitrary truncation limit; authenticated Hub/instance peers
remain trusted with this resource. This transport checksum is not an authorization
mechanism or encryption. See [long-message protocol](client/protocol.md#long-replies-and-physical-fragments).

Link previews are another authenticated Hub surface: membership is checked before
fetching. Public HTTP(S) pages are read without cookies or auth headers, with DNS
answers pinned to the request and all redirects revalidated. Private/reserved IPs,
credential URLs and nonstandard ports are blocked; encoded and decoded byte caps,
a combined deadline and concurrency limits bound work. Metadata is parsed as text,
never executable HTML. Covers use authorized conversation attachments, not remote
browser pixels. See [link preview protocol](client/protocol.md#link-previews).

Markdown image syntax never creates a passive image request: external HTTP(S)
images become explicit links showing their destination, and invalid/relative
image URLs remain inert. Authorized attachment previews use their separate
download path. Capacitor copy/sync installs a bundled-mobile content policy
restricting scripts, workers and WebView networking to the App origin while
preserving local media previews; Hub requests use the native transport. See
[content policy and verification limits](client/mobile-content-policy-2026-10-11.md).

Mobile shares are untrusted input. Android accepts granted `content:` resources,
rejects `file:` and its own FileProvider, then copies into an app-private directory.
iOS uses a Share extension and the `group.com.tarocub.client` container. This
container holds drafts and copied files, never device private keys or Hub tokens.
The extension has no Hub transport. Both implementations bound file count, copied
bytes, queue size and lifetime; file reads from JavaScript use an opaque UUID and
index with a 1 MiB maximum, never caller-selected paths. HTML is kept as text.

Shares require a user-selected conversation and explicit send. Before uploading,
the destination, Hub identity, device identity and text are pinned locally; retries
reuse the same client message ID. Removal follows durable browser-outbox acceptance,
not a claim of engine completion. Reset clears the native inbox too. The optional
mobile lock hides this UI but does not encrypt IndexedDB. These native surfaces
still require Android/iOS platform build and hardware acceptance.

Remote device approval/revocation require fresh one-use signatures from the
current device key, bound to the exact action, target record and HTTP session.
Current owner/trust checks and proof consumption happen inside the mutation
transaction. Tokens alone cannot make these changes; the local CLI bootstrap
path remains separate. This does not secure other token-authorized operations,
browser MITM/XSS or a compromised device. See
[device action proofs](client/device-action-proofs.md).

Mobile device-key generation and signing stay in native code. The bridge
returns public identities/signatures and has no seed export or generic storage
method. Android seeds use Keystore wrapping and native Ed25519. iOS and desktop
vault seeds are also encrypted with a random installation key held in App data;
iOS excludes that key from backup. Removing installation data makes old wrapped
seeds unusable, even when an OS vault retains them. Unbound remote keys require
re-pairing; the local desktop controller has a separate Host-proof migration.
Invalid marker data fails closed. Deleting only a Mac executable or offloading
iOS App data is not complete removal, and uninstall cannot reliably revoke an
offline Host's device record. See [installation boundaries and acceptance limits](client/reinstall-pairing-2026-10-28.md).
Compromised App code can still invoke permitted signing operations.

This document explains the trust boundaries in TaroBot.

The goal is not to claim the system is "secure" in the abstract. The goal is to make the current security model explicit enough that future changes do not quietly widen trust, weaken isolation, or reintroduce file- or state-handling bugs.

This document should be read together with:

- [Architecture Notes](./architecture-notes.md)
- [State Model](./state-model.md)

## Threat Model

The project is a local-first agent host with device-authenticated Apps and a
headless owner CLI. It is **not** a hardened multi-tenant server.

The practical threat model includes:

- untrusted network callers at Hub pairing, HTTP, WebSocket and relay listeners
- authenticated devices acting outside their membership or owner privileges
- untrusted messages, attachments and model output reaching local engines or file delivery
- optional local Bot delegation and cross-host Bot messages
- sensitive on-disk state and engine subprocesses sharing the operator's CLI environment

The operator controls the host OS account. State directories are private to that
account; same-user process compromise is not isolated by Bot boundaries. The
legacy optional Bus listener remains loopback-only. Relay transport does not
replace device authentication or grant owner permissions. Telegram/Lark adapters
were [retired](adapter-retirement-2026-10-21.md); retained routing identifiers and
compatibility readers do not make those services active ingress paths.

## Boundary Map

1. Unauthenticated network caller vs paired, authenticated device
2. Authenticated device vs conversation membership and owner-only operations
3. Local CLI/controller proof and optional Bus peer vs privileged host operations
4. Model output vs filesystem egress and document/URL rendering
5. Per-Bot state vs operational artifacts and shared engine configuration
6. User intent, permissions and cancellation vs provider CLI side effects

These boundaries are not substitutes for an OS sandbox. A full-access Bot can
read outside its workspace under the configured file policy, and engines can
modify permitted local files. Missing/corrupt authoritative state must fail
closed; optional derived data may be rebuilt under its documented rules.

## 1. App and CLI Authorization Boundary

### Trusted

- a pinned Host identity after its proof is verified
- a device after a fresh proof and current trust checks
- local CLI/controller operations admitted by the local OS/control proof

Trust is scoped: a paired member is not automatically an owner or a member of
every conversation. Authentication does not make message text or files safe.

### Untrusted

- public discovery and unapproved pairing requests
- caller-controlled headers, message text, attachments and quoted context
- card actions, target IDs, file paths and model-produced instructions
- revoked/expired device sessions and stale authorization after queued work

### Current enforcement

- [Hub authentication](../src/hub/auth.ts) and [server routes](../src/hub/server.ts) enforce invitations, signed pairing approval, device proofs and session trust.
- [HubStore](../src/hub/store.ts) checks membership and role at shared operation boundaries; HTTP/socket work rechecks trust after relevant waits and before private output.
- [GatewayChannel](../src/gateway/channel.ts) derives `p2p`/`group` from the authenticated conversation; remote input cannot choose the privileged internal `bus` chat type.
- Owner CLI operations use the same Host state and business rules, with a distinct local controller proof. They do not start a second reduced Host implementation.
- Bot-message delegation requires its explicit grants and context; optional Agent Bus has its own host-local coordination policy.

### Residual risk and design rule

Authorized messages can contain prompt injection. Previously admitted side
effects and already received bytes cannot be recalled by revocation. New routes
must use the shared role/membership checks and preserve the existing trust
rechecks at asynchronous admission and response boundaries. Neither loopback
origin nor a UI visibility check is authorization.

## 2. Local Bus Boundary

The Agent Bus is a privileged local control plane, not a public API.

### Trusted

- loopback-bound bus servers started by known bridge instances
- peers explicitly allowed by `bus.peers`
- requests that pass secret validation when a secret is configured

### Untrusted

- arbitrary local processes
- stale or forged registry entries
- wrong local listeners occupying an expected port
- peer instances not listed in the allowed peer set

### Current enforcement

- [src/bus/bus-server.ts](../src/bus/bus-server.ts) serves only on `127.0.0.1`
- `/api/talk` enforces JSON shape, body size, peer allowlist, and max delegation depth
- each process admits at most 8 active `/api/talk` requests and returns retryable `server_busy` when saturated
- shutdown drains in-flight HTTP requests and force-closes remaining connections after 5 seconds
- bus auth uses a bearer secret when configured
- [src/bus/bus-registry.ts](../src/bus/bus-registry.ts) probes `/api/health` and validates the bridge fingerprint before treating a registry entry as alive
- [src/runtime/bridge.ts](../src/runtime/bridge.ts) auto-allows `chatType === "bus"` only because bus auth is supposed to have already happened at the server boundary
- [src/gateway/channel.ts](../src/gateway/channel.ts) derives App message chat type from the authenticated conversation (`p2p` or `group`), not from a caller-supplied synthetic `bus` type. The retired Telegram normalizer is no longer an ingress boundary.

### Residual risk

- local same-user compromise is still high impact
- a leaked bus secret is effectively local remote-control capability for that instance
- bus requests are privileged enough that logging and usage/budget semantics must stay aligned with App/Gateway

### Design rule

Treat bus changes as security-sensitive even when they are "only local". A loopback API with delegated model execution is still a real authority boundary.

## 3. Local Web Console Boundary

The optional web console is a privileged local configuration surface. Loopback binding reduces exposure, but it does not replace authentication.

### Trusted

- a browser opened by the local operator with the random token generated for the current console process
- same-origin API requests authenticated by that token or its short-lived browser-session cookie

### Untrusted

- arbitrary local web pages and browser extensions
- unauthenticated local processes
- stale, copied, or externally shared console URLs

### Current enforcement

- the console server binds only to loopback
- the initial URL token is accepted as a bearer credential, exchanged for an `HttpOnly`, `SameSite=Strict` session cookie, and removed from the visible URL with `history.replaceState`
- the client keeps a session-scoped token copy for explicit API authorization; same-origin cookie authentication also preserves refresh behavior after URL cleanup
- shell responses set `no-store`, `no-referrer`, `nosniff`, frame denial, a restrictive permissions policy, and a content security policy

### Residual risk

- the first navigation still carries the token locally before client-side cleanup
- same-user process or browser compromise can recover local console authority
- the console uses loopback HTTP rather than TLS and must never be rebound to a non-loopback interface without a new threat model

### Design rule

Do not add an unauthenticated console endpoint or persist the console token beyond the browser session. Any new shell asset must remain compatible with the restrictive response headers.

## 4. File Delivery Boundary

File delivery is the highest-risk boundary in the product because it turns model output into filesystem reads and delivery to App conversations.

### Trusted

- canonical files under the instance workspace
- canonical files under an explicitly resumed project root
- inline ` ```file:... ` blocks for small text/code artifacts

### Untrusted

- arbitrary absolute paths emitted by the engine
- local Markdown links in model output
- symlink paths before canonical resolution
- any file outside the allowed workspace roots

### Current enforcement

- Host-owned App instructions select registered App attachment tools; per-Bot `agent.md` remains user-owned persona/preferences.
- [src/core/shared/tool-tags.ts](../src/core/shared/tool-tags.ts) parses generic compatibility tool tags, and [src/core/shared/delivery-tags.ts](../src/core/shared/delivery-tags.ts) handles historical delivery references.
- [src/core/shared/artifact-delivery.ts](../src/core/shared/artifact-delivery.ts) extracts shared fallback file/image references and resolves `realpath()` before policy checks. Current App-native tool delivery has its own authenticated Gateway publication and receipt boundary.
- scoped delivery only permits canonical paths under the bot workspace or the active `/resume` workspace override; App and headless-host full-access Bots default to allowing other readable absolute artifact paths
- non-files, oversized files, missing files, and permission failures are rejected and surfaced back to the user
- All channels reject known credential filenames/extensions and specific credential locations after canonical resolution (including symlink targets). This includes `.env*`, private SSH keys, PEM/P12/PFX/JKS/keystore files, known CLI/cloud auth files and browser cookie/login databases. The source of truth is `src/runtime/credential-files.ts`; ordinary generated artifacts under engine directories remain allowed. This is filename/location filtering, not content inspection: renamed or embedded secrets are not comprehensively detected.
- Shared compatibility delivery batches are rejected before upload when they exceed 120 MiB in aggregate
- Shared compatibility image batches are preflighted first and then read/uploaded one image at a time, so one request does not retain every image buffer simultaneously
- App native and compatibility delivery use `core/file-send-policy.ts`: a strictly validated effective Full access permission defaults to external paths, explicit `TAROBOT_ALLOW_ANY_FILE_PATH=0` narrows it, and an env `1` cannot widen ordinary/sandbox permissions. Config corruption or unreadability fails closed. Canonical names and legacy aliases have the documented process/`bot.env`/legacy-file precedence. Native callbacks are bound to the authorized conversation; pre-start callbacks are buffered until the correlated start response proves turn ownership. Muted jobs cannot publish.
- Native App uploads return definite failure before publication; ambiguous publish acknowledgements remain uncertain and cannot be replayed by changing call IDs within that user turn. Attachment replies retain their source message association.
- Claude SDK App tools use a private 0600 configuration and existing stdio control channel, with no network listener. Full foreground tool-use identity/name/arguments must match the active turn and SDK call metadata; partial/subagent/background/stale calls cannot borrow the recipient. Installed-name permission exemption is not delivery authorization. Control/MCP cancellation and turn completion revoke execution; only real upload responses refresh inactivity. A failed handshake can fall back only before the user prompt, scoped to that worker, without replaying model work.
- DeepSeek App tools are registered only on the native agent and route through dedicated inherited process pipes. The native user prompt ID, open turn/step, tool identity/arguments and PTC ancestry must match a live parent-owned App grant. Policy/context notices are not task origins. Subagents, goals, stale calls and cross-session grants are denied. The private plugin owns/closes its handles, removes its launch marker and unregisters on pipe teardown. This is not an OS isolation boundary against arbitrary same-user code; Linux child-handle inheritance, Windows and other Harness versions remain unverified. See [contract and acceptance limits](client/deepseek-native-app-tools.md).

### Residual risk

- the engine can still read and exfiltrate any file that is already readable inside the allowed workspace tree
- `/resume` intentionally widens the file-delivery root to a real project directory
- Full access intentionally allows readable external ordinary files to be sent; the owner requested this default. This is not an OS sandbox or permission to read otherwise inaccessible files. Every new send checks current saved permissions; a durable replay returns the existing receipt and does not publish again. Env loaded by a worker requires an idle restart after edits. Native tool schemas v1/v2 remain exact for resume, while new v3 descriptions explain the broader policy.
- Users should assume that authorizing a Bot on a project allows ordinary project artifacts to be delivered to the authorized App conversation (or the explicitly configured optional adapter). Known-name credential filtering is not an OS sandbox or content DLP.

### Design rule

Any change touching file extraction, `[tool:]` send tags, legacy `[send-file:]`, `/resume`, workspace roots, or canonical path checks requires explicit security review and regression tests.

## 5. Per-Instance State Boundary

Each instance has a private state root under `~/.cctb/<instance>/`.

### Trusted

- owner-only structured state files created by the bridge
- append-only operational logs written by the local service

### Untrusted

- malformed or manually edited state files
- partial operational artifacts
- restored archives from unknown provenance

### Current enforcement

- structured state uses atomic temp-file + rename writes
- private state is written with owner-only permissions
- corrupt JSON state can be quarantined rather than silently overwritten
- read-modify-write and quarantine/reset recovery paths use the same cross-process file mutex, preventing a repair from renaming a newer concurrent write
- restore logic preserves private permissions on sensitive state
- backup creation and restore stream file bodies and enforce file-count, compressed-size, expanded-size, and per-file bounds before untrusted archives can exhaust memory or disk
- lock files and runtime metadata are kept separate from authoritative config/state

### Residual risk

- some operational files remain best-effort rather than transactional
- malformed optional config may still trigger fallback behavior instead of hard failure
- durable planning state in `kanban.sqlite`, its retained `board.json` migration backups, exports, and `kanban-assets/` may contain task intent, summaries, chat IDs, user IDs, topic IDs, and local paths; known credential patterns are redacted before Board persistence and export, but the entire boundary remains high sensitivity
- state consistency bugs are more likely to be logic regressions than raw permission bugs now

### Design rule

When adding a new state file, define up front:

- whether it is authoritative or derived
- who owns writes
- whether writes must be serialized
- what recovery behavior is allowed
- whether the file is credential-bearing or privacy-sensitive

## 6. Shared Or Linked Engine-Home Boundary

The bot no longer has a fully isolated engine-global home.

### Trusted

- the operator's own Claude/Codex/Kimi/DeepSeek CLI environment
- the real `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`, or `DSH_HOME` selected by the parent process

### Untrusted

- any assumption that bot isolation fully contains engine-global side effects
- any feature that writes engine-global settings, caches, MCP config, plugin state, or auth artifacts

### Current enforcement

- [src/core/engine-factory.ts](../src/core/engine-factory.ts) intentionally inherits the real Claude/Codex config home instead of forcing a per-instance engine home
- Kimi retains its native user-level home; DeepSeek receives a private writable home but links authenticated credentials/profiles from the selected shared `DSH_HOME` and copies mutable settings
- workspace paths remain per-instance, so normal conversation history stays split by workspace in practice
- legacy Claude project files are migrated into the shared config home so upgrades do not silently drop prior history

### Residual risk

- blast radius is wider than the per-instance state directory
- a bot running in `full-auto` or `bypass` mode can affect engine-global state shared with the user's main CLI
- this is a deliberate trade-off to avoid auth-refresh token races, not a free isolation win

### Design rule

Any feature that touches provider config roots should document whether it is:

- per-instance state
- per-workspace state
- shared engine-global state

Do not describe the system as "fully isolated" without qualifying this boundary.

## 7. Engine Process Boundary

The provider CLI is not a pure function. It is a privileged local subprocess with filesystem and config side effects.

### Trusted

- adapter-level protocol handling
- explicit bridge instructions injected by the runtime

### Untrusted

- provider CLI output shape
- provider auth/session expiry behavior
- any tool or plugin execution performed by the engine

### Current enforcement

- adapter interfaces keep provider-specific parsing contained
- runtime normalizes auth errors, session handling, and usage accounting above the adapter layer
- [App instructions](../src/gateway/agent-instructions.ts) define native question, artifact-delivery and compatibility contracts for the current engine capabilities
- Engine approval handling follows the configured permission mode and the scoped App approval path; per-turn tool bridges authenticate their callers, but are not an isolation boundary against same-user process inspection

### Residual risk

- provider behavior can change underneath the bridge
- same-user local processes may inspect provider CLI command lines, including transient MCP config used for Claude approvals
- array/object output formats, auth-expiry paths, and session-rebind semantics need regression coverage
- bugs at this layer usually become product-level reliability issues quickly

### Design rule

Provider integration changes are boundary changes. Treat them as such even when the patch looks like "just parsing".

## Operational Rules

These rules are the shortest useful version of the security model.

- Network input is untrusted until device authentication and the relevant Host authorization pass.
- Bus is privileged local control-plane traffic, not a convenience API.
- Native artifact tools and compatibility `[send-file:]` directives share the configured file-delivery policy; known credential paths remain denied even when external paths are allowed.
- `/resume` intentionally expands the workspace trust boundary to a real project root.
- `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are shared-engine boundaries, not per-instance boundaries.
- Sensitive state belongs under the instance state root with owner-only permissions.
- Cross-entry behavior must stay aligned across App/Gateway, headless CLI, optional Bus and other shared-core entry points.

## Review Checklist For Future Changes

Use this checklist when reviewing changes in security-sensitive areas.

### Access and entry points

- Does the new path enforce the relevant device trust, role and membership checks, including after waits?
- If it is bus-only, is the bus boundary still authenticated before `chatType === "bus"` is trusted?

### File handling

- Can model output cause the bridge to read or send a new class of local file?
- Are canonical path checks still in place after symlink resolution?
- Are rejection cases visible to the user and test-covered?

### State

- Is the new file authoritative or derived?
- Are writes atomic and, if needed, serialized?
- Are private files still private after backup/restore/migration?

### Engine integration

- Does the change widen shared engine-home side effects?
- Does it preserve auth-expiry, session-rebind, and malformed-output behavior?

### Cross-entry consistency

- Do App/Gateway, headless CLI, optional Bus and other entry points still share the same accounting, audit, and access rules?

## Next Hardening Work

The project does not need a giant security rewrite. It does need discipline around a few seams.

Most valuable next steps:

1. Keep shrinking cross-entry drift by centralizing usage, budget, audit, and post-turn bookkeeping.
2. Maintain regression tests around file delivery, `/resume`, bus auth, and provider output parsing.
3. Keep security assumptions documented when changing shared engine-home behavior.
4. Prefer adding narrow shared helpers over duplicating boundary logic in command-specific flows.

## Client diagnostics boundary

`/api/ops/audit` and `/api/bots/<id>/diagnostics` require a currently authenticated
owner device. Hub verifies the registered Bot before forwarding a query. Gateway
reads its own state directory; Hub may directly read only a managed Bot's generated
directory, including while its worker is stopped. Requests select audit/timeline
and validated filters, never a filesystem path or arbitrary RPC method. These
endpoints do not modify log bodies, start engines or restart services.

Bot readers open only the fixed current/retained-rotation filenames, reject child
symlinks and nonregular files, and parse bounded 64 KiB chunks with a 256 KiB line
ceiling. Original event schemas validate each record. Shared secret redaction is
applied again before display and search; details/metadata are shortened only after
redaction, with a visible truncation marker. A page contains at most 50 records.
Malformed, oversized and incomplete records produce notices rather than silently
becoming successful events. These logs still contain owner-visible operational
identifiers and paths and must not be exposed to ordinary members.

Pagination uses file identity, byte position and record content for Bot cursors,
and fixed audit row IDs for Hub cursors. Missing anchors explicitly expire instead
of silently restarting pagination. Hub reads use a fixed upper row ID and release
the database queue between batches. Audit event names/explicit outcomes classify
known results; unclassified Hub entries are informational, never assumed successes.

## Large Gateway reply recovery bodies

Only the Gateway final/background delivery path explicitly opts into responses
above the legacy inline ledger ceiling, and only for `channel=lark`, `gw_` targets.
Bodies are internal state, never client-supplied attachment paths or download URLs.
The ledger stores a strict hash/byte-count reference; resolution derives one fixed
filename under the instance-owned `delivery-bodies` directory, rejects directory
and file symlinks/nonregular files, and verifies exact size, checksum and content
shape. A missing/corrupt body records a recovery failure instead of sending an
empty replacement or success notice. Recovery still applies workspace/credential
artifact guards and strips side-effect commands before delivery.

Writes/collection share the index mutex, and body data is synced before its
reference is committed. Garbage collection handles only recognized regular
body/temp names, keeps all retained references and young crash orphans, and never
follows links. Metadata-only operations do not load all large bodies. The existing
attempt, age and index-retention bounds and ambiguous-send marker still apply;
this does not promise exactly-once delivery across every process failure.

## Client Bot dashboard boundary

`/api/bots/<id>/dashboard` is read-only, requires a currently authenticated owner,
and rejects query parameters, unregistered Bots and arbitrary filesystem paths.
Online data comes from the authenticated Gateway. Hub may fall back to only its
own managed Bot directory; external offline Bots return unavailable. Runtime
activity is sampled from in-memory maps, never inferred from persisted running
flags. The response includes sampling/read times and distinguishes saved records.

Dashboard state uses original schemas and fixed filenames, at most 16 MiB per
regular file, with child symlinks and newer unsupported schema versions rejected.
The crew directory itself cannot be a symlink. Unreadable/oversized state produces
notices; viewing does not mkdir, quarantine, repair or rewrite it. A validated
usage last-good file can be shown with explicit provenance. Outbound fields are
allowlisted and display text uses shared secret redaction before shortening;
credentials, tool inputs and complete crew research/output payloads are omitted.
The ordinary `/api/ops` usage view now uses the same read-only projection.

## Client file-center boundary

All `/api/files` routes first authenticate the current device and then require the
Hub owner. Revoked devices and ordinary members cannot read paths or annotations,
start/cancel scans, edit labels or request Finder reveal. Metadata includes local
paths and filenames, so it is owner data even though no file contents are returned.

Roots come only from registered Bots: managed Bots use their Hub-owned state path;
other Bots report their state directory over authenticated local Gateway RPC.
Offline or incompatible attached workers produce warnings rather than broadening
discovery to every local instance. The shared scanner reads configured workspace,
inbox and ASR roots, deduplicates identical canonical roots, and does not descend
through child symlinks. This retains the original Console's classification and
credential-protection evidence, including after manual relabeling.

Client label/reveal requests use validated known unit IDs, never arbitrary paths.
Reveal enumerates current registered roots again before passing a target as an
argument to macOS `open -R`; stale cached inventory alone cannot authorize it.
The UI identifies this as a request on the Hub computer. Successful command exit
is not proof that a person saw Finder. There is no file-content download, deletion
or content-write operation in this API; only the private Hub annotation file changes.
Optimistic revisions reject concurrent overwrite, malformed authoritative label
state fails closed, and audit entries contain unit IDs rather than note bodies.

## Client-created Bot boundary

Gateway commands and configuration cards use Hub device/membership authorization.
Group reply policy is stored under the Bot's `gw_` conversation ID. Unsupported
legacy transport-management commands direct the user to the current App surface;
no retired adapter is started. Recovery selects the App destination before
claiming a ledger row, retains artifact preflight and strips non-delivery side
effects from recovered text. Historical channel/routing fields remain readable
for compatibility; they must not redirect an App reply to a retired transport.

Only an authenticated Hub owner may read the local engine catalog or create a
Bot. Requests use strict schemas, existing effort/model compatibility checks and
owner-scoped idempotency receipts. A generated Bot ID chooses a directory under
the Hub; display names never become paths or shell arguments. The owner may
select an existing absolute workspace on the Hub computer. This grants that Bot
the same local engine capabilities and approval policy as an ordinary TaroBot
instance. Engine commands are taken from local configuration, never request data.

The Hub forks an allowlisted entrypoint with an argument array, keeps Gateway
secrets on disk with mode 0600, and exposes only Bot metadata. Child diagnostics
are redacted and bounded. Worker restart targets only that managed child and
waits for its active work and pending approvals to finish. Creation does not
reconfigure, restart, or enroll any pre-existing Feishu/Telegram instance.
The managed restart route retains owner/device authorization and validates the
receipt ID. Its durable receipt path is computed under the Hub; callers never
supply a filesystem path. Only a validated IPC acknowledgment matching both a
fresh request ID and the managed child PID reports a queued restart. IPC send
completion alone is insufficient. A timeout remains uncertain, and replay of
that operation ID never repeats the side effect, including after Hub restore.
Topic creation requires membership in a nonarchived root group and inherits
only that group's Bots and members.

The authenticated `turn.stop` priority path repeats session validation and the
ordinary conversation membership check before dispatch. A supplied Bot must be
a member of that conversation. It bypasses unrelated RPC waits, not pairing,
expiry, revocation or scope checks. Group controls fan out independently so one
offline Bot cannot shield other active workers from cancellation. Only validated
`stopped` results count as confirmed; partial failures remain visible and audited.
The shared cancellation helper is called only after each surface's authorization
gate; it targets that conversation's active controller and pending burst, never
the whole Bot, another topic, or its pending FIFO turns.

Full Hub state backup/restore is a local CLI boundary in `hub/state-backup.ts`.
It requires stopped Hub/worker instance locks, preserves Hub identity and private
credentials, and never stops an existing service. Bundles must be trusted: hashes
detect damaged bodies but are not a signature authenticating the manifest. The
validated manifest bounds entries/bytes, rejects traversal and duplicate/colliding
paths, and allows symlinks only as workspace leaf metadata. No copy follows a
symlink; restore writes regular files first and never writes to link targets.
Restore requires the absent original Hub path, owner-only files/directories and
successful SQLite/key/attachment validation before removing its incomplete marker.
Original state and existing backup/destination directories are not overwritten.
External projects, environment/shared credentials and engine-native histories
are not swept into the bundle; the operations guide distinguishes those dependencies.

### Independent history search

The search endpoint validates query length (at most 256 UTF-16 code units, no
NUL), ID syntax, safe integral timestamps, inclusive date ordering and a boolean
file filter. Invalid input returns 400 instead of silent truncation. Query text
is bound as SQL parameters and never evaluated as FTS MATCH or SQL syntax.
A separate readonly search connection checks conversation membership in its
SELECT; the HTTP route revalidates the requesting device session after the query
completes, preventing delivery to a device revoked while the read was queued.
Only attachments in message blocks count for the file filter; link-preview
covers do not. Failed readers close before subsequent searches continue.

## Incremental engine presentation

Claude partial text/thinking uses the same control-frame sanitizer as completed
messages. An incomplete line-anchored internal frame or opening tag is withheld
until classified; fenced literal examples remain readable. Child partial events
and background-task notification partials do not enter the foreground stream.
Completed assistant blocks reconcile already displayed prefixes.

Harness 0.2 assistant frames and compact reconnect baselines are schema-validated
at the protocol boundary. Their revisions/indexes are process-local, never
durable journal sequence numbers. Replay is ignored; a gap stops speculative
concatenation until a fresh attempt/baseline or authoritative final message.
Only an existing durable turn claim may own a transient prefix, so a late
cancelled attempt cannot acquire a replacement foreground or Goal claim.

The private Node DSH Host now receives a parent-lifetime preload only in its
spawn environment. It removes the activation marker before tool startup, signals
only its own PID after parent death, and escalates after one second if needed.
It never searches for or terminates unrelated Hosts. This prevents an orphaned
Host from keeping the resumed session's native write handle indefinitely.

## Private GitHub application updates

The desktop-only GitHub update provider owns its repository, OAuth client ID,
signing key and GitHub endpoints in native/build configuration. The renderer
cannot choose a repository, asset URL, bearer token, signing key or executable.
Device codes and access tokens stay native; the OS credential entry is scoped
to the configured repository/client ID and is distinct from host device keys.
OAuth's private-repository scope is `repo`, although updater requests are read-only.

Login polling, keychain completion, logout, checks and installation use generation
and offer IDs so late work cannot revive a cancelled login or install under a
different account. Sign-out deletes the local credential/offer; GitHub's upstream
OAuth grant is separately managed by the account owner. JSON API/prefetch reads
are bounded; upstream updater buffering is an acceptance-bound limitation.

Only a stable Windows release's manifest and installer asset IDs in the native
repository are accepted. GitHub download redirects retain OS TLS verification
and strip bearer credentials on cross-origin redirects. Tauri validates the
pinned artifact signature and signed version with downgrades disabled, then the
user's explicit install action invokes the existing passive updater. Host and
network membership authorization are not changed by GitHub authentication.

The release workflow's signing key and write-scoped publication token never ship
with the App. Publication requires an explicitly selected signed build, passed
installer gates, a private repository, verified artifact/global-comment signatures,
and exact source-commit/release/asset identities. Draft uploads/publication are
bound to one numeric release ID, with remote digests checked before publishing.
No public repository or live updater is configured by source development.

macOS and Windows package preparation removes updater signing key, key-path and
password variables from frontend/host/dependency subprocesses. The final Tauri
step skips the already-completed frontend build hook, and unsigned builds also
remove these variables from that step. Explicit signed builds still trust the
final Tauri/Rust/signing toolchain; this is reduced credential exposure, not an
isolated signing-job guarantee.

## Run detail boundary

`run.write` requires an authenticated Bot belonging to the conversation and cannot overwrite another Bot's message/journal. Details are only readable after a canonical message references that run. The HTTP reader requires a paired device, verifies conversation membership and canonical run identity, and revalidates the session before sending. Forwarding removes run references; recall removes journal data. CLI paths are display-only; no file is opened from an event. Artifact previews use actual published attachment IDs with existing download authorization. Raw public output can contain user data: it is bounded, copied/exported only by explicit UI actions, and follows the documented live-database and backup retention policies.

## Private-network directory synchronization

Public `network/enroll` is a signed-directory delivery/recovery endpoint, not an
authenticated current-directory reader. Its membership response echoes the exact
signed directory supplied by the caller; it cannot disclose members added since
that snapshot. Current membership requires authenticated owner access or signed
peer synchronization. Signature, target and replacement checks still apply.

Authority reconciliation preserves the pure merge's irreversible revocations and
conflict tombstones. Mutable host names/routes come from the newer signed directory,
with the trusted local directory winning equal-revision forks. A directly signed
peer publication remains an authoritative descriptor update. Expired pairing
reservations do not block imports; live different-key reservations still do.
Revoked imported device keys are not silently reactivated in a new network.
Shared route and transport guards reject loopback/unspecified IPv4 and IPv6,
including IPv4-mapped forms; this does not replace TLS and host-identity checks.
Host-to-Host directory synchronization also verifies the peer's signed TLS
identity against the observed leaf certificate, then pins that leaf before
sending membership metadata. A TLS-terminating relay cannot substitute its own
valid certificate and forward the peer's identity proof. Pins are bounded and
expire after five minutes; certificate rotation requires a fresh proof.

## Cross-host Bot messages

The [Bot message MVP](client/cross-host-bot-messages-2026-10-17.md) does not widen Agent Bus. Network membership alone grants no Bot messaging access. Recipient-local grants bind a source Hub key and source Bot to a target Bot; owner grant/revoke operations require an enrolled loopback controller plus a fresh, one-use device signature over the command digest. Gateway instance credentials cannot grant access.

Short-lived Hub-signed passports bind the target identity, source Bot, hop count, method/path and body digest. Normal TLS validation, a proof bound to the observed TLS leaf, and a signed recipient challenge precede private transfer. Subsequent TLS handshakes check the proved certificate before sending headers or bodies. A cached certificate mismatch permits one fresh proof, not replay of an ambiguously delivered POST. Target-side writer guards and response guards recheck membership, grant and Bot revocation. Responses/files are limited to the sending Bot's own correlated request, not arbitrary conversation history. Uploads use existing HubAttachments APIs with additional source/conversation binding. Lost POST responses are never automatically retried on another route. Request digests, rate limits and queue admission are durable; botSource inputs never enter question/approval/control handlers. The same-OS-user trust limitation remains unchanged.


### Engine approval ownership (2026-10-19)

Normal Codex turns keep native `on-request` approval policy even when a caller
has no approval UI; such native requests are declined, never silently promoted
to the explicit full-access policy. Claude child tool approvals may use only
the currently live owning turn's approval handler. Stale/ambiguous child scopes
and child access to the parent's App tools remain rejected. DeepSeek session
consent is keyed to the exact tool name and canonical tool input; a missing
native call record cannot create a reusable grant. CLI and App share these
adapter checks.

The supported fallback Claude process adapter writes its permission-MCP
configuration, including the short-lived loopback capability URL, to a private
0600 temporary file and removes it after the turn. Process arguments contain
only the file path. This does not provide isolation from arbitrary code running
as the same OS user.

## Readonly workspace diff boundary

The `workspace.diff.v1` routes additionally require owner status, conversation
membership and the exact Bot's membership before and after bounded filesystem/Git
work. They expose only the configured Bot workspace's current changed paths,
never an arbitrary path or historical repository search. Credential paths,
symlinks/special files, executable Git filters and unsafe repository metadata
are denied. No index/worktree writes, network fetch or shell command assembly
are part of the API. Admission, deadlines and byte/row caps are documented in
[the diff viewer design](client/diff-viewer-2026-10-19.md).

Readonly Git is not an OS sandbox against a malicious concurrent host writer;
static path/link rejection and fd/parent identity rechecks have that explicit
limit. Desktop review drafts are private, pairing/conversation/Bot-scoped client
records. Sending deliberately places bounded code excerpts and comments into an
ordinary user message visible to that conversation's members. Atomic pending +
outbox storage and accepted-message ACK cleanup prevent draft loss; this does
not add an engine command or broaden Bot access.


## Local ASR setup

The `integrations.asr.v1` Hub endpoints require an authenticated host owner,
revalidate before installation starts and accept only a strict request ID/model/service
schema. They run the packaged installer, never a caller-supplied command or path.
Jobs and local installation locks are account-scoped, shared with the headless CLI.
Local ASR listens only on loopback and offers no shutdown endpoint. Its private
status excludes audio paths/transcripts. Installation/model state is private OS-user
state; a same-user full-access Bot can already run owner CLI commands and is not
isolated by this HTTP authorization boundary. See the Qwen integration README.


## Shared transcription cache

The Gateway passes a reuse identity only after existing message/resource
membership checks and downloading the attachment. The host-local transcript cache
is keyed by conversation, attachment, actual byte digest and effective routing
configuration. It never grants resource access or reads adapter credentials.
Within the authorized TaroBot code paths, a different conversation, attachment
or effective route cannot hit that cache entry. Private directory checks and
no-follow bounded reads reject unsafe filesystem entries. This is not isolation
from processes running as the same OS user: those processes, including full-access
Bots, can read or modify the plaintext cache, as they can existing Host state. This shares
successful speech output across authorized Bot workers, not model prompts or
responses. See the state model for retention and cancellation limits.

## Interactive widget guest

The HTML viewer sits inside two opaque sandbox frames without host/native
authority; authored scripts now execute in a dedicated Worker. The relay accepts only bounded, source/key-bound presentation messages.
The guest CSP blocks ordinary fetch/WebSocket and external-resource requests;
the trusted bootstrap separately removes WebRTC constructors because CSP does
not prevent STUN/UDP. Chromium and WebKit tests use a loopback UDP listener to
verify initial viewing/reload and reject constructor restoration. This is not
an exhaustive guarantee against browser networking side channels (DNS prefetch
is not verified). Repeated runtime errors retire execution and retain a text summary; incidental
errors leave the useful report interactive.
The former shared-thread reader left synchronous CPU loops uncontained. The
following implementation replaces that execution path; see the historical
[three-day review](audits/2026-10-22-three-day-joint-review.md) for the reproduced baseline.

### Worker execution and fixed reports (2026-10-22 follow-up)

Typed report cells are rendered as text by App-owned components, with no generated
script execution. Custom HTML uses a dedicated Worker plus a trusted sanitized
DOM renderer; it no longer executes authored JavaScript in the view thread.
Blob Workers inherit the opaque sandbox CSP. Network/RTC/nested-worker/native
capabilities are unavailable; the main App CSP is unchanged. Size, message-rate,
error and heartbeat guards bound the supported pipeline. This is not an OS
process or memory quota; CSS/browser resource exhaustion remains outside the
JavaScript-thread guarantee. Older clients retain their old reader. See the
[precise protocol and acceptance boundaries](client/inline-widgets-cpu-containment-2026-10-22.md).


### Widget-to-composer handoff

The general widget interaction path allows a narrowly scoped, user-activated
`tarobot.prompt.compose(text)` request. It prepares text in the message owner's
current conversation composer; it never calls a Host operation or sends a
message. The trusted viewer validates a one-use real-gesture capability before
forwarding bounded text through the source/key-checked relay. The App rechecks
frame activity, current conversation and composer readiness. Draft text is
appended; files, quotation and queue/steering choice are not replaced. Requests
from synthetic events, automatic scripts, hidden frames or expired lifetimes
must not authorize an insertion. A returned true is only an insertion receipt.
See [the contract and verification](client/interactive-widgets-2026-10-25.md).
