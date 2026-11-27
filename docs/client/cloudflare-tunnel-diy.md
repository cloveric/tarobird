# DIY Cloudflare Tunnel Route & Relay Evaluation

TaroBird supports connecting your own **Cloudflare Tunnel (`cloudflared`)** alongside **LAN (`Direct`)**, **Tailscale**, and self-hosted **VPS** routes—at zero server cost to you and without TaroBird hosting or proxying your traffic.

## How It Works (Security, Trust Model & Listener Boundary)

TaroBird's `Direct`, `Tailscale`, and `VPS` (TLS-passthrough) routes continue to enforce **strict leaf-certificate pinning** via `/api/tls-identity` (and invite-scoped CA anchors when applicable). Nothing is weakened on those routes.

> **Important trust-model difference (TLS termination at Cloudflare's edge):**
> Unlike `Direct`, `Tailscale`, and TLS-passthrough `VPS` routes, Cloudflare Tunnel terminates outer TLS at Cloudflare's edge (serving a Cloudflare WebPKI certificate rather than the Hub's local leaf certificate) and forwards decrypted HTTP/WebSocket traffic through `cloudflared` to your Host. **Cloudflare's edge can therefore read and modify traffic traversing a `Cloudflare` route** (chat text, attachments, bearer session tokens, metadata, and unsigned HTTP bodies). Mutual Ed25519 handshakes, one-use device-action proofs, signed network manifests, and signed Bot passports still detect forged signed operations, and you can disable or remove Cloudflare routes at any time. For end-to-end transport confidentiality without a TLS-terminating intermediary, use `Direct` (LAN), `Tailscale`, or a self-hosted TLS-passthrough `VPS` relay.

`Cloudflare` routes enforce an explicit, fail-closed edge boundary:

1. **System WebPKI HTTPS only**: Native clients (macOS/Windows Rust transport, iOS `HubTLS`, Android `HubTls`, Electron) verify the outer TLS 1.2/1.3 certificate and hostname strictly against the OS root store. Custom `certificateAuthority` overrides and insecure fallbacks are rejected for `Cloudflare` routes.
2. **Dedicated non-privileged loopback listener (`edge-proxy`)**:
   - The Hub binds a separate loopback HTTP listener (`127.0.0.1:<edge-port>`, shown in Host settings and `tarobot cloudflare status`) specifically for Cloudflare Tunnel traffic—never the main loopback HTTP listener or instance listener.
   - Local vs. remote separation and instance privileges are enforced strictly by **listener boundary**, never by client-controllable HTTP headers on the main loopback listener.
   - Privileged loopback endpoints (`/screen/v1/target`, `/screen/v1/target-media`, `/instance`, `/api/instance/*`, `/api/bot-messages/grant`, and `/api/bot-messages/local`) are never enabled on the `edge-proxy` listener, and Cloudflare configuration mutations are refused over `edge-proxy`.
3. **Origin-bound Host Ed25519 proof (`/api/edge-identity`) & DoS isolation**:
   - The Hub serves `/api/edge-identity?nonce=<nonce>&origin=<origin>` **only** on the dedicated `edge-proxy` loopback listener and **only** for HTTPS origins explicitly authorized by the Host owner (saved in Host Cloudflare settings, active local Quick Tunnel, or `TAROBOT_CLOUDFLARE_ORIGINS`).
   - The Hub signs `["tarocub/edge-identity/v1", publicKey, nonce, origin]` with its Ed25519 identity key so an arbitrary third-party proxy cannot obtain or replay a valid proof for an unauthorized domain.
   - Only requests arriving on the `edge-proxy` listener enter the `edge-proxy:` rate-limit/audit namespace (never `"trusted"` loopback). Per-client attribution reads Cloudflare's edge-inserted `CF-Connecting-IP` (normalized with IPv6 `/64` grouping, falling back to `edge-proxy:shared`), while main loopback and TLS/built-in-relay listeners ignore all forwarding headers.
   - Anonymous `/api/edge-identity` probes are bucketed per `(source, origin)` in a dedicated bounded 4,096-entry edge table (separate from direct/relay anonymous limits). Per-source limits apply to tracked sources; when the edge table is full, further callers are served untracked so nobody is locked out. A caller presenting a session or an enrolled device id is counted in the device table instead; current clients do not do this yet.
4. **Local controller + signed device-action authorization**:
   - Authorizing custom Cloudflare domains (`PUT /api/host-routes/cloudflare`) and starting/stopping a local Quick Tunnel (`POST /api/host-routes/cloudflare/quick`) require an **enrolled local owner controller** (Desktop App on the Host computer or local Host CLI, never a remote paired device) plus a fresh one-use `cloudflare-tunnel` Ed25519 device-action proof bound to the exact command and session.

## Phase 1: DIY `cloudflared` Setup

