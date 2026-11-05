# Re-pair after complete client removal — 2026-10-28

## Requested behavior and prior state

A companion phone or computer must not silently reconnect to Host A after the
App and its installation data are completely removed and installed again.
Host A's identity, Bots, sessions and history must remain untouched.

The prior implementation stored device seeds in the OS vault independently of
App data. A clean phone uninstall usually removed the WebView host registry,
so Keychain survival alone did **not** prove automatic reconnection. However,
there was no native installation boundary when old key references were restored.
Desktop binary removal can retain both the registry and OS credential.
Android already used AndroidKeyStore and `allowBackup=false`.

Apple's [Developer Technical Support guidance](https://developer.apple.com/forums/thread/36442)
says not to rely on Keychain deletion at uninstall and recommends a separate
on-disk key. Android's [backup documentation](https://developer.android.com/identity/data/autobackup)
notes that `allowBackup=false` does not disable device transfer on every OEM.
These platform facts are separate from physical acceptance of TaroBot.

## Implementation

- iOS: a random 256-bit installation key lives in Application Support, explicitly
  excluded from backup. AES-256-GCM seals device seeds before the existing
  app-only, non-synchronizing, ThisDeviceOnly Keychain store. Associated data
  includes the device key reference. The installation key is never in Keychain
  or returned through IPC. Missing installation data creates a new key; old
  credentials cannot be decrypted. Invalid/unreadable marker data fails closed.
- Desktop: an app-local-data marker holds a random 256-bit key, created with
  exclusive file creation (0600 on Unix). `ring` AES-256-GCM wraps seeds before
  OS-vault storage. Only successfully decrypted seeds can sign authentication
  or device-action proofs. Invalid marker data and tampered envelopes fail
  closed. The application version is not part of the binding, so subsequent
  in-place updates and restarts retain authorization.
- The original unwrapped remote credentials are **not silently adopted**.
  Existing iOS and companion desktop installations need to re-pair once when
  first upgrading to this policy. Android's existing keys retain their current
  installation behavior. Legacy local desktop controller keys may migrate
  only after the real local Host accepts its existing native challenge proof;
  there is no remote approval bypass or change to Host trust rules. A key
  wrapped by another installation cannot use that migration path.
- Windows full-data reset still keeps its existing recovery backup of local
  data, but removes the installation key from that backup after all moves
  commit. A failed move rolls back before key retirement. If retirement cannot
  complete, reset reports failure and retains the backup for diagnosis.
- Android: both legacy backup rules and Android 12+ cloud/device-transfer rules
  exclude app data, preferences, databases, app external data and device-protected
  equivalents. Native wrapping keys remain in AndroidKeyStore.
- The client treats `device_pairing_required` as a local authorization boundary:
  it closes the connection, stops automatic retries, disables sending, and
  retains existing cached history/drafts without draining the outbox. It does
  not persist a false Host revocation. Localized guidance points to removing
  the old connection and scanning a new QR. Existing removal UI warns before
  clearing local drafts/queued content; Host history is not deleted.

## Exact boundary and handoff

**This does not turn deleting only a Mac `.app` into a full-data uninstall.**
Mac app replacement, Trash operations and manual copying do not provide this
App with a reliable uninstall event. Retaining app data retains its installation
key. Likewise, iOS Offload App retains data; use Delete App for complete removal.
A Windows uninstall that deliberately keeps app data is not a full-data reset.
No binary inode/version heuristic was added: it would confuse ordinary updates
with uninstall and can also miss reinstalls.

Desktop full-system backups, manual copies of the installation key, a compromised
OS account, pre-policy backups/older App versions, and forensic secure erasure
are outside this guarantee. iOS automatic backup excludes the new marker;
Windows fresh-start recovery backups deliberately retire it. Old unwrapped
credentials are not retroactively erased by an uninstalled old version.

Uninstall cannot reliably send a revocation to an offline Host. For a device
handoff, the existing owner-side **Devices → Revoke** operation on Host A is the
strong boundary: it rejects the old identity regardless of residual client data
or older software. Do not confuse removing a local connection with revoking its
Host authorization. No real device was revoked during this change.

CLI impact: no Host protocol, Host database, CLI credentials or server-side
pairing rules change. App installation-bound seed wrapping is native-client
policy. Headless owner management remains available through the same APIs:
`tarobot devices list` and `tarobot devices revoke ID --yes`. No new CLI endpoint
or package publication is needed for this source change.

## Validation and release gates

Evidence: `/Volumes/gdrive/taro-tmp/client-installation-20261028` (synthetic data;
no operator Keychain/Keystore, production pairing or private message content).

Passed:

- Native identity audit: Android JVM **76 checks**, iOS CryptoKit core on macOS
  **91 checks**, 3 Node cross-verifications, Swift Capacitor plugin typecheck.
  New cases cover restart, changed installation, old raw keys, legacy migration
  refusal, action signing, substituted key references, envelope version changes,
  forgetting retired keys, fresh enrollment, backup exclusion and corrupt marker.
- Rust desktop installation **2 tests**, local-controller proof **2 tests**,
  Windows reset core on macOS **11 tests**. Ciphertext/nonces/tags tampering,
  retained-vault/new-data mismatch, rollback preservation and backup retirement
  are exercised without OS-vault access.
- Shared pairing/local-controller regressions: **48 tests**.
- Browser native IPC fixtures: Chromium **3 tests**, WebKit **2 tests**. String
  and Error rejections stop auth and outbox, preserve drafts, give re-pair
  guidance, do not mark Host revocation, and stay stopped on foreground/restart.
  The third Chromium case retains the existing slow-Keychain behavior.
- Android Gradle resource processing and `DeviceIdentityTest` pass (one JUnit
  wrapper containing 60 native-core checks; the separate audit adds 16 production
  nonce checks). Capacitor sync and Java/Kotlin compilation completed.
- Client translations/TypeScript/Vite build and standalone Host graph build pass.
  Existing nonfatal Capacitor keyboard import and Rust dead-code warnings remain.

Initial test/build issues were resolved: the first Rust command lacked staged
Host resources (test-only config now disables resource packaging); Android
required Capacitor sync before Gradle; a signature test incorrectly compared
signature bytes and now verifies both signatures against the same public key.
These were test harness issues, not installation receipts.

Still required before claiming installed end-to-end acceptance: iOS and Android
physical uninstall/reinstall and restore/transfer, macOS complete-data removal
in an isolated OS account, Windows installer uninstall/reinstall and upgrade,
real local-controller legacy upgrade, and preserved authorization across an
actual subsequent App update. No production App was replaced, no release was
published, and no existing devices were disconnected in this task.
