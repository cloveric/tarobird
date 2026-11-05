# Host addresses and Tailscale connection clarity

The connection form now identifies the destination as this host, including
“添加此主机的其他地址”. It explains that only the first connection to that host
requires pairing; enrollment through LAN or another route remains valid when
using Tailscale. Users copy the complete URL, including its port, from the
computer running the host rather than entering the phone's own VPN address.

Local connection settings read the authenticated host-routes API whenever
opened. The selected LAN/Tailscale address list and copy controls are visible
without expanding troubleshooting or enabling the listener again. Addresses
wrap on narrow screens so their ports remain visible. Saved addresses for a
non-listening endpoint, and addresses awaiting replacement, are explicitly
qualified. Endpoint readiness does not establish a remote device round trip.

“刷新状态” is read-only and shows completion time or an actionable failure.
It remains available when an enabled endpoint is not listening, so checking
Tailscale recovery does not require preparing the listener again.
Failed, mismatched-host and obsolete responses cannot retain a ready status or
address list. Copy denial offers manual selection without claiming success.
Explicit listener preparation and network route publication retain their
existing separate mutation path.

CLI impact: presentation only. `tarobot network local --tailscale --json`
already reads the same host-routes API; no command or wire change is required.

Focused Chromium coverage passed 21 cases across multipath routes, same-host QR
repair and local connection settings; the final wrapping/copy variant passed
all 12 settings cases. WebKit initially passed 19 of 21: two QR-repair reloads
stalled at startup under concurrent suites, then both passed in isolation.
This initial failure is retained for release-audit follow-up, not counted as a
passing run. Final WebKit settings/multipath plus widget and document regressions
passed 43 cases. Chromium widget/document/settings/native-back passed 32 cases. Browser contexts do not establish physical-phone acceptance.

The deployment fixture also used a loopback address as a shareable invitation,
which the current product intentionally refuses. Its two-device journey now
uses a local non-loopback interface and a matching temporary TLS certificate.
No production network state or trust policy is changed.

The revised two-device deployment journey passed in Chromium. It preserves
QR pairing and synchronized history while checking saved routes without
assuming that a route name overrides the shared performance policy.

The final independent-review follow-up passed all 12 local connection cases
in both Chromium and WebKit, including recovery by read-only refresh.
