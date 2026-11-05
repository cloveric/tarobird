# Tailscale pairing — 2026-10-12

Previously, manual HTTPS routes accepted Tailscale, but the local desktop host's
device-pairing wizard generated only LAN invites. It now offers an explicit
Tailscale choice with setup instructions, an action to detect its interface and
generate the HTTPS QR, and directions for updating an already paired phone.

The native action detects assigned `100.64.0.0/10` and `fd7a:115c:a1e0::/48`
addresses (IPv4 first) and binds only those IPs with private exposure. This is
interface discovery, not a Tailscale control-plane or reachability check. To avoid
mistaking an ISP/other VPN's CGNAT address for Tailscale, an interface must have a
Tailscale name or the accompanying Tailscale IPv6 prefix (macOS `utun`). These
address ranges follow the [Tailscale address reference](https://tailscale.com/docs/reference/reserved-ip-addresses). It
requires Tailscale's normal OS network interface; userspace networking is not
automatically provisioned. The existing private CA and signed Hub identity flow
remain in force; nothing is installed into the system trust store. The QR does
not contain a device private key or an automatic device approval.

LAN and Tailscale opt-ins are retained independently, with one stable listener
port and CA. Creating one invite preserves the other's live listeners and any
unrelated configured listeners. Offline startup removes absent interface binds
while retaining their opt-in and port. After connecting Tailscale, refresh the
invite to enable its listener if it was absent during startup. Refreshing an
unchanged network does not restart the Hub; a failed restart restores the old
configuration and leaf certificate. Network changes can restart the Hub, which
the UI explains before the explicit action.

Already enrolled phones use the existing same-Hub QR repair with confirmation.
It replaces their direct route, preserves device identity and ordered VPS
backups, and does not send another enrollment request. Scanning a Tailscale
invite now retains its route name after saving the `computer` deployment.
Refreshing or changing connection methods hides stale QR codes; failures and
unmounted requests cannot display a previous network's invite.

## Validation

- Unit tests use synthetic interfaces and mocked service transitions for IP
  discovery, IPv6 URLs, opt-in isolation, stable ports/CA, same-origin route
  naming, offline restoration, and restart rollback. Certificates are real.
- Browser tests decode an actual rendered QR carrying that public CA, exercise
  explicit setup, failures/retry, host mismatch, 320/390/1360-pixel layouts, and
  English strings. The native IPC is a fixture, not the installed app.
- A real disposable Hub test verifies LAN/Tailscale QR repair keeps the same
  device enrollment across reload without another pairing POST. The replacement
  IP is synthetic/offline; this does not prove a physical Tailscale connection.
- Existing desktop-host tests cover real child-process startup, local approval,
  private-CA HTTPS, LAN pairing and offline port recovery.

Results: root build and full suite passed (215 files, 2,833 passing tests and one
existing skip); client production build and native desktop `cargo check` passed.
Chromium passed 38 scoped browser tests and WebKit passed 10, with the final three
invite/layout tests rerun successfully on both engines after loading the missing
pairing stylesheet. The final rendered desktop invite was visually inspected on
both engines; width checks cover 320, 390 and 1360 pixels.

This change does not
install or publish an App build, operate the user's live Hub, log into Tailscale,
or change its access rules. At implementation time no Tailscale IP was assigned
on the development host. Two-device Tailscale pairing, cellular-data chat/file
transfer, sleep/wake and real VPN reconnect remain physical-device acceptance.
