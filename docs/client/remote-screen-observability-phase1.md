# Remote Screen Smoothness — Phase 1: Observability & Opt-In UDP Boost

This document covers **Phase 1** of Issue #80: viewer performance observability (desktop and phone) and the opt-in Host-level **"UDP boost (experimental)"** setting, establishing the measurement baseline before Phase 2 WebRTC/UDP media transport rollout.

## What Phase 1 Delivers

1. **Toggleable Performance Overlay (Desktop & Phone)**
   - Available via the `Activity` button in the remote screen viewer toolbar and inside **More screen actions** on both desktop and phone (portrait and landscape).
   - Non-interactive (`pointer-events: none`) translucent HUD displaying:
     - **Frame rate** (`fps`, sliding 1-second rendered-frame window)
     - **End-to-end latency** (latest + p95 ms from `captureMs` to `requestAnimationFrame` paint)
     - **Bitrate & resolution** (`kbps` / `Mbps`, `width × height`, codec `H.264` / `VP8`)
     - **Dropped / skipped frames** (sequence-gap drops vs. visibility/pacing skips)
     - **Active route** (e.g. `UDP · LAN direct`, `UDP · VPS relay`, `TCP (UDP not connected)`, `TCP (default)`)
2. **Host-Level "UDP boost (experimental)" Checkbox**
   - Added to **Screen Control** settings on the Host (`screenPolicySchema.udpBoost`, unchecked by default).
   - Applies to all viewing devices of that Host; viewers need no separate toggle.
   - Backward-compatible signed policy text (`screenConfigureText` leaves legacy payloads unchanged when `udpBoost` is omitted).
   - Honestly reports live connection state (`Off · using TCP`, `Connected`, or `Not connected · fell back to TCP` with the concrete reason).

## Simulated Baseline Across 4 Routes (Fake Network Simulator)

Because Phase 2 UDP/WebRTC transport is deferred to a separate PR, Phase 1 includes a deterministic fake-network simulator (`simulateScreenNetwork` in `src/client-protocol/screen-metrics.ts`, verified in `tests/remote-screen-phase1.test.ts`) modeling RTT, jitter, packet loss, bandwidth ceilings, and TCP head-of-line retransmission stalls:

| Route | Transport | Simulated RTT / Loss / Cap | Expected Bottleneck |
| --- | --- | --- | --- |
| LAN direct | TCP vs. UDP | 4 ms / 0% / 40 Mbit/s | Capture & encode budget dominate; minimal transport delta. |
| VPS relay | TCP vs. UDP | 45 ms / 3% / 4 Mbit/s (TCP) vs. 8 Mbit/s (UDP) | TCP head-of-line blocking under 3% loss inflates p95 latency sharply; UDP drops isolated frames without stalling subsequent frames. |
| Tailscale | TCP vs. UDP | 32 ms / 2% / 4 Mbit/s (TCP) vs. 10 Mbit/s (UDP) | TCP-over-tunnel stalls under loss; direct UDP avoids double-congestion collapse. |
| Phone 4G/5G | TCP vs. UDP | 75 ms / 5% / 3.5 Mbit/s (TCP) vs. 6 Mbit/s (UDP) | Highest p95 latency reduction under lossy mobile links; pairs with Phase 3 resolution-first adaptation. |

> **Note:** Live multi-host measurements on macOS and Windows targets across real LAN / VPS relay / Tailscale / 4G-5G links will be recorded using the Phase 1 overlay once Phase 2 UDP relay transport lands.
