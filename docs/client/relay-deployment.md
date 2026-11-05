# Relay deployment command

For a first remote-phone setup, start with the [Agent deployment prompt](remote-access.en.md)
or [manual walkthrough](vps-relay-manual.md) ([中文](remote-access.md)). This page
documents the dedicated-server installer and its advanced options.

For a VPS that **runs the Hub and Bots**, use [host deployment](host-deployment.md).
This installer is for dedicated transport relays. The initiating host in the
examples may be a local computer or a VPS; it need not be a Mac.

The command is implemented and locally contract-tested. An isolated relay was
manually deployed and exercised through public TCP on an existing Ubuntu 26.04
VPS on 2026-10-02; see [the live acceptance record](vps-relay-public-acceptance.md).
The full dedicated-VPS installer has not been run against a fresh VPS. It installs the TLS relay,
OS security updates, an optional signed relay updater, and optional pinned ntfy
and Tailscale peer-relay packages. Companion services are configured only when
their corresponding configuration is present.

Upgrade the Hub runtime and relay bundle together for per-source rate-limit
isolation. The v2 mTLS control channel carries source metadata while preserving
opaque application TLS. A new Hub using an old relay remains functional but logs
`relay_source_unavailable_upgrade_relay`; remote clients on that relay still
share a legacy quota. No HTTP forwarding header is trusted. See
[source isolation and compatibility](relay-source-isolation.md).

Build with `npm run build`. This produces a standalone `dist/relay-runtime.mjs`
containing only the relay and its protocol validation dependency, without the
Hub database, engine SDKs, instance state or Google credentials.

Prepare a dedicated Debian/Ubuntu VPS with systemd and a verified SSH host entry.
Use root or a user with passwordless sudo. An unrecognized SSH host is refused;
verify and record its host key through your normal administrative process.
The installer supports x64 and arm64.

Create `relay-deploy.json` in the private Hub state directory:

```json
{
  "relay": {
    "serverName": "hub.example.com",
    "publicPort": 443,
    "tunnelPort": 7443,
    "healthPort": 9877,
    "clientFingerprint256": "REPLACE_WITH_MAC_CLIENT_CERTIFICATE_SHA256_FINGERPRINT",
    "tls": {
      "ca": "tunnel-ca.pem",
      "cert": "tunnel-server.pem",
      "key": "tunnel-server.key"
    }
  }
}
```

`serverName` is the Hub's public TLS name or a literal IP address. The three files are **tunnel**
credentials, relative to the configuration file. The server certificate must be
issued by the dedicated tunnel CA and its key must match. The fingerprint is the
colon-separated SHA-256 fingerprint of the Mac tunnel client certificate. The
Mac client private key, Hub identity key and Hub public-domain certificate private
key must stay on the Mac; do not put them in this deployment configuration.

```sh
node dist/src/index.js hub relay deploy --host my-vps --dry-run
node dist/src/index.js hub relay deploy --host my-vps
node dist/src/index.js hub relay status --host my-vps
```

`--config /private/path/relay-deploy.json` overrides the default. Dry run performs
local validation and resolves the current Node.js 24 LTS release from the official
Node.js site; it never connects to SSH or prints private key material. To reproduce
an exact runtime, add a `runtime` object with `version`, `x64` and `arm64`; the two
architecture values are archive SHA-256 hashes from the official release
`SHASUMS256.txt`. The installer verifies the chosen archive before extracting Node.

The installer creates a dedicated unprivileged service user, a hardened systemd
unit, a health timer, and content-addressed releases under `/opt/tarocub-relay`.
Unchanged application/configuration content does not restart the service. A failed
new process health check restores the previous release, managed unit/config files,
service enablement/running states, firewall and previous peer-relay port settings. Old releases remain for
operator inspection. Only a successful systemd check plus health response produces
the deployment receipt. `connected: false` means the relay process is healthy but
the Mac has not established its tunnel; it does not claim end-to-end connectivity.

This is a **dedicated VPS** installer: its own nftables table drops other new
inbound traffic while allowing the current SSH server port, public/tunnel ports,
established connections, loopback, ICMP and the Tailscale interface. It never
flushes unrelated firewall tables. Existing restrictive rules and cloud security
groups may still block the permitted ports and must be checked at deployment.
The health HTTP endpoint binds only to `127.0.0.1`; remote status reads it over SSH.

The dedicated firewall permits SSH and the configured public/tunnel ports, not
an extra HTTP-01 port 80 by default. Use a domain with a suitable DNS-01 renewal
workflow, or deliberately integrate HTTP-01 into the firewall/deployment policy.
Re-running this installer reapplies its own policy. For a shared VPS or the
public-IP/webroot example, follow the separate-service manual walkthrough.

