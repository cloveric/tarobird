# Private network of TaroBot hosts

A desktop has two roles at once: it runs a named local host and controls the other hosts it has joined. The computer joins with its own Bots, or with no Bots yet. A phone is an independent network controller, not a possession of the host it first scanned. Bots, workspaces, conversations, attachments and execution remain on their owning host; the network shares membership and connection information, not their databases.

## Installers

[Android, macOS and Windows 1.0.65](release-1.0.65-2026-10-13.md) package this network model, independent phone membership and optional sidebar host grouping. Update all participating desktops and the phone; independently managed Hubs need host 0.1.416 or later. Package validation is recorded separately from the implementation and physical-device acceptance below.

## Setup and daily use

1. On a new desktop, name the computer. Starting a local network prepares its host and paired local controller. Choosing an existing network also prepares the local host before opening remote pairing; returning to the start screen retains that identity.
2. Pair with a network host using connection information copied from an already paired phone or computer, or scan/import its QR code. The paired phone can confirm the new computer’s eight-digit code under **Me → Devices & security → Confirm a new device**, so the operator does not need to return to the host. On another desktop, open **My network** and confirm adding its local host to the network. The confirmation shows the two hosts and the network being joined. A phone does not add a host.
3. Hosts need shared, reachable HTTPS routes. Explicitly opening LAN/Tailscale pairing publishes the selected connection route after the local host reconnects. LAN invites retain an existing Tailscale route and any VPS routes. Existing direct/Tailscale/VPS routes can be reviewed and shared in My network. Loopback addresses are never advertised. Joining does not silently open listeners or change firewalls.
4. Authorized controllers discover other active hosts and create an independent device identity for each. Online hosts become available together in the sidebar and mobile lists. Source-host badges appear on the right. Generic Bot creation offers a host selector when multiple hosts are present; offline hosts cannot receive creation requests. A group currently contains Bots from its own host.
5. Host names are authoritative on the host and synchronize to other connected devices. The old connection manager remains available for route settings and removal of a connection from this device.
6. When another computer changes a paired host's network, this device shows a review notice. Confirm the new network and its authorized devices before automatic discovery resumes. Existing pairing, cached conversations and unsent drafts remain intact. A verified cached directory is still visible when starting offline.

Existing individually paired hosts, conversations, native keys and drafts are retained. They are not silently merged into a network. Older servers continue to support individual pairing; network actions require the `private-network.v2` capability. Version 1 signed directories remain readable without rewriting their signatures. The coordinator publishes version 2 only after every active host has provided signed confirmation of version 2 support. During a mixed-version upgrade, departure is blocked with an upgrade prompt rather than applying incompatible device ownership rules. Upgrade all hosts before changing membership.

## Availability and trust

The first host coordinates membership. It signs the network directory; it does not proxy conversations or execution. Coordinator transfer is not implemented: this host cannot leave while other active members or unexpired pending joins remain. Resolve those memberships before dissolving its network. Already enrolled devices can continue talking directly to another online host while the coordinator is offline. New joins, new automatic device enrollment and globally confirmed membership changes require the coordinator to be reachable. A directory's last synchronization time does not prove that an offline peer has received every revocation.

Joining is an administrative trust decision: authorized owner devices can access the network's hosts. Each target receives a distinct device key; no device private key is copied between hosts. Every owner-initiated network mutation requires a fresh device signature bound to the target host, current session and canonical command digest. A host signature alone cannot attest an arbitrary device into an existing member's identity.

The authority admits a proposed host as **pending**. It becomes usable only after that host commits its matching, unexpired proposal. Pending hosts are not discovery or authorization targets. Canceling a pending join requires the coordinator to confirm the same proposal; it cannot silently become removal of an active host. Expired or canceled proposals can be retried with a fresh nonce. The client saves the public signed join stages so closing the dialog or losing a response can resume the same attempt. Confirming stale membership requires reviewing it again.

The signed directory binds its ID to the authority key and a genesis nonce. Devices pin both values. Host/device provenance, member revocations, blocked device-key hashes and canceled proposal nonces are retained during backup recovery. The coordinator merges previously signed directory branches conservatively, including branches below its current revision; an old backup cannot erase known revocations. A client retains its latest signed directory and can return it to a restored host. Older signed directories are verified unchanged before their recovery records are merged.

Removing an active host permanently revokes that host identity within the network. Rejoining that network requires a new host identity; the confirmation explains this before proceeding. Controllers that receive the update stop all former network connections to that destination, including the original direct pairing, while retaining cached history. Offline peers may take time to receive the removal. The departing computer keeps its Bots, conversations, files and trusted local desktop controller. Its previous remote devices lose access and must complete a fresh pairing to access it again. A new phone can pair with this standalone computer without joining the old network. Removing only a local connection does not revoke its remote authorization, and a dismissal marker prevents automatic discovery from immediately recreating it.

An active host's voluntary departure also requires coordinator confirmation and revokes the same derived authorizations. A failed connection leaves the departure unfinished rather than reporting success locally. A removed host can poll for its signed removal snapshot to revoke imported keys; it cannot obtain members added after its removal. Recreating a different network retains its trusted local controller and newly paired devices without restoring former network authorizations.

## A computer leaves; phones remain

