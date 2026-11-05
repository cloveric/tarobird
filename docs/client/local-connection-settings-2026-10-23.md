# Local access settings and paired-device reconnect

The connection page previously reused the new-device invitation wizard. Its
Tailscale instructions mixed enabling a listener, pairing a new device, route
synchronization and repairing an existing device. A paired user could reasonably
conclude that switching networks required another pairing ceremony.

## Presentation and shared operations

`ConnectionPanel` now opens `LocalConnectionSettings`: LAN and Tailscale each
show an independently read host-side state. Choosing a card is read-only; an
explicit enable/reprepare action is needed to configure its listener. A ready
listener offers a read-only status refresh. Connection QR codes remain in Add
device, and route repair keeps its existing entry point.

The main view contains the reconnect explanation, the two methods and one
primary operation. Detailed pairing/recovery explanations and addresses are
collapsed. “Ready on this host” does not claim that another device's VPN,
access policy or end-to-end path is working.

`useDesktopHostAccess` preserves the native local-host identity check and the
existing listener/publication path used by `DesktopHostInvite`. All methods
retain the same host identity, TLS authority and existing routes. The parent
connection dialog and its child both block closing while setup/publication is
pending. Status reads are owner-only, capability-gated, abortable, bounded to
8 seconds and checked against the selected host key. Failed reads, old hosts
and disconnected endpoints do not report readiness. Opening the page never
opens a listener or generates a QR.

## Reconnection contract

Tailscale provides connectivity, not TaroBot membership. A new device still
needs its initial TaroBot authorization even if it is already in the tailnet.
An existing paired device retains that authorization when switching between
saved LAN, Tailscale and relay routes. Both devices must be online and the
Tailscale policy must allow the connection; the host's TaroBot Tailscale
listener must also be enabled.

Current owner clients learn new host addresses while an existing authenticated
route works, on reconnect/visibility and the existing bounded refresh loop.
This is not immediate discovery of every machine in a tailnet. If every saved
route is already unreachable before a new address was learned, or the device
has the member role, scan to repair the address while retaining pairing.
See [route synchronization](tailscale-route-sync-2026-10-21.md) for exact
refresh, capacity, trust and manual-route preservation rules.

## CLI and adapters

Presentation uses existing APIs/native actions, with no new protocol, persisted
state, membership rule or engine behavior. All five engines are unaffected.
`tarobot pair --lan/--tailscale` and `network local --tailscale` retain their
shared headless operations; the CLI still does not require a desktop window.

A real local CLI diagnostic exposed a separate parsing bug: a signed-out
Tailscale node can return `Self.TailscaleIPs: null`. The diagnostic now accepts
that valid empty state and reports `NeedsLogin` / `online:false`,
instead of `invalid`. No peer data, auth URL or private tailnet metadata enters
the diagnostic response. Malformed and oversized output remains rejected.

## Verification

- Focused native listener, host route, merge, CLI and route-selection tests.
- Chromium/WebKit invitation and connection settings tests cover read-only
  open/refresh, explicit enable, pending publication/close guards, independent
  LAN/Tailscale states, wrong-host reads/actions, failed reads, legacy hosts,
  translations and 320/390/1360 px layout.
- Existing owner route-sync/reload, multipath, device-invite and VPS connection
  regressions. One old VPS test still looked for the retired English dialog
  title “Connection”; its locator now uses “Connection status & routes”.
- The signed-out diagnostic was reproduced against the local Tailscale CLI and
  verified with the updated source, without logging in or changing its network.
- Real phone/tailnet/cellular and sleep/wake acceptance remains pending. The
  local host at inspection had LAN enabled and TaroBot Tailscale access disabled;
  the local Tailscale backend required login. No production listener or paired
  device authorization was changed for this verification.

The local update candidate is App 1.0.104 / Host-CLI 0.1.451, protocol 1 and
Hub schema 1–21. Public releases, registry publication and phone installation
are separate from this local Mac update.

Final source checks: 453 test files, 6177 passed and 5 existing skips; 77 native
checks; host/client builds and translations passed. Chromium and WebKit each
cover 48 unique connection/invitation/route cases. The initial native gate lacked
the generated host resource directory in the new worktree; after preparing it,
the complete pre-complete command passed. Packaging/installation receipts remain
local artifacts, and do not establish real tailnet or phone acceptance.