Configure via **Settings → Connection status & routes → DIY Cloudflare Tunnel** on the Host computer, or from the Host CLI (`tarobot cloudflare ...`):

### Option A: Named Tunnel (Recommended for daily use)

Use your own free Cloudflare account and domain (free tier supports up to 1,000 tunnels per account and optional Cloudflare Access). Point `cloudflared` at the Hub's dedicated **edge-proxy loopback target** (not the main Hub port):

```bash
cloudflared tunnel --protocol http2 run --url http://127.0.0.1:<edge-port> <your-tunnel-name>
```

Then authorize your `https://hub.example.com` origin in **Authorized Cloudflare HTTPS origins** (or via CLI below), save, and share the QR code or add it on your phone/other computers.

### Option B: Quick Tunnel (Zero-account testing)

```bash
cloudflared tunnel --protocol http2 --url http://127.0.0.1:<edge-port>
```

Or click **Start Quick Tunnel** in the Host settings panel (or run `tarobot cloudflare quick start --yes`) when `cloudflared` is installed.

> **Quick Tunnel limits**: `*.trycloudflare.com` URLs change whenever `cloudflared` restarts, are capped at 200 concurrent in-flight requests, and do not support Server-Sent Events (SSE).

### Host CLI Commands

```bash
tarobot cloudflare status [--json]
tarobot cloudflare allow https://hub.example.com --yes
tarobot cloudflare revoke https://hub.example.com --yes
tarobot cloudflare set --mode named --protocol http2 --origins https://hub.example.com --yes
tarobot cloudflare quick start --protocol http2 --yes
tarobot cloudflare quick stop --yes
tarobot pair --cloudflare
```

You can also pin a fixed edge-proxy loopback port in the Hub's `config.json` via `"edgePort": 8790` (otherwise the Hub persists a stable loopback port in `edge-proxy-port.json`).

### Mainland China & Firewall Guidance

- **Use `--protocol http2` (TCP/443)**: Cloudflare's default QUIC transport (UDP/7844) is frequently throttled or blocked on Chinese ISPs and restrictive corporate networks. TaroBird defaults to recommending `--protocol http2`.
- **Honest latency expectations**: Free Cloudflare routes traverse overseas Anycast PoPs (typically adding ~150–350 ms RTT from mainland China). They work well for chat, Bot control, notifications, and CLI workflows. For high-fps Remote Screen streaming, keep LAN, Tailscale P2P, or a nearby self-hosted VPS configured—TaroBird prefers lower-latency direct routes whenever reachable.

---

## Phase 2 Evaluation: Self-Deployed Cloudflare Workers + Durable Objects E2EE Relay

| Dimension | DIY `cloudflared` Tunnel (Phase 1, shipped) | DIY Workers + Durable Objects E2EE Relay (Phase 2 option) |
| --- | --- | --- |
| **User setup** | Install `cloudflared`; zero-account Quick Tunnel or free Named Tunnel | Requires Cloudflare account + `wrangler deploy` of an open-source Worker/DO template |
| **Transport** | Direct HTTP/WebSocket tunnel from Cloudflare Edge to Hub loopback | Hub maintains outbound WebSocket to user's Durable Object; clients connect to same DO |
| **TLS & E2EE boundary** | Edge terminates outer TLS; TaroBird authenticates Host/device with Ed25519 + origin-bound proof | Must add an outer E2EE envelope (e.g. Noise / X25519 + AEAD) so the Worker/DO forwards only opaque ciphertext |
| **Free-tier limits** | Named Tunnels: up to 1,000 tunnels, generous bandwidth, no request-unit billing | Workers Free: 100k requests/day; Durable Objects WebSocket Hibernation requires paid Workers plan for production volume |
| **Remote Screen video** | Usable for fallback only; prefer LAN/Tailscale/VPS | **Out of scope** — never proxy high-bitrate screen video through Workers/DO |
| **Best fit** | Immediate zero-cost remote access for all HTTP/WS features & attachments | Lightweight mobile-companion E2EE control/chat/notifications when `cloudflared` cannot run |

**Recommendation**: Phase 1 (`cloudflared` DIY route with `--protocol http2` and origin-bound `/api/edge-identity`) solves the immediate user need (#98 / #103) with zero billing tier friction, full attachment/streaming compatibility, and no extra E2EE framing layer. If pursued later, Phase 2 should ship as an optional MIT-licensed `wrangler deploy` template strictly scoped to opaque E2EE chat/control/notification frames (excluding Remote Screen media).

## References

- `pingdotgg/t3code` (MIT) — `cloudflared` loopback tunnel lifecycle, UDP/7844 QUIC vs. HTTP/2 troubleshooting, and route prioritization concepts.
- `stablyai/orca` (MIT) — lightweight Workers + Durable Objects WebSocket relay concepts for mobile companion E2EE traffic.
