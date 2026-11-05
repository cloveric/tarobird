# One name for the host computer and its native desktop device

After renaming the host to `example-mac`, Devices & Security still displayed the
native desktop's old pairing name, such as “这台电脑”, under “你正在使用”.
The detail page also suggested a second, independent rename. The host profile
and the native controller's device record were separate sources of names.

Native desktop enrollment now binds the proven device key to the host name.
Both new enrollments and already trusted legacy controllers are covered. A
fresh native challenge/signature is required to add the name binding; platform,
display name, loopback access and being the current device are not evidence.
The binding is additive metadata on the existing controller marker. It changes
neither the protocol version nor Hub schema 15.

The device row is synchronized inside the same transaction as enrollment or
host-profile renaming. A failure rolls back the profile revision and device
names together. Reconnecting with an old client-local name cannot undo the
host's name. A revoked, wrong-key or non-owner marker cannot synchronize names.
Phones, remote computers and the separately enrolled `TaroBot CLI` keep their
own device names.

`GET /api/devices` adds `nameSource: "host"` for verified linked devices. Their
settings rows track the acknowledged host profile even while the page is open.
Their detail page explains the shared name and opens the existing host rename
flow, without a second device-name editor or legacy-name hint. Other devices
keep their ordinary rename flow. The old device rename endpoint rejects a
linked row with `host_device_name_managed`; it checks ownership before revealing
that distinction.

## CLI and verification

`tarobot name` uses the same revision-checked host-profile API and updates linked
desktop names without opening a desktop window. `devices list` exposes the
binding and `devices rename` remains available for independent accessing devices.
CLI help and the operator guide describe the distinction. This change does not
alter Codex, Claude, Antigravity, Kimi or DeepSeek execution behavior.

The regression first reproduced “这台电脑” after an acknowledged `example-mac`
rename. Hub tests cover native proof enrollment and legacy migration on both
desktop platform values, CLI renaming, reconnects, independent devices, atomic
failure, revocation, wrong keys and cross-user API rejection. Browser checks use
two independently paired clients and exercise settings, the shared rename flow,
live propagation and reload. The browser stands in for the native renderer; its
seeded name binding does not constitute native keychain or real-phone evidence.
Packaging and actual installed-version receipts remain separate release gates.
