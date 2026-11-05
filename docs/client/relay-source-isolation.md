# Relay source isolation and authentication quotas

The October 11 review reproduced a shared-loopback lockout: a relay forwards to
the Hub through a local TCP socket, so every remote client previously consumed
the same address-based quotas as the desktop. Unknown device IDs and failed
signatures also blocked successful authentication from other devices.

## Source transport

The relay and Hub tunnel negotiate `tarocub-relay-control-v2` using the existing
mutual TLS control connection. For each `open` frame, the relay adds the IP
address observed on its public socket. This is metadata outside the opaque
client-to-Hub TLS stream; the relay still cannot decrypt messages or files.

The host tunnel registers the exact local TCP four-tuple before it forwards the
ClientHello. The Hub resolves that connection through a shared process-local
`RelaySources` registry. HTTP requests capture the result before waiting on their
body; WebSocket upgrades retain it for the handshake. No proxy prelude is accepted
on the Hub listener, and `Forwarded`, `X-Forwarded-For` and `X-Real-IP` headers
cannot register or replace a source. IPv4-mapped and equivalent IPv6 spellings
are normalized.

Each source is namespaced by the configured relay ID. A remote peer reported as
loopback still remains a relay peer; it cannot consume the actual desktop's
source bucket or obtain worker API access. Metadata affects rate limits and
audit attribution only, never device authorization. The authenticated relay is
trusted to report its observed source honestly, not to approve a device.

The registry allows at most 2,048 active entries, rejects duplicate/capacity
overflow registrations before forwarding, and removes an entry when its exact
socket closes. An old close callback cannot remove a replacement entry.

## Authentication budgets

- Pairing and TLS identity proofs retain their existing source-based quotas.
- Unknown/revoked device challenges use a separate per-source bucket. They do
  not consume an enrolled device's challenge quota.
- Known device challenges and invalid signatures use a source-and-device key.
  Exhausting one device's quota does not exhaust another's quota.
- Correct signatures are not rejected because another request exhausted a
  failed-signature counter. The challenge still needs to be admitted and fresh.
- Bucket memory is bounded to 4,096 anonymous entries and 4,096 reserved entries
  for known-device operations and actual local callers. A full table rejects
  new keys without evicting an existing caller. Expired entries are reclaimed on
  subsequent activity. Pending login challenges are also capped at 2,048.

This is availability isolation, not DDoS immunity. Devices behind the same public
NAT still share anonymous pairing/proof quotas. An attacker targeting a known
device ID from the same source can consume its challenge quota; a sufficiently
distributed flood can saturate finite capacity. A compromised relay can lie
about source addresses or stop forwarding altogether. None of these metadata
values replaces TLS binding, owner approval or device signatures.

## Upgrade and compatibility

Upgrade both the Hub runtime and the relay bundle to enable source separation.
The new relay still sends the exact v1 control frame shape to old tunnels. A new
Hub can connect to an old relay using v1, logs
`relay_source_unavailable_upgrade_relay`, and places that relay's clients into a
shared legacy bucket separate from the desktop. It cannot recover individual
public sources from v1. A v2 control connection missing required source metadata
is closed rather than silently treated as a local connection.

No config secrets, certificates or firewall rules need changing for this
protocol upgrade. Programmatic embeddings must pass one `RelaySources` instance
to both `HubServer` and `RelayTunnels.load`; the standard `hub run` path does this.

## Verification scope

Three baseline tests reproduced unknown-device, failed-signature and
cross-device lockouts before the repair. Local integration then used a real Hub,
real relay, mTLS tunnel, and distinct IPv4/IPv6 socket sources. Exhausting 60 TLS
proofs or 10 pairing attempts from one relayed source left another source and the
direct desktop working. Changing forwarding headers did not bypass the quota;
WebSocket audit records contained the authenticated tunnel's source metadata.
Compatibility tests cover old-tunnel frame shape, old-relay warning/fallback and
missing-v2-source rejection. Registry and authentication tests cover capacity,
expiry, cleanup, equivalent address forms and reserved known/local capacity.

These are local transport/code receipts, not a new public-VPS deployment or
cellular-phone acceptance. No production relay or Hub was restarted for them.
