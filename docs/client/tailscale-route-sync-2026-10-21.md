# Host route refresh and self-route sync (Issue #53, 2026-10-21)

A phone paired to one computer can now learn that computer's newly enabled
Tailscale or changed LAN route without re-pairing, including on a standalone
host. Signed directories, QR v1, `/api/network` and `private-network:v1` keep
the unchanged wire rule: at most one direct route plus up to eight VPS routes.

## Host

- `src/hub/host-routes.ts` observes desktop-managed TLS listeners once at Hub
  start and after each 30 s listener refresh in `src/hub/cli.ts`, after the
  `desktop-start` mutex is released. It is database-only and never performs a
  network exchange, so shutdown is not held by a slow peer.
- Only listeners this desktop manages, that are actually bound and that serve a
  leaf verifying under the desktop CA, are candidates. Loopback, unspecified and
  non-literal binds are never published. Managed LAN replacement is restricted
  to private IPv4 addresses; a custom public Direct address is never classified
  as a managed LAN route. Tailscale IPv4 is preferred.
- The first unambiguous listening address of a mode is adopted at once. A different
  address later must be the unique candidate on two consecutive refreshes, at
  least 5 minutes after the previous change. An absent previously selected interface (sleep, Wi-Fi
  or VPN off) does not cause a replacement. Several LAN candidates (VM, Docker, VPN bridges)
  require the existing shared choice or verified interface lineage; otherwise
  they change nothing and report `lan_selection_required`. The host stores a
  hash of interface name and MAC only in its private observation metadata (not
  in C3, QR or the signed directory). LAN replacements require that same
  interface and an exact recorded predecessor. A missing/changed interface or
  missing MAC requires owner review; a lone VM bridge cannot replace the
  explicitly shared Wi-Fi origin after Wi-Fi disappears. If LAN selection has
  ever been ambiguous before a LAN choice, that fact persists across restarts: a
  remaining single LAN address (Wi-Fi or bridge) is not auto-selected even
  when the shared route is Tailscale. With no shared Tailscale, preparing the
  desktop LAN route clears this ambiguity. When Tailscale is shared, the
  compatibility projection keeps it: clearing the ambiguity currently requires
  an explicit owner `tarobot network routes --from routes.json --yes` containing
  a LAN Direct route, which changes the shared single-direct selection. A phone
  can instead scan the LAN connection code to add its own route without
  changing that shared descriptor. Automatic adoption of a lone Wi-Fi after
  transient ambiguity remains a fail-safe availability limitation.
- The signed descriptor (`state.routes`) is only ever replaced, never extended,
  and only when its single direct route carries the desktop CA and managed port,
  belongs to the same address class, is no longer bound, and a confirmed
  replacement is bound; at most once per 5 minutes. The compare-and-swap runs in
  the same transaction as owner `routes` commands, so an owner choice wins. An
  authority signs exactly one revision; a peer marks itself waiting and publishes
  on its next tick; a removed host does nothing.
- Observations live in the separate `host-routes:v1` meta key. Older Hubs ignore
  it and still parse `private-network:v1`.

## Endpoint (`host-routes.v1`)

`GET /api/network/host-routes` is owner-only (member 403, revoked or
unauthenticated 401). It returns `hostPublicKey`, the shared routes, at most one
extra managed LAN and one Tailscale route, per-mode `enabled`/`listening`, and
notices. The `source` tag exists only in this envelope. This is owner-scoped
disclosure of the host's own addresses, not an authorization: a route still
becomes usable only after the native pinned identity proof and the signed
handshake on that route.

## App

- `client/src/network-sync.ts` reads the endpoint on the existing visible-only
  loop: when a connection becomes online, on visibility, then at most every 10
  minutes (never more than once per 30 s per registration), with an 8 s timeout.
  It requires the owner role, the advertised capability, an online non-read-only
  connection, and a reply whose `hostPublicKey` equals the pinned Hub key and the
  registry entry. The desktop App's own loopback host is skipped. Old Hubs are
  not queried. An empty reply never withdraws routes.
- `client/src/host-route-sync.ts` merges per origin against the last applied
  host-published set (`RuntimeHost.hostRoutes.base`): additions are adopted
  unless the user already has that origin; withdrawals and changes apply only to
  automatically adopted routes still exactly as published; origins that existed
  before discovery or were edited by the user are recorded separately in
  `hostRoutes.manual` and cannot be withdrawn by the host. The full published
  base also remembers user deletions so they are not re-added. A missing CA is
  filled for the same origin; a different manually configured CA is kept;
  the active route is never removed or rewritten (retried later); additions over
  the local cap are skipped and retried; the route page reports when the
  host has additional routes that cannot fit. An obsolete descriptive deployment
  preset is cleared when it no longer describes the newly adopted routes; it
  must not prevent a VPS-only device from learning a trusted Tailscale route.
  The first sync has no base and is add-only.
- Signed-directory discovery of other hosts uses the same merge with the
  existing `networkRoutes` and `networkManualRoutes` as independent provenance.
  Two bases keep a lagging
  directory and the fresh host view from undoing each other.
- Writes go through `updateRoutes(routes, { expected, deployment, reason: "host-sync" })`;
  a concurrent edit wins (`routes_changed`) and the next cycle merges again.
  Identity is written before provenance, so an interruption leaves a stale but
  kept route rather than a "deleted" one.

## CLI

`tarobot network local [--json] [--tailscale]` reads the same endpoint over the
enrolled local controller. `--tailscale` runs only
`tailscale status --json --peers=false` (fixed argv, no shell, 3 s timeout,
256 KiB cap) and reports the backend state, whether this node is online and
whether each published Tailscale address belongs to this node. No peer, host or
DNS name is printed. It is a host-side snapshot and never gates publication.

## Limits

- Member-role devices are not auto-updated; they recover through the owner's
  QR or route repair.
- Nothing here tells a phone whether its own Tailscale is on, whether ACLs allow
  it, or whether a path is direct or relayed.
- The desktop leaf has IP SANs only; MagicDNS names are not supported unless the
  user provisions a certificate for them.
- Evidence is unit and fixture level only (`hub-host-routes`, `hub-private-network`,
  `host-cli-tailscale-status`, `host-cli-network-command`, client `host-route-sync`).
  No real tailnet, phone, cellular network, sleep/wake or DHCP change was exercised.

完整自测与独立审阅结果见[验证记录](tailscale-validation-2026-10-21.md)。