For a network of A, B and C, leaving C removes C and its Bots from the network's active lists. Phones keep their authorizations to A and B even if they first paired with C; the computer's own local controller loses its derived access to A and B. C's data does not migrate or disappear. Past messages and unsent drafts in a disconnected controller's cache remain available as history, but cannot be sent to C using the old authorization.

Signed device bindings distinguish a host controller from a network controller. A host controller is identified by its exact device key enrolled through trusted local desktop IPC, not by a self-reported platform or name. Other paired owners become network controllers. Derived per-host keys retain the source member's scope. Existing signed bindings without a scope keep their legacy meaning until the originating host publishes the verified scope; explicit scopes cannot silently change and revoked keys cannot become active again.

Before voluntary departure, every independent device on the departing host must have an active authorization on at least one remaining host; legacy unclassified devices must first reconnect or complete native identity migration. Otherwise departure is refused with instructions to open the phone app and connect to another host. An administrator can still forcibly remove a host. Dissolving the last host requires its trusted local desktop controller; a phone cannot accidentally remove its own only access path.

The departing host revokes its previous non-local device authorizations, sessions and push deliveries and clears unfinished pairing requests. This is a one-time retirement boundary for that network, so later pairing a new phone is not undone by a repeated removal snapshot. A successful departure receipt is verified even when the initiating remote connection is revoked as part of leaving. A failed request never reports a completed departure.

## Implementation and verification surfaces

- `src/client-protocol/private-network.ts`: canonical signed schema and limits.
- `src/hub/private-network.ts`: coordinator membership, pending admission/commit, provenance, recovery and revocation.
- `src/hub/network-peer.ts`: bounded HTTPS peer transport with CA/hostname checks and authority pinning.
- `src/hub/host-profile.ts`: revisioned shared host names.
- `client/src/network-sync.ts`: app-owned discovery, per-host enrollment and directory delivery.
- `client/src/network-identity.ts`, `storage.ts`: client signature/genesis/pin checks and durable monotonic directory storage.
- `client/src/NetworkManager.tsx`, `network-join.ts`: explicit membership review and resumable join stages.
- `client/src/HostApp.tsx`, `host-connections.ts`, `host-registry.ts`: independent connection lifetimes, isolated caches and host routing.

Focused gates cover protocol/authentication, actual TLS peer transport, three independent stores, browser IndexedDB, onboarding and desktop/mobile layouts. The browser journey uses three disposable HTTPS Hubs, one approved device and ordinary App controls. Native device-action vectors cover Rust, Android JVM and Swift. Physical Android/Windows/Mac cross-machine operation and the operator's VPS route require separate acceptance; browser tests are not evidence of those environments.

### Initial network implementation acceptance, 2026-10-13

- Design discussion and independent source reviews used Claude Opus 5.5 with xhigh effort. Review findings drove regressions for forwarded device proofs, late responses, active departure, clock skew, revocation delivery and backup recovery.
- Root suite: 240 files, 3,037 passed and one skipped. A final focused run of desktop startup, membership and real TLS lifecycle checks passed all 42 cases.
- Chromium and WebKit each passed three real-Hub journeys: three-host discovery/control with an offline coordinator; reviewed cross-device network changes with intact drafts; replacement of an unfinished old-network candidate after the target confirms its new network.
- Network UI, cached membership/recovery, first-start naming and narrow source badges were checked in both engines. Rust, Android JVM and Swift command-signing checks passed; these exercise the proof implementation, not device installation or native keystore acceptance.
- The 43 existing pairing, multi-host, settings and mobile interaction cases obtained passing Chromium and WebKit results after updating navigation to My network. Regression checks found and fixed a leftover connection dialog after abandoning first pairing. Client translation, TypeScript and production build checks passed.
- The reviewed network-change journey also checks real desktop and phone geometry with the notice visible: header, notice and content stay in order, the composer and mobile navigation remain inside the viewport, only the active page renders the notice, and returning to chat preserves its draft.
- No production host, user Bot, installed app or VPS configuration was changed for this validation. New release packages and physical multi-device/VPS acceptance remain separate gates.

### Independent phone membership refinement, 2026-10-13

- Opus 5.5 xhigh reviewed the departure design. The review led to version-gated scope migration, an exact native keychain identity check, one-time local access retirement and a narrow signed-receipt path for a phone that initiates its own revocation.
- The complete root suite passed: 240 files, 3,052 tests passed and one skipped. The production root build passed. All 30 Rust main-binary tests passed, including wrong-key and mismatched-identity rejection for the native controller bridge.
- Real HTTPS/WSS lifecycle and network HTTP checks passed 14 cases. They include a phone first paired to A or C, continued A/B message round trips and Bot creation, expired access to C, socket/push cleanup, a retained native C controller and a freshly paired standalone C phone.
- Chromium and WebKit each passed all four disposable real-Hub journeys, including departure, read-only cached C history, retained drafts and explicit fresh pairing. The 16 network-manager/onboarding cases also passed in both engines. Screenshots of the confirmation and remaining mobile host list were inspected after transitions completed.
- Cached network membership and native-startup recovery passed 27 cases in each browser engine, including unavailable Keychain/native APIs, remote-host continuity, retry with the original identity and draft, and rejection of higher-counter protocol/scope rollbacks. Client translation, TypeScript and production build checks passed.
- These are implementation and simulated-client checks. No installed Mac, Android or Windows app, live user Bot or VPS route was modified or accepted as part of this refinement.