Node is updated by re-running deployment with a newly tested runtime. OS security
updates use the distribution's signed repositories.
Public Hub TLS renewal and tunnel certificate rotation are separate operations.

## Dedicated public IP endpoints

A relay configured with a literal IP address accepts a complete TLS ClientHello
without SNI. This is required by clients connecting to an IP URL. The relay still
rejects a different explicit SNI value; a domain-configured relay still requires
its configured SNI. Incomplete or malformed hellos cannot select the IP route.
The Hub's end-to-end certificate must contain the public IP in its IP SAN, and
the paired Hub identity is still verified independently of certificate trust.

For a public IP certificate, Certbot 5.4 or later supports webroot validation
with `--ip-address` and `--preferred-profile shortlived`. Generate the private
key and CSR on the Hub computer, with an empty subject and an `IP:` SAN. Upload
only the CSR to the VPS. Do not put the IP in a CN: Certbot can interpret that CN
as an additional DNS identifier. Only the resulting public certificate chain
returns to the Hub; the Hub TLS and identity private keys remain there.

CSR issuance is not managed by `certbot renew`. Provision both a VPS issuance
timer and a Hub certificate refresh job. Validate the IP, validity window and
matching private key before atomically replacing the chain; defer a required Hub
restart during active work, retain the previous chain for rollback, and do not
start a host the user has stopped. Short-lived certificates require this full
renewal path, not just a one-time successful HTTPS request.

On a shared VPS, inventory existing services and listeners before installation.
Use a separate public port and a separate tunnel port instead of applying the
dedicated-VPS firewall policy above. HTTP-01 validation must remain available on
public port 80. An existing TLS service on port 80 can coexist through Nginx
`ssl_preread` routing plaintext ACME HTTP to a loopback HTTP listener and TLS to
the original service. Preserve the existing certificate hooks and verify both
protocols after changing the listener arrangement.

