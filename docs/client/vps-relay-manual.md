# Manual VPS relay setup

[中文手动教程](vps-relay-manual.zh-CN.md) · [中文 Agent 提示词](remote-access.md) · [English overview](remote-access.en.md)

This walkthrough keeps Bots on an **existing computer** and adds a relay on a
Debian/Ubuntu VPS with systemd. It does not create a new Hub. Commands on the
computer assume macOS/Linux and a POSIX shell; Windows needs native service and
scheduled-task equivalents. Review placeholders before executing a block.

## 1. Inventory and private paths — computer

Have Node.js 24, OpenSSL 3, a built current checkout (`npm ci && npm run build`),
SSH access to the VPS, and the existing Hub's state directory. On the VPS, have
Node.js 24 and Certbot 5.4+ available at known absolute paths. Use the
[Certbot installation instructions](https://certbot.eff.org/instructions) for its
current installation method. The desktop app's bundled runtime can manage its
own Hub; building the relay requires the source checkout.

Set these to **your** paths. The documentation IPv4 below is not routable:

```sh
export TARO_VPS_IP='192.0.2.10'
export TARO_HUB_DIR='/absolute/path/to/existing-hub'
export TARO_PACKAGE_DIR='/absolute/path/to/host-package'
export TARO_NODE='/absolute/path/to/node'
export TARO_RELAY_DIR="$TARO_HUB_DIR/vps-relay"
umask 077
mkdir -p "$TARO_RELAY_DIR"
chmod 700 "$TARO_RELAY_DIR"
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub service status --state-dir "$TARO_HUB_DIR"
```

For the macOS app installed in Applications, the usual values are:

- Hub: `$HOME/Library/Application Support/com.tarocub.client/host`
- Package: `/Applications/TaroBot.app/Contents/Resources/host`
- Node: `/Applications/TaroBot.app/Contents/Resources/host/node`

Source installations use the **actual** `--state-dir` used to start that Hub.
The CLI default is `$HOME/.cctb/hub`, which is not the desktop app's directory.
Record the existing status/public key and make a private backup before editing.
Preserve `config.json`, `identity.json`, the database and attachments; do not copy
a live SQLite file without its WAL. Use the [Hub backup commands](operations.md#backup-and-export).

In `~/.ssh/config`, add an alias using your VPS account and local key path:

```sshconfig
Host tarobot-relay
    HostName 192.0.2.10
    User ubuntu
    IdentityFile /absolute/path/to/vps.pem
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 10
```

Verify the VPS SSH host-key fingerprint through its cloud console before adding
it to `known_hosts`. Keep the private key local and readable only by your account.
If SSH needs an encrypted key unlocked, unlock it using your normal SSH agent;
unattended renewal must have an authorized non-interactive authentication path.

```sh
ssh tarobot-relay 'sudo -n true && sudo ss -lntp'
```

Choose unused ports. Below, public HTTPS is **8443**, host tunnel **7443**, relay
health **19878 on VPS loopback**, and Hub TLS **9443 on computer loopback**. Check
the computer's listener list too. Retain existing sites, SSH, firewall rules and
certificate jobs. These steps add a service; they do not apply the dedicated-VPS
firewall from `hub relay deploy`.

## 2. Separate tunnel credentials — computer

Run once in the new private directory. Do not overwrite existing tunnel keys:

```sh
set -eu
cd "$TARO_RELAY_DIR"
for tls_key in tunnel-ca.key tunnel-client.key tunnel-server.key; do
  if test -e "$tls_key"; then printf 'Existing key: %s\n' "$tls_key" >&2; exit 1; fi
done
openssl req -x509 -newkey rsa:3072 -nodes -keyout tunnel-ca.key \
  -out tunnel-ca.pem -days 3650 -subj '/CN=TaroBot private tunnel CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes -keyout tunnel-server.key \
  -out tunnel-server.csr -subj '/CN=tarobot-tunnel.internal'
cat > tunnel-server.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:tarobot-tunnel.internal
EOF
openssl x509 -req -in tunnel-server.csr -CA tunnel-ca.pem -CAkey tunnel-ca.key \
  -CAcreateserial -out tunnel-server.pem -days 365 -extfile tunnel-server.ext
openssl req -new -newkey rsa:3072 -nodes -keyout tunnel-client.key \
  -out tunnel-client.csr -subj '/CN=TaroBot host tunnel client'
cat > tunnel-client.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
openssl x509 -req -in tunnel-client.csr -CA tunnel-ca.pem -CAkey tunnel-ca.key \
  -CAcreateserial -out tunnel-client.pem -days 365 -extfile tunnel-client.ext
openssl x509 -in tunnel-client.pem -noout -fingerprint -sha256
```

Save the printed SHA-256 fingerprint for step 4. `tarobot-tunnel.internal` is the
name inside the private tunnel certificate; it does not require public DNS. Keep
the CA key and client key on the computer. Only the CA **certificate**, tunnel
server certificate and tunnel server key go to the VPS. Plan their rotation
before the one-year expiry; this is separate from public HTTPS renewal.

## 3. Trusted public IP certificate — both machines

The example uses a fixed public IPv4, so no domain is required. A domain is also
supported: use its DNS SAN/name, point DNS to the VPS, and configure the ACME
challenge/renewal appropriate to that domain. Do not use a self-signed public
certificate or disable client TLS verification to work around issuance failure.

**Computer:** generate the business HTTPS key and CSR. Keep the subject empty;
the IP belongs in an IP SAN, not a CN.

```sh
set -eu
cd "$TARO_RELAY_DIR"
test ! -e hub.key
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out hub.key
openssl req -new -key hub.key -out hub.csr -subj '/' \
  -addext "subjectAltName=IP:$TARO_VPS_IP"
ssh tarobot-relay 'umask 077; mkdir -p ~/tarobot-stage'
scp hub.csr tarobot-relay:tarobot-stage/hub.csr
```

**VPS:** configure a webroot served over public **HTTP port 80** for
`/.well-known/acme-challenge/`. If Nginx already serves HTTP, add this location to
the server block selected for the public IP, preserving its other routes:

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/lib/tarobot-acme;
    try_files $uri =404;
}
```

For an otherwise unused port 80, install Nginx and put that location in a server
block listening on 80. Run `sudo nginx -t` before reload. If port 80 already
serves **TLS**, this HTTP location alone is insufficient: preserve that service
using [protocol routing](relay-deployment.md#dedicated-public-ip-endpoints), or
use a domain with DNS-01 validation. Do not stop an unrelated site to free a port.
Cloud and OS firewalls must allow the ACME validation path on 80.

```sh
sudo install -d -m 0755 /var/lib/tarobot-acme/.well-known/acme-challenge
sudo install -d -m 0755 /var/lib/tarobot-public-tls
sudo install -m 0644 ~/tarobot-stage/hub.csr /var/lib/tarobot-public-tls/hub.csr
```

Check a harmless challenge file from outside the VPS before issuance, then
remove it. Locate Certbot (`command -v certbot`, `certbot --version`) and register
your ACME account using your own email/terms acceptance. Create the following
root-owned script at `/usr/local/sbin/tarobot-renew-public-tls` (mode 0755), replacing
the IP and Certbot path. It also performs the first issuance when no chain exists:

```sh
#!/bin/sh
set -eu
umask 077
exec 9>/run/tarobot-public-tls.lock
flock -n 9 || exit 0
tls_root=/var/lib/tarobot-public-tls
if openssl x509 -in "$tls_root/fullchain.pem" -noout -checkend 259200 >/dev/null 2>&1; then exit 0; fi
tls_stage=$(mktemp -d "$tls_root/staging.XXXXXX")
trap 'rm -rf "$tls_stage"' EXIT
/absolute/path/to/certbot certonly --non-interactive --webroot \
  -w /var/lib/tarobot-acme --preferred-profile shortlived --ip-address 192.0.2.10 \
  --csr "$tls_root/hub.csr" --cert-path "$tls_stage/cert.pem" \
  --chain-path "$tls_stage/chain.pem" --fullchain-path "$tls_stage/fullchain.pem"
openssl x509 -in "$tls_stage/fullchain.pem" -noout -checkip 192.0.2.10
openssl x509 -in "$tls_stage/fullchain.pem" -noout -checkend 259200
for tls_name in cert.pem chain.pem fullchain.pem; do
  install -m 0644 "$tls_stage/$tls_name" "$tls_root/$tls_name.new"
  mv "$tls_root/$tls_name.new" "$tls_root/$tls_name"
done
```

Run `sudo /usr/local/sbin/tarobot-renew-public-tls`. The VPS receives only the CSR;
`hub.key` stays on the computer. Download the resulting **public** fullchain:

```sh
# Computer
scp tarobot-relay:/var/lib/tarobot-public-tls/fullchain.pem "$TARO_RELAY_DIR/fullchain.pem"
openssl x509 -in "$TARO_RELAY_DIR/fullchain.pem" -noout -checkip "$TARO_VPS_IP" -dates
```

IP certificates use the short-lived profile. CSR issuance is not automatically
managed by `certbot renew`; complete step 6 before treating this as a lasting
deployment. See [Let's Encrypt IP certificate support](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
and [Certbot's CSR/renewal documentation](https://eff-certbot.readthedocs.io/en/stable/using.html).

## 4. Install the standalone relay — VPS

**Computer:** build from a current checkout, then upload only the relay bundle
and the explicit server-side tunnel credentials:

```sh
# From the source checkout, not the app bundle
npm ci
npm run build
scp dist/relay-runtime.mjs tarobot-relay:tarobot-stage/relay.mjs
scp "$TARO_RELAY_DIR/tunnel-ca.pem" "$TARO_RELAY_DIR/tunnel-server.pem" \
  "$TARO_RELAY_DIR/tunnel-server.key" tarobot-relay:tarobot-stage/
```

**VPS:** create an unprivileged service account if it does not already exist.
For an existing installation, inspect its owner/configuration and back it up
instead of overwriting it with these first-install commands.

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin tarobot-relay
sudo install -d -o root -g tarobot-relay -m 0750 /opt/tarobot-relay
sudo install -o root -g tarobot-relay -m 0640 ~/tarobot-stage/relay.mjs \
  ~/tarobot-stage/tunnel-ca.pem ~/tarobot-stage/tunnel-server.pem \
  ~/tarobot-stage/tunnel-server.key /opt/tarobot-relay/
rm ~/tarobot-stage/tunnel-server.key
```

Create `/opt/tarobot-relay/relay.json` with root ownership, group `tarobot-relay`,
mode 0640. Replace the public IP and fingerprint (omit OpenSSL's `sha256 Fingerprint=` prefix):

```json
{
  "serverName": "192.0.2.10",
  "publicPort": 8443,
  "tunnelPort": 7443,
  "healthPort": 19878,
  "maxConnections": 128,
  "clientFingerprint256": "REPLACE_WITH_COLON_SEPARATED_SHA256_FINGERPRINT",
  "tls": {
    "ca": "/opt/tarobot-relay/tunnel-ca.pem",
    "cert": "/opt/tarobot-relay/tunnel-server.pem",
    "key": "/opt/tarobot-relay/tunnel-server.key"
  }
}
```

Save `/etc/systemd/system/tarobot-relay.service` (root-owned, mode 0644). Replace
the Node path with a system-wide Node 24 executable readable by the service
account; an executable under another user's home can be blocked by `ProtectHome`.

```ini
[Unit]
Description=TaroBot TLS passthrough relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=tarobot-relay
Group=tarobot-relay
ExecStart=/absolute/path/to/node /opt/tarobot-relay/relay.mjs --config /opt/tarobot-relay/relay.json
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tarobot-relay
sudo systemctl status tarobot-relay --no-pager
curl --fail --max-time 5 http://127.0.0.1:19878/health
```

An initial `connected: false` is expected until step 5. Add inbound TCP 8443 and
7443 to **both** the cloud security group and existing OS firewall. Preserve SSH
access and existing service rules. Do not expose 19878, computer port 9443, Hub
HTTP/instance ports or its control socket. The default outbound rules must let
the computer reach VPS 7443. A raw IPv4 entry needs the current relay's no-SNI
support; do not deploy an older bundle merely because the phone app is current.

## 5. Append the original Hub configuration — computer

Keep the original `host`, `port`, `instancePort`, LAN/Tailscale listeners and
other fields. Back up `config.json` and **merge** the entries below into its
`origins`, `tlsListeners` and `relays` arrays. Replace every private path and IP.
Do not replace the whole configuration with this partial example:

```json
{
  "origins": ["https://192.0.2.10:8443"],
  "tlsListeners": [{
    "host": "127.0.0.1",
    "port": 9443,
    "tls": {
      "cert": "/absolute/path/to/existing-hub/vps-relay/fullchain.pem",
      "key": "/absolute/path/to/existing-hub/vps-relay/hub.key"
    }
  }],
  "relays": [{
    "id": "vps-primary",
    "label": "My VPS",
    "host": "192.0.2.10",
    "port": 7443,
    "servername": "tarobot-tunnel.internal",
    "targetHost": "127.0.0.1",
    "targetPort": 9443,
    "tls": {
      "ca": "/absolute/path/to/existing-hub/vps-relay/tunnel-ca.pem",
      "cert": "/absolute/path/to/existing-hub/vps-relay/tunnel-client.pem",
      "key": "/absolute/path/to/existing-hub/vps-relay/tunnel-client.key"
    }
  }]
}
```

If the config has legacy singular `relay`, migrate that entry into `relays`
with a unique `id`; do not retain both. Every relay target must match a loopback
TLS listener. Finish ongoing work before restarting. For the app/detached Hub:

```sh
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub service restart --state-dir "$TARO_HUB_DIR"
"$TARO_NODE" "$TARO_PACKAGE_DIR/dist/src/index.js" hub relay status --state-dir "$TARO_HUB_DIR"
```

A systemd-managed Hub must be restarted through **its existing unit**, not by
starting a second detached Hub. Check `online: true`, compare the original and
public `/health` Hub public keys, then complete authenticated pairing/sync in
step 7. A public-key comparison alone is not a cryptographic identity proof.

## 6. Renew and load certificates — both machines

**VPS:** schedule the issuance script from step 3. Save these as
`/etc/systemd/system/tarobot-public-tls.service` and `.timer` respectively:

```ini
[Unit]
Description=Renew TaroBot public certificate from host CSR
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tarobot-renew-public-tls
UMask=0077
```

```ini
[Unit]
Description=Check TaroBot public certificate every six hours
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
RandomizedDelaySec=2min
Persistent=true
[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tarobot-public-tls.timer
sudo systemctl start tarobot-public-tls.service
sudo systemctl list-timers tarobot-public-tls.timer --no-pager
sudo journalctl -u tarobot-public-tls.service -n 20 --no-pager
```

**Computer:** arrange an hourly launchd job (macOS) or user systemd timer (Linux)
running as the account that owns the Hub. Its refresh action must:

1. Retrieve only `/var/lib/tarobot-public-tls/fullchain.pem` through verified SSH
   or an independently trusted HTTPS endpoint; enforce a download timeout/size cap.
2. Check the IP/domain, current validity, private-key match, and a newer expiry
   before installation. Retain the old chain. Never download/replace `hub.key`.
3. Do nothing when the chain is unchanged. Defer a necessary restart while the
   Hub has active work. Atomically replace the chain under the Hub's
   `desktop-start` file mutex; restart only a currently running Hub with its
   existing service manager and verify the same identity. Roll back on failure.
4. Keep a stopped Hub stopped. Keep credentials out of the job's arguments/logs,
   and check its last exit status. An SSH key needing an unavailable interactive
   unlock will prevent unattended refresh; arrange that authentication first.

The relay installer does **not** install this host refresh job. The exact service
paths and manager vary by installation; use the [Agent instructions](remote-access.en.md#ask-an-agent-to-configure-it)
to create it for your host if you do not maintain local scheduled jobs. Until
that job is installed, certificate transfer and Hub restart are manual maintenance:

```sh
# Computer: private staging only; validate before replacing the active chain.
scp tarobot-relay:/var/lib/tarobot-public-tls/fullchain.pem "$TARO_RELAY_DIR/fullchain.next.pem"
openssl x509 -in "$TARO_RELAY_DIR/fullchain.next.pem" -noout -checkip "$TARO_VPS_IP" -checkend 86400
"$TARO_NODE" --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
const directory = process.env.TARO_RELAY_DIR;
const next = new X509Certificate(await readFile(directory + '/fullchain.next.pem'));
const old = new X509Certificate(await readFile(directory + '/fullchain.pem'));
const key = createPrivateKey(await readFile(directory + '/hub.key'));
if (!next.checkIP(process.env.TARO_VPS_IP) || !next.checkPrivateKey(key)
    || Date.parse(next.validFrom) > Date.now() || Date.parse(next.validTo) < Date.now() + 86400000
    || Date.parse(next.validTo) < Date.parse(old.validTo)) throw new Error('Invalid renewed certificate');
console.log('Certificate validated. Install only after the Hub is idle.');
JS
```

After validation and when idle, privately retain `fullchain.pem` as
`fullchain.previous.pem`, replace it with the staged file, then restart the same
Hub as in step 5. Restore the previous chain if verification fails. Certificates
issued from this CSR must be renewed repeatedly; a one-off copy is not unattended
operation. Check both the VPS timer and the computer job, and monitor expiry.

## 7. Phone connection and acceptance

For an existing paired phone: **Me → Settings → Connection → Edit routes**;
choose **本地电脑运行 Bot / Run Bots on a local computer**, preserve the direct route,
add the deployed `https://YOUR_VPS_IP:8443` as a VPS route, and save. Do not delete
the old host or reset pairing. For a new phone, use the original host's trusted
identity/QR and approve its pairing code: [Chinese steps](remote-access.md#手机怎么填).

Verify all of these, keeping the scope of each result explicit:

- `curl --fail --max-time 15 https://YOUR_VPS_IP:8443/health` succeeds with normal
  TLS verification. No `-k`, custom trust bypass or HTTPS-terminating proxy.
- The original paired native client connects: its TLS-identity verification and
  signed device authentication succeed, then the original Bots/history sync.
- Unauthenticated `curl -i https://YOUR_VPS_IP:8443/api/conversations` returns 401.
- Switching the phone from Wi-Fi to cellular still connects through the VPS.
- Restart only the relay service; its tunnel and phone connection recover.
- Existing VPS sites/services and original LAN routes still work.
- Public certificate renewal and host loading jobs are scheduled and their
  current executions succeed. Record whether a real rotation has occurred.

Only process health is confirmed by `connected: false`; even `connected: true`
does not prove a physical phone completed authentication. The VPS must remain
online, and the original computer must stay awake with its Hub and Bots running.
Keep all deployment files and secrets outside Git. The public address does not
grant access, but do not approve unfamiliar devices.
