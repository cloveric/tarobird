# Configure a host's VPS endpoints on that host

## Problem and behavior

Desktop Connection settings protected the local loopback route by hiding the
ordinary route editor. Its replacement opened only LAN/Tailscale setup, leaving
no VPS field on the host itself. A browser regression first reproduced the
missing entry against the unchanged production components.

The local Connection page now contains **本机 VPS 中转 → 添加 VPS 中转**.
Owners can add, reorder, rename and remove deployed HTTPS endpoints. Existing
entries offer a connection code for new-device pairing. LAN/Tailscale setup
remains separately available; the desktop's own loopback connection is unchanged.

This edits the existing host-advertised network routes through the authenticated,
device-signed `networkCommand({ operation: "routes" })` API. It works for a
standalone host before a network is created. It does not install a VPS service,
open ports, generate certificates, enroll devices or restart the host.

Network-managed routes follow the existing signed directory synchronization.
Independently paired devices and manually customized routes retain their current
ownership and must add the endpoint in their own Connection settings. No claim
is made that all previously paired phones are automatically rewritten.

## Guards

- The native host identity must resolve before showing local configuration.
- Only an online owner with network-management support can save.
- Inputs use the shared HTTPS/route schema; duplicates, loopback endpoints and
  more than eight relays are rejected. Removing all relays is supported.
- Before saving, each relay's public health endpoint is checked through the
  existing native transport with the pinned Hub key. No device token is sent to
  the proposed endpoint. Wrong-host, TLS and reachability failures prevent saving.
  A health check is not a complete device-authenticated connection acceptance.
- A fresh network read preserves any newer direct LAN/Tailscale route. If relay
  settings or network membership changed since editing began, saving is rejected
  until the user reviews fresh settings. Reconnection never rebases that draft.
- Existing server-side network identity, ownership and signature checks apply.
  This change does not add a new server-side route compare-and-swap protocol;
  simultaneous writes after the final read retain existing API semantics.
- Pending saves cannot be double-submitted or closed. Unsaved edits use the
  Connection page's existing discard confirmation. A successful receipt is
  displayed without requiring a second fallible refresh.

## CLI impact

No new host capability, schema or CLI implementation is needed. The existing
`tarobot network routes --from routes.json --yes` manages the same host-advertised
routes without a desktop window. The desktop's new availability probes are UI
preflight, not a change to the CLI's existing validation/deployment contract.

## Verification and release boundary

Focused unit/Hub/CLI regressions: 90 passed (`local-relay-routes`,
`client-network-routes`, `client-route-form`, `host-cli-network-command`,
`hub-network-http`, `hub-private-network`).

Chromium: 72 checks passed (62 component/native-transport checks, eight
initial remote-route checks, and two corrected-selector reruns).
Client translation validation, TypeScript and production build passed.

Browser coverage exercises the production Connection components with isolated
transport/network fixtures: Windows/Mac platform variants, persistence read-back,
identity rejection, failure/retry, duplicate clicks, discard protection,
concurrent edits/reconnect, final-relay removal, English and compact layouts.
Native transport coverage explicitly rejects a mismatched pinned host without
falling back to browser fetch or sending an Authorization header.

The existing deployment/failover tests were updated to scope reply assertions
to the run response region: sidebar previews legitimately repeat the same text.
Their message-count and one-turn execution assertions remain intact.

Windows/Mac variants are browser fixtures, not physical desktop acceptance.
No ASUS/VPS configuration or installed App was changed by these tests.
Final browser/build results and source hashes are recorded in the external
verification checkpoint. The original external-volume Git denial is resolved. Follow-up verification and
source delivery are recorded below; no release or installed-App replacement is
claimed by this source task.

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.
