# LAN interface discovery

Desktop LAN preparation previously kept only the first four eligible IPv4
addresses returned by the operating system. Bridge or VPN addresses could fill
those slots before Wi-Fi, omitting the phone-reachable address from both the
desktop selector and the CLI's `pair --lan --address IP` candidates.

`src/hub/desktop-tls.ts` now retains every detected, non-internal RFC1918 IPv4
address, deduplicated in the existing order. It does not guess which interface
the phone can reach. The owner still selects the appropriate address. Public,
link-local, loopback, IPv6 and Tailscale address admission are unchanged.

This is a shared Host/CLI fix. Listener preparation uses the complete candidate
list with the existing stable port and private CA. QR v1 still contains only the
selected direct route; signed-directory and client-local route limits are
unchanged. Existing authorization and explicit LAN opt-in remain required.

## Verification

- Synthetic discovery and preparation regressions failed on the previous
  four-address cutoff, while ordinary two-interface and offline cases passed.
- Six focused Host/CLI suites passed all 60 tests, including certificates,
  explicit address selection, stable port/CA reuse, route publication and the
  existing isolated live-HTTPS desktop Host tests.
- Thirteen Chromium pairing/settings cases passed, including selection of the
  fifth address and decoding its actual QR image as a single-route v1 payload.
- The standalone Host build passed. No dependency, native bridge, version,
  installed App or live owner network configuration changed.

The browser uses synthetic IPC and the multi-interface tests use synthetic OS
interfaces. These checks establish the cutoff defect and regression coverage;
they do not establish physical phone connectivity or the cause on any reported
machine. A host with only two eligible addresses does not trigger the cutoff.
This source fix is not a release or installed-device acceptance.


## Partial readiness and explicit selection follow-up

Independent review found two gaps beyond discovery: a single failed health
check rejected every candidate, and the desktop UI immediately selected and
published the first address in operating-system order. That order can put a
bridge or Thunderbolt interface before Wi-Fi.

Network preparation now returns only candidates whose HTTPS endpoint passes the
existing private-CA and Host-public-key checks. A failing candidate does not
hide healthy candidates; all-failed preparation still fails. The optional
`unavailableRouteCount` reports omitted candidates without exposing their raw
errors. CLI `pair --lan --address IP` continues to require that exact address;
it never substitutes another route when the chosen address fails.

First-time port allocation tolerates a disappearing or unsupported interface
only when another interface can bind the candidate. It still checks conflicts,
closes probe sockets, preserves an existing saved port, and refuses to succeed
when no interface can bind. Network changes remain explicitly enabled; no
firewall, authentication, listener-exposure or certificate trust policy changes.

When more than one healthy LAN address is returned, or any candidate was
omitted, pairing, network sharing and local connection settings wait for an
explicit choice. Until then there is
no new invitation QR or route publication, and the page remains closable.
Preparing again clears the previous choice and QR. A single LAN address with no omitted candidates and Tailscale retain their
existing flow. Partial-readiness information is separate
from publication errors so a successful share does not erase it. Old Host
responses without the optional count remain accepted.

### Follow-up verification

- Desired-behavior regressions failed before the changes: partial candidate
  health and disappearing-interface port probes, plus a real isolated Host
  first-allocation failure. After the changes, the 10 related Host/CLI/route
  suites passed 118 cases. The real Host case covers actual listener binding,
  HTTPS validation, stable port reuse and explicit CLI rejection of the missing
  address; discovery is injected and the healthy endpoint is loopback.
- Chromium passed 41 pairing/settings and parent invitation cases. The new
  regressions cover no QR/invitation issuance/publication before selection,
  retry reset, changing a choice during reconnect, a sole surviving candidate,
  partial-readiness messages after parent-page advancement and route switching,
  English text and 320/390/1360 widths.
  These use synthetic IPC and do not certify native bridge or phone networking.
- Host and client builds, client type checking and translation checks passed.
  No dependency or version change is part of this repair.

### Remaining boundaries

- Local self-connect checks cannot establish reachability from a phone. The
  reported friend's interface list, firewall and Wi-Fi isolation remain unknown.
- Options still show addresses, not guessed cross-platform Wi-Fi interface names.
  The user chooses the address on the other device's network.
- Existing signed-directory rules preserve a shared Tailscale route. A LAN route
  that is not confirmed in the managed route view still shows the existing
  honest sharing warning; selecting it does not overwrite the Tailscale fallback.
- Very large interface lists can still exceed the native bridge's 64 KiB response
  limit because each candidate includes a CA. No silent truncation is introduced.
- Enabling LAN still binds all eligible private interfaces under the existing
  authenticated TLS policy. Listener/SAN scope and retired-listener bookkeeping
  have not been redesigned.

This follow-up changes source only. It is not a packaged, installed desktop,
Windows, physical phone or friend-network acceptance claim.
