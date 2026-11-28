# Experimental UDP screen transport

[Issue #80](https://github.com/cloveric/tarobird/issues/80) adds an opt-in
Host policy. New viewers and capture services negotiate the feature when a
screen session opens. The existing screen grant, device membership, capture
permission and control lease apply on every route.

The viewer starts with TCP while it attempts LAN, Tailscale, UDP hole punching
through the configured VPS STUN endpoint, and paired VPS UDP forwarding in
that order. The Hub accepts offers only for an active screen session. It
verifies a device signature over the attempt, viewer and SDP, including the
DTLS fingerprint. The authenticated Hub returns its signature over both
descriptions and the exact viewer and target identities. Signaling uses the
existing pinned Hub API and the private target service socket. WebRTC
authenticates the advertised certificates and carries the video over DTLS-SRTP.

The viewer switches after painting a video frame matched to the target's RTP
timestamp, with UDP confirmed by the selected ICE pair. A receipt for that
frame goes through the existing control connection. The target confirms its
original capture time and geometry before a control lease can use the frame.
The interactive picture stays in the same canvas during a transport change.
If UDP stalls after a frame stamp was forwarded, the Hub requests a fresh TCP
keyframe even if the UDP frame was never confirmed. Control then requires a
fresh confirmed frame of the new generation. The HUD classifies the selected
ICE pair when the browser exposes sufficient evidence. The Hub can confirm UDP
playback without observing the exact path. Older peers and unavailable WebRTC
runtimes use TCP. UDP uses VP8 because the Electron sender exposes the exact
capture timestamp for that codec. QHD and Sharp, and viewers that offer only
H.264, use TCP.

## Relay and operations

The relay runs inside the existing service on the same numeric IPv4 UDP port
as the TCP mTLS tunnel. Its STUN/TURN-compatible exchange supports only two
allocations for a Hub-authorized pair. The relay forwards opaque datagrams to
that pair and limits traffic across each Host's pairs. A Host issues individual
credentials over its authenticated mTLS control channel. They expire when its
lease ends, the control channel is lost or it stops renewing for 90 seconds.
Configure one pilot Host with the relay's fingerprint allowlist.
When the external TCP port is mapped to a different relay port, TCP forwarding
continues and the mismatched UDP endpoint is ignored.

[English deployment guide](vps-relay-manual.md#optional-udp-boost-for-remote-screens) ·
[中文部署指南](vps-relay-manual.zh-CN.md#可选的远程屏幕-udp-加速)

## Reproduce with an isolated synthetic source

Install the repository's root and client dependencies. Use the Electron
version pinned in `client/package.json` on macOS, OpenSSL and the Playwright
browser engines. The executable exposes a synthetic window to the production
capture renderer and records native input calls in the fixture. It creates
private Hub/relay state and ephemeral certificates under a physical
`.noindex` path.

```sh
node --import tsx client/electron/tests/screen-udp.smoke.mjs \
  --lab "$SCREEN_LAB" --electron "$ELECTRON_BIN" --browser chromium
node --import tsx client/electron/tests/screen-udp.smoke.mjs \
  --lab "$SCREEN_LAB" --electron "$ELECTRON_BIN" --browser webkit
```

The default relay check requires a selected UDP pair, rendered synthetic
frames, increasing per-Host relay bytes, an authorized control lease and
continued TCP frames on the same viewing session after UDP loss. A second
enrolled device without a screen grant must receive HTTP 403. Use
`--mode lan` to exercise local ICE instead of relay-only ICE. The WebKit run
uses a 390×844 touch viewport. Native App acceptance requires the installed
viewer on the intended platform.

For the first-frame race, run the Chromium command with `--before-confirm drop`
and then with `--before-confirm timeout`. Both variants withhold only the Hub's
UDP frame confirmation and exercise the receiver without the modern
`AbortSignal` helpers. They require a new confirmed TCP generation, changed
canvas pixels and authorized synthetic input on the original session.

## Cross-network pilot

1. Use a pilot Host and a display that shows only a generated moving test
   pattern. Record the exact Host, relay and viewer builds. Allow only the
   pilot tunnel certificate and pair an explicitly authorized viewer.
2. Run the relay UDP check from the viewer's network. Start the screen across
   separate networks, then record the HUD route and sustained FPS, jitter,
   capture-to-display latency, bitrate and dropped frames. For the VPS path,
   require per-Host forwarded bytes to increase while the viewer renders.
3. Test the same screen from a device with no view grant. Test a view-only
   device and verify it cannot obtain control. With an authorized control
   device, confine input to the synthetic test window.
4. With the operator's coordination, interrupt UDP for the test viewer while
   leaving its existing Hub control/TCP connection online. Record the last UDP
   and first TCP frames, how long the displayed image held, and whether the
   session ID and connection persisted. Restore the test network rule.
5. Repeat on desktop and physical iOS/Android with the same pattern. Verify
   background closes the media, foreground makes a new viewing session if
   needed, and old clients still see TCP. Collect the corresponding LAN,
   Tailscale and separate-network hole-punch measurements where available.
