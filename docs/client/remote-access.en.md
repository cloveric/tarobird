# Remote phone access: Agent-assisted or manual setup

[中文](remote-access.md) · [Manual commands](vps-relay-manual.md) · [Home](../../README.md)

An address entered in the app does not deploy a relay. Set up a reachable route
first, then save it on the phone and complete device pairing if needed.

| What you want | Deployment | Keep online |
| --- | --- | --- |
| Access your computer's existing Bots, files, logins and history | Computer runs the Hub and Bots; VPS relays encrypted traffic | Computer and VPS |
| Connect without operating a VPS | Tailscale on both devices, plus TaroBot pairing | Computer and both Tailscale connections |
| Run Bots while your computer is off | [Full Hub and engine deployment on a VPS](host-deployment.md) | Host VPS |

This guide defaults to the first option. Creating a new Hub on the VPS creates a
separate host; it does not recover the computer's existing history or pairing.

## Ask an Agent to configure it

Use a terminal-capable Agent such as Codex or Claude Code on the Bot host. It
needs access to the repository and your authorized SSH connection. A chat-only
assistant cannot deploy the service. Replace the placeholders and give it this:

```text
Configure TaroBot remote phone access through my VPS to my existing computer.
Repository: https://github.com/cloveric/tarobot
Bot host OS and app/source path: <fill in>
Existing Hub state directory: <path, or inspect the running host to find it>
VPS SSH alias and local private-key path: <paths only; never paste key contents>
VPS OS/public IPv4 and existing services: <fill in, or inventory services first>
Public entry: <existing domain, or IPv4 with a trusted IP certificate>

Read AGENTS.md, docs/entrypoint-map.md, docs/client/remote-access.en.md,
docs/client/vps-relay-manual.md and docs/client/relay-deployment.md first.
The VPS is only a relay. Preserve the existing Hub identity, Bots, history and
device enrollment. Do not create a replacement Hub or migrate the Bots.

Inventory and back up the existing configuration. Verify SSH host identity.
Use unused public HTTPS and mutual-TLS tunnel ports. On a shared VPS, preserve
existing services and do not run the dedicated-VPS firewall installer.
Keep the Hub identity/TLS private keys, API credentials and chat data on the
original computer. Only the explicit relay server credentials belong on the VPS.
Configure a trusted public certificate, renewal, safe delivery and loading on
the host, service startup and recovery. Certificate issuance alone is not renewal.
Verify public TLS, certificate-bound Hub identity, signed device authentication,
history sync, unauthorized access rejection and relay restart recovery without
sending test jobs to real Bots. A successful /health response is not completion.
Provide the actual phone HTTPS address and settings steps, required online
machines, verified results and remaining physical-device checks.
Keep secrets and real infrastructure configuration out of GitHub. Ask only for
missing inputs needed to finish the authorized deployment.
```

The built-in `hub relay deploy` command installs a **dedicated** relay server and
manages its firewall. It is not a safe default for a VPS already running a website
or other service. The [manual guide](vps-relay-manual.md) covers a separate service
without that dedicated-server firewall policy.

## Set it up manually

Follow [the command-by-command guide](vps-relay-manual.md): locate the existing
Hub, verify SSH, create separate tunnel and public TLS credentials, install the
VPS relay, append the host listener/tunnel configuration, arrange renewal and
verify the phone connection. Commands are labelled by the machine that runs them.
The examples target macOS/Linux hosts and a Debian/Ubuntu VPS. Windows requires
its native service/task setup instead of the Unix service commands.

## Configure an already-paired phone

These steps describe current `main`, awaiting packaging. Published App 1.0.83
still uses **Me → Settings → Connection** and the local-computer deployment choice.

1. Open **Me → Connection → Edit routes** on the existing host. Connection is
   immediately above **My network**.
2. Keep the existing direct route, or leave it blank to use relays only. There is
   no deployment-mode selector.
3. Choose **Add relay**, enter the deployed HTTPS address such as
   `https://192.0.2.10:8443`, and choose **Save routes**. The address here is only
   an example; use the one returned by your deployment.
4. Wait for **Connected** and the VPS route name. Turn off Wi-Fi to check cellular
   access. Routes are saved per device, not automatically pushed to other clients.

Do not remove/re-pair an already trusted host just to add a route. Phones need
neither the SSH private key nor engine API credentials. A new device still needs
the trusted Hub identity from the original host's **Settings → Devices & security
→ Add device**, then owner approval of its pairing code. Update a LAN-only QR
address to the deployed public endpoint in the pairing form before connecting;
never trust a new Hub key merely because an unverified `/health` returned it.

Multiple hosts can share a cloud server, but each needs its own relay endpoint
and tunnel. An endpoint forwarding to your Mac cannot also identify your Windows host.

## Common failures and security

- Relay `connected: false`: the service runs but has no host tunnel. Check the
  host, tunnel port, certificate name and allowed client fingerprint.
- TLS error: check hostname/IP, validity, chain, clock and both renewal stages.
  Do not disable certificate checking.
- Wrong Hub identity: correct the route; do not reset trusted identity to bypass it.
- Works on Wi-Fi only: check cloud and OS firewalls, the route and host tunnel.
- Computer off: a relay cannot run its Bots or serve an offline history/file copy.

In the examples, 8443 is the phone HTTPS port, 7443 is the host's tunnel port and
22 is SSH. The public address is not a password: unfamiliar devices still need
approval and device signatures. Do not approve unknown requests. Public services
remain exposed to traffic attacks and software vulnerabilities despite limits.
Separate process health, authenticated Internet access and physical-phone
acceptance; see [the live IP relay evidence](ip-relay-2026-10-12.md).
