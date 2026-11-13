# Pairing recovery and first-use stability

The phone import flow keeps the next explicit Pair action in view and focuses
it after the scanner closes. It never submits automatically or opens a keyboard.
Compact translated host summaries keep the change action below the address.

Preparing a desktop endpoint waits for publication before handing its invitation
to the parent dialog. A waiting notice is not a failure: no temporary QR is
issued while publication can still advance automatically. A definitive failure
retains a stable manual QR until the owner prepares access again.

Reopening LAN settings exposes an unfinished multi-interface choice. A new
owner-only managed-selection API records the exact listening LAN URL and CA
without replacing shared Tailscale or changing the legacy signed-directory
schema. Older hosts explain the update/manual-QR path instead of repeating an
unsaveable choice. See the Host route entrypoint and CLI documentation.

When a pending device scans a renewed invitation, a changed private LAN or
Tailscale address can be saved with the invitation in one transaction. The Hub
key and an existing direct-route CA must match. Public endpoints, new CAs and
VPS-only identities require the explicit address-repair confirmation. Approval,
revocation, another invitation and concurrent route edits invalidate stale
writes. Device identity and other routes are retained.

The source/browser regressions cover import visibility in Chinese and English,
320/390px iOS and Android layouts, delayed and failed route publication, LAN
selection with and without Tailscale, settings reopen, old-host fallback,
renewed invitations after an address move, and stale enrollment/route writes.
Relevant suites: `device-invite`, `pairing-import-recovery`, `tailscale-pairing`,
`pairing-recovery`, `pairing-pending-cas`, `hub-host-routes`,
`host-cli-network-command`, and `client-multipath-routes`.

These checks use isolated Hosts and Chromium fixtures. They do not establish
physical camera, mobile WebView, real-network or packaged-App acceptance. This
source change does not publish or install an App.
