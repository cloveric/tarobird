# Native mobile device identity — October 11

Based on `df7077c`, the review finding was confirmed: mobile creation and signing
read an Ed25519 seed into the WebView through the generic secure-storage plugin.
Desktop Rust already kept these operations native.

## Implemented boundary

`TaroCubDeviceIdentity` now owns creation, authentication signing, signed device
management actions and deletion on Android and iOS. JavaScript receives only a
public identity or signature. The plugin has no key import/export, arbitrary
storage read, caller-selected path or arbitrary-message signing method. Both
native implementations validate key references and reconstruct the fixed signing
domains; malformed or substituted device identifiers fail before key access.

Android wraps each seed using an AES-GCM key in AndroidKeyStore and stores its
ciphertext in an app-private preferences file with alias-bound associated data.
Bouncy Castle performs Ed25519 inside the native process. iOS uses CryptoKit and
an App-only Keychain service with `WhenUnlockedThisDeviceOnly`, without iCloud or
the share-extension group. This is native process isolation from WebView key
export, not a claim of hardware-backed Ed25519 signing or resistance to an
already compromised native process. [Android Keystore documentation](https://developer.android.com/privacy-and-security/keystore)
and [Apple's signing API](https://developer.apple.com/documentation/cryptokit/curve25519/signing/privatekey).

The old generic secure-storage plugin is removed from package dependencies and
both generated native dependency/registration manifests. Its only other use,
the application-lock preference, now has fixed boolean-only native methods.
Biometric unlock and privacy-screen behavior retain their existing controller.
This removes the generic plugin as an alternative key-export route.

A compromised App document could still invoke permitted signing methods while
it controls that document. This change does not provide a native confirmation
screen for every action, remediate browser MITM or make the optional UI lock a
cryptographic authorization boundary. Server validation, pairing, trust checks,
revocation and short-lived one-use challenges remain essential.

## Existing installation migration

On the first signing request, native code reads only the exact old device key
from the installed secure-storage format, validates its 32-byte seed, persists
it into the new store and reads it back before deleting the old entry. Retries
repeat the durable write even if a previous failed commit left a memory cache.
A conflict, unavailable store or failed deletion stops signing. Existing device
IDs and public keys are preserved; no automatic replacement identity or silent
re-pairing occurs. Application-lock migration preserves its boolean setting.

Deletion removes the legacy entry before the new one and checks both results,
preventing an old copy from restoring a deliberately forgotten identity. Work is
serialized in the native plugin. Migration touches only the selected identity
or the fixed lock preference, never other applications' keys.

## Verification

- The adapter regression initially failed three cases on the old implementation.
  Its seven final cases dispatch mobile operations to the native plugin and
  prohibit the old storage import; desktop and browser paths remain covered.
- The production Android core passed **48 checks on a JVM** using Bouncy Castle.
  The same checker is wired into Android's `testDebugUnitTest` task.
- The production iOS core passed **48 checks with real CryptoKit on macOS**.
  Keychain and plugin code type-check with the installed Apple frameworks and
  Capacitor Objective-C headers plus the existing convenience-method overlay.
- Native checks use synthetic storage to exercise legacy migration, restart,
  write/readback/delete failures, failed-commit retries, conflicting copies,
  malformed actions, key substitution, deletion, new identities and lock state.
  They do not read or modify the operator's Keychain/Keystore.
- iOS authentication and action signatures passed independent Node verification;
  modified proof text was rejected. Apple signatures need not be byte-identical
  to the deterministic Node fixture; the first equality assertion failed and
  was replaced with protocol-message/public-key verification. This behavior is
  described in the [IETF Ed25519 interoperability presentation](https://datatracker.ietf.org/meeting/121/materials/slides-121-cfrg-divergences-of-ed25519-in-web-crypto-and-beyond-00).
- The client production build and `cap sync` passed. Both native copies retain
  the content policy. This also fixes the content-policy hook's unexpected
  rejection of the Web target in an unqualified `cap sync`; the Web copy remains
  unchanged and has a dedicated regression check.
- The pre-completion root/relay build and full suite passed **250 files / 3,915
  tests**, with one explicit skip. Eleven focused adapter/content-policy tests
  also passed.

Reproduce native core checks on a Mac with Swift and the previously pinned JVM
jars using `node client/scripts/mobile-identity-audit.mjs <receipt-directory>`.
Set `TAROCUB_JAVA_HOME` / `TAROCUB_JVM_CACHE` for non-default tool locations, or
`TAROCUB_IDENTITY_PLATFORM=ios` for the iOS checks alone. The iOS workflow now
runs that path; no new dependency download or OS keychain access occurs.

Full Android/iOS SDK builds of this change, real OS-vault persistence and legacy
migration on phones, lock/unlock, reinstall and final package acceptance remain
open. The hosted-runner account restriction prevents a new SDK receipt. Earlier
APK or simulator receipts cannot be reused as proof for these new plugins.
No installed application, production Hub or public relay was replaced.
