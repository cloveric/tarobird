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
