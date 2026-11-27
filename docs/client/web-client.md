# Use TaroBird in a Browser

TaroBird's Host already serves the full web client directly from `client/dist`. You can pair any modern desktop or mobile browser—Chrome, Safari, Edge, or Firefox—without installing an App, see the same conversations as your native Apps, and revoke the browser at any time.

## Pair a Browser from the App

1. On an already paired device (desktop or phone), open **Settings → Devices & network → Add device**.
2. Switch the invite tab from **Pair an App** to **Use in a browser**.
3. Pick a route with a trusted browser address (see HTTPS & Origin requirements below).
4. Copy the one-time browser pairing link or scan the QR code with your phone's built-in camera (same-machine loopback links are copy-only because `127.0.0.1` only works on the Host computer).
   - The one-time invitation token is placed in the URL fragment (`#pair=...&invite=...`) so it is never sent in HTTP request paths, server logs, or `Referer` headers, and the page strips it from the address bar immediately after loading.
5. In the browser, click **Pair this device** to display an 8-digit pairing code.
6. Approve the 8-digit code on your trusted device (**Devices & network → Approve by code**).
7. The browser connects, syncs your conversations, and appears in your Host's **Devices** list (`web`). Revoking it immediately terminates its session and WebSocket access.

## HTTPS, Certificates & Allowed Origins

Browsers strictly enforce system WebPKI HTTPS trust (unlike TaroBird's native Apps, which can pin a Host's invite-scoped private CA), and the Host enforces an explicit `Origin` allowlist on HTTP API requests and WebSocket upgrades:

- **Same-machine loopback (`http://127.0.0.1:<port>` or `http://localhost:<port>`)**:
  - Works out of the box on the computer running the Host; browsers treat loopback as a Secure Context and the Host automatically allows its active non-TLS loopback port on `127.0.0.1`, `[::1]`, and `localhost`.
- **VPS relay or public HTTPS Host (`https://<vps-host>:<port>`)**:
  - Requires a publicly trusted HTTPS certificate AND the exact browser origin (scheme, hostname, and any non-default port; never `*`) listed in `"origins"` inside the Host's `config.json`.
- **Tailscale HTTPS (`tailscale serve`)**:
  - Provides a Let's Encrypt HTTPS certificate on `https://<host>.<tailnet>.ts.net`, and requires adding that exact origin to `"origins"` inside the Host's `config.json` (otherwise the Host rejects browser requests with `403 origin_forbidden`).
- **Private LAN or Tailscale IP HTTPS (`https://192.168.x.x:8788`, `https://100.64.x.x:8788`)**:
  - Uses the Host's private self-signed certificate (and public WebPKI CAs cannot issue trusted certificates for private or CGNAT IPs), so browsers will reject it. **Never bypass or click through browser certificate warnings.** Switch to a route with a trusted HTTPS certificate (VPS relay or Tailscale HTTPS domain) or use the native TaroBird App.

Example `config.json` `origins` merge (keep your existing `host`, `port`, listeners, and relays):

```json
{
  "origins": [
    "https://hub.example.com:8443",
    "https://<host>.<tailnet>.ts.net"
  ]
}
```

See [Host & Relay Deployment](host-deployment.md) and [VPS Relay Manual](vps-relay-manual.md) for full `config.json` examples.

## Feature Compatibility in Browsers

Checked across desktop browsers (Chrome, Safari, Edge, Firefox) and mobile browsers (iOS Safari, Android Chrome):

| Feature | Web Browser | Notes |
| --- | --- | --- |
| 1-on-1 Bot chat, streaming, markdown, math, code, widgets | **Supported** | Same conversations and live sync as the App |
| Groups, topics, ADHD board, search, folders | **Supported** | Same state and permissions |
| File upload, attachment preview & download | **Supported** | Uses standard browser downloads |
| Workbench: Canvas, Slides, Whiteboard (Excalidraw), Notes (Vditor) | **Supported** | Full editing & version history |
| Voice input (microphone) | **Supported (HTTPS / localhost)** | Requires Secure Context and browser mic permission |
| Device management & immediate revocation | **Supported** | Browser appears as a `web` device |
| Remote Screen control | **App only (hidden)** | Requires native desktop/mobile screen transport |
| Workbench embedded web browser tab | **Desktop App only (disabled)** | Clearly marked "Webpages are available on desktop" |
| Native background push notifications | **Web Push / App preferred** | Requires Host Web Push setup; live updates work while open |
| Reveal downloaded file in Finder / Explorer | **Desktop App only** | Browser uses its standard Downloads shelf |

## Security Notes

- Every paired browser generates its own per-origin device keypair in browser storage and goes through normal 8-digit owner approval.
- Browser pairing fragments (`#pair=...&invite=...`) are validated against the current site origin before pairing and are stripped immediately from the address bar and browser history.
- Do not pair a shared or public kiosk browser; if you ever need to sign out remotely, revoke that browser entry in **Settings → Devices & network** and access stops immediately.
- Hosted multi-user web relays (like `app.t3.codes`) are out of scope for this self-hosted web client; your browser talks directly to your own Host.