See [live IP relay evidence and phone setup](ip-relay-2026-10-12.md). Official
references: [Let's Encrypt IP certificates with Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot),
[Certbot CSR options](https://eff-certbot.readthedocs.io/en/stable/using.html),
[Nginx ssl_preread](https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html).

## Signed automatic relay updates

Add `updates` to the private deployment configuration when a release feed is ready:

```json
{
  "updates": {
    "url": "https://updates.example.com/relay.json",
    "publicKey": "-----BEGIN PUBLIC KEY-----\nYOUR_ED25519_PUBLIC_KEY\n-----END PUBLIC KEY-----\n",
    "minRelease": 100,
    "artifactOrigins": ["https://downloads.example.com"]
  }
}
```

The optional artifact origins extend the feed's own HTTPS origin. No redirect is
followed; use final, directly accessible HTTPS paths. `minRelease` is the lowest
release number the operator authorizes for the installation. A separate release
signing key is required; do not reuse Hub identity or tunnel keys. Only the public
key goes to the VPS, and the deploy validator rejects private-key PEM input.

The timer checks daily with randomized delay and shares a process lock with SSH
deployment and health recovery. It verifies the Ed25519 signature over the exact
manifest bytes, expiry, monotonically increasing release number, allowed artifact
origin, byte count and SHA-256 before installation. Unknown/corrupt state fails
closed. A bundle syntax check precedes the atomic release-link swap; startup or
health failure restores the old link and restarts the old service. Failed receipt
storage also rolls back. The active and immediately previous automatic releases
are retained; explicit SSH deployment revisions are kept for operator inspection.
An update briefly reconnects the TLS tunnel, so the client replay protocol still
applies. The update retains the already installed Node runtime, tunnel settings and optional
companion binaries/configuration; it restarts only the TLS relay. Manual update
invocations use the same lock as the timer and installer.

Prepare a signed feed locally after testing a bundle:

```sh
node dist/src/index.js relay release \
  --bundle dist/relay-runtime.mjs \
  --key-file /private/relay-release-signing.key \
  --out /private/releases/relay-100.json \
  --url https://downloads.example.com/relay-100.mjs \
  --release 100 --version 1.0.0
```

The private key must be an Ed25519 PEM file with private permissions (0600).
The output path must be new. The receipt includes only the public key, hash and
size. This command does not publish anything. The signed envelope contains a
base64url payload and signature; the payload declares protocol 1, release number,
version, creation/expiry times and the artifact URL/hash/size. It expires after
seven days; re-sign the same release metadata to refresh an unchanged feed, or
use a higher release number for changed bundle bytes. Expired metadata cannot
replace the installed program. Removing `updates` and redeploying disables the
timer. No feed, signing identity or VPS updater has been activated in development.

Local tests exercise signature/floor/origin/size/hash rejection, idempotency,
retention, syntax/startup/health/storage failure and rollback with temporary
directories and fake systemd/HTTP transports. Real Linux systemd/VPS acceptance
remains pending.

Sources: [Node.js releases](https://nodejs.org/en/about/previous-releases),
[Tailscale peer relay requirements](https://tailscale.com/docs/features/peer-relay),
[ntfy server configuration](https://docs.ntfy.sh/config/).

## Optional ntfy and Tailscale peer relay

Add these sections to the same private deployment file. Versions and checksums
are required so package changes are deliberate and reproducible. Obtain the
architecture-specific hashes from the selected official release; placeholders
below are intentionally invalid.

```json
{
  "ntfy": {
    "serverName": "push.example.com",
    "tlsPort": 8443,
    "healthPort": 2586,
    "tls": { "cert": "push-fullchain.pem", "key": "push-key.pem" },
    "username": "phone",
    "passwordHash": "BCRYPT_HASH_FROM_NTFY_USER_HASH",
    "archive": {
      "version": "2.28.0",
      "x64": "SHA256_OF_OFFICIAL_LINUX_AMD64_TAR_GZ",
      "arm64": "SHA256_OF_OFFICIAL_LINUX_ARM64_TAR_GZ"
    }
  },
  "peerRelay": {
    "port": 443,
    "staticEndpoints": ["192.0.2.10:443"],
    "hostname": "tarocub-relay",
    "authKeyFile": "tailscale-enrollment.key",
    "archive": {
      "version": "1.86.0",
      "x64": "SHA256_OF_OFFICIAL_AMD64_TGZ",
      "arm64": "SHA256_OF_OFFICIAL_ARM64_TGZ"
    }
  }
}
```

Versions above illustrate the minimum supported configuration format, not a
recommendation to deploy an old release. Choose a currently maintained release
at deployment. Packages download only from the official ntfy GitHub release or
Tailscale package host and must match the configured SHA-256 before extraction.
No downloaded installation script is executed. Companion updates are explicit
redeployments; the signed automatic feed updates only TaroCub relay code.

ntfy uses its own DNS name and TLS certificate. TCP 443 inspects SNI and forwards
that name to ntfy's loopback TLS listener; the Hub name continues through the Mac
tunnel. Unknown names are rejected. ntfy stays available when the Mac tunnel is
down. ntfy's TLS terminates on the VPS, but the TaroCub UnifiedPush body is encrypted
for the Android device. The Hub's domain certificate and identity keys stay on the
Mac. Renew the separate ntfy certificate and redeploy before expiry.

The ntfy service denies access by default, permits anonymous writes only to `up*`
topics for UnifiedPush compatibility, and requires the configured phone account
to subscribe. Generate its bcrypt value with `ntfy user hash`; enter the original
password into the ntfy Android distributor, never into the Hub. File attachments,
signup and forwarded-IP trust are disabled. The TCP proxy does not supply HTTP
forwarding headers, so rate limits are deliberately shared across this small
private instance. Cached encrypted notifications and account state live under
`/var/lib/tarocub-ntfy`. Both ntfy ports bind only to loopback.

For Tailscale, prepare an enrollment auth key in a 0600 file and create the
appropriate **tailnet relay capability grant** during deployment. The key is
transferred into a private temporary file, used only when the daemon needs login,
and deleted on script exit; it is absent from releases and printed receipts.
The installer owns `tarocub-tailscaled.service` and private state under
`/var/lib/tarocub-tailscale`. It refuses a separately running `tailscaled.service`
and requires `/dev/net/tun`. It never replaces or broadens tailnet ACLs.

Peer relay needs an inbound **UDP** port; the default is UDP 443, alongside the
existing TCP 443 and tunnel port. Static endpoints must be literal IP:port pairs.
The current SSH port remains allowed. Cloud firewall rules must also permit the
chosen UDP port. The status command reports service state, backend login state
and the configured port, but deliberately labels tailnet policy verification as
pending; actual peer-relay traffic must be verified between authorized devices.

Both sibling services use systemd restart policies and the shared health timer.
An unchanged deployment does not restart them. Removing an already installed
companion from configuration is rejected to prevent accidental service loss;
explicit decommissioning and data handling are separate operations. Rollback
restores managed program/configuration files, not third-party database migrations
or tailnet enrollment. Back up their state before a third-party version upgrade.

Local verification uses real TLS sockets for SNI separation, actual Bash and
filesystem changes with mock systemd/network commands for installer rollback,
and redacted health/status tests. Full Linux service startup, actual ntfy auth/
delivery and Tailscale tailnet access are not yet verified.

Configuration sources: [ntfy server options](https://docs.ntfy.sh/config/),
[official ntfy packages](https://docs.ntfy.sh/install/),
[Tailscale peer relay setup and grants](https://tailscale.com/docs/features/peer-relay).


## Multiple primary and backup VPS relays

A Hub can maintain up to eight independent outgoing mTLS tunnels. They are all
warm: a disconnected primary does not stop a backup. Client route priority,
not the order in which tunnels connect, chooses the path. No DNS failover or
second Bot runtime is needed. Each VPS still forwards opaque Hub TLS bytes;
it stores neither conversation state nor file copies. The Mac mini, its network
and the Hub remain a shared dependency. This feature is locally verified;
provisioning and production path acceptance remain deferred.

Use distinct public origins (for example `hub-a.example.com` and
`hub-b.example.com`), each resolving to its own VPS. Give each tunnel its own
credentials. Create a separate deployment file per VPS using the schema above:
`relay-primary-deploy.json` with `relay.serverName=hub-a.example.com`, and
`relay-backup-deploy.json` with `relay.serverName=hub-b.example.com`. Each file
contains only that VPS's tunnel credentials and allowed Mac client fingerprint.
The existing Debian/Ubuntu systemd installer runs independently per server:

```sh
node dist/src/index.js hub relay deploy --host vps-primary --config /private/hub/relay-primary-deploy.json --dry-run
node dist/src/index.js hub relay deploy --host vps-backup --config /private/hub/relay-backup-deploy.json --dry-run
```

When deployment is authorized, run each with its same arguments minus `--dry-run`.
Check both remote receipts with `hub relay status --host <alias>`. A successful
installation is not yet evidence of a working Mac tunnel or client route.

On the Mac, replace the legacy singular `relay` with `relays` in the private Hub
`config.json`; setting both is rejected. Every target must match a configured
loopback TLS listener. Multiple public names can share that listener via SNI:

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "origins": ["https://hub-a.example.com", "https://hub-b.example.com"],
  "tlsListeners": [{
    "host": "127.0.0.1",
    "port": 9443,
    "tls": {
      "cert": "/private/hub/tls/hub-a.pem",
      "key": "/private/hub/tls/hub-a.key",
      "sni": {
        "hub-a.example.com": {"cert": "/private/hub/tls/hub-a.pem", "key": "/private/hub/tls/hub-a.key"},
        "hub-b.example.com": {"cert": "/private/hub/tls/hub-b.pem", "key": "/private/hub/tls/hub-b.key"}
      }
    }
  }],
  "relays": [
    {
      "id": "primary", "label": "Primary VPS", "host": "tunnel-a.example.com", "port": 7443,
      "servername": "tunnel-a.example.com", "targetHost": "127.0.0.1", "targetPort": 9443,
      "tls": {"ca": "/private/hub/tls/a-ca.pem", "cert": "/private/hub/tls/a-mac.pem", "key": "/private/hub/tls/a-mac.key"}
    },
    {
      "id": "backup", "label": "Backup VPS", "host": "tunnel-b.example.com", "port": 7443,
      "servername": "tunnel-b.example.com", "targetHost": "127.0.0.1", "targetPort": 9443,
      "tls": {"ca": "/private/hub/tls/b-ca.pem", "cert": "/private/hub/tls/b-mac.pem", "key": "/private/hub/tls/b-mac.key"}
    }
  ]
}
```

The `tunnel-*` domains identify the VPS tunnel certificates; `hub-*` domains
identify the end-to-end public Hub certificates held only on the Mac. For trusted development browsers only, put the exact page origin in `origins`.
A browser cannot pin the actual Hub TLS leaf. Do not use a page served by an
untrusted VPS as the protected production client; use the native App with its
pinned end-to-end transport. An origin allowlist does not add browser pinning. Native app origins are already supported. This
example uses a loopback-only plain listener for the Mac and separate loopback TLS
for relays; no public/plaintext Hub listener is exposed. Add the existing
Tailscale TLS listener separately if desired.

`hub relay status` now returns `configured`, `online` (at least one tunnel),
`allOnline`, and `servers: [{id,label?,online}]`; a failed backup must not be hidden
by the aggregate `online` field. Old singular `relay` configs keep working and
appear as server ID `primary`. Local certificate/config errors fail startup;
remote connection failures reconnect independently and do not stop healthy peers.
Full-state backups preserve files inside the Hub state tree and report external
or relative certificate paths for every configured tunnel, including backups;
restore does not silently copy credentials from outside that tree.
The existing `routeMonitor.routes` accepts the same ordered multi-VPS origins and
optional labels, so each failing VPS has its own durable outage/alert identity.

Configure the client with `https://hub-a.example.com` followed by
`https://hub-b.example.com` in Settings → Connection routes. Labels and order are
preserved on reload and in pairing QR codes. Preferences are device-local; update
already-paired devices as needed. Route saving does not interrupt a healthy
in-flight connection if its address remains in the list. A startup/pairing probe
uses an available route; authenticated reconnection always verifies the same
pinned Hub identity. There is no automatic migration to another Hub database.
