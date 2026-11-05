# LAN pairing recovery — 0.1.375-test.3

## Failure and fix

The shared client generated a padded base64 challenge nonce. Android and iOS
native signers accept unpadded base64url. Approval succeeded on the Hub, but the
native signer then rejected every generated client nonce with
`invalid_device_challenge`. Desktop and browser signing did not expose the same
validation mismatch. The fix preserves all 256 random bits and uses base64url.
Existing approved devices can reconnect after an in-place client update; neither
device keys nor Hub data need to be reset.

The native identity audit now imports the actual production `randomNonce`
generator and sends its output to both native cores. It failed before this fix
and passes afterward. Literal, native-only nonce fixtures were insufficient.

## Interaction changes

- Mobile starts with scanning; address/key/deployment fields are advanced options.
- Approval progress and expiry are stored with the same device identity. Reloading
  while waiting keeps the code. Expiry renewal reuses the existing device key.
- Successful authenticated readiness enters chats automatically. A button press
  or an approval response alone cannot claim a connected phone.
- An unfinished enrollment can be resumed, removed explicitly, or left while
  another paired host remains usable. Pairing errors are translated.
- Connection settings and the pending screen offer QR address repair. It checks
  the exact existing Hub public key, asks for confirmation, preserves device
  identity and fallback relays, and carries the QR-scoped CA. A different Hub is
  rejected. This does not re-pair or erase chats.
- A desktop host keeps its LAN port even when started without a LAN interface.
  A changed IP still needs an updated QR; this does not bypass guest Wi-Fi/client
  isolation or a firewall.
- Advanced pairing UI and desktop hosting UI are loaded on demand. Obsolete
  onboarding translations were removed. The original 700,000-byte fresh-browser
  startup gate remains unchanged (699,219 bytes observed).

Claude Opus 5.5, effort xhigh, completed a separate review and implemented the
scoped QR route-repair component; its findings about durable approval state,
address changes and retry/error handling were checked against the implementation.

## Native evidence

The API 36 Android emulator ran the packaged production web assets in a separately
identified test app (`com.tarocub.client.pairingtest`), with real Capacitor plugins,
Android Keystore signing and native TLS/WebSocket transport. Instrumentation:

1. Decoded a generated QR image through the actual scanner input.
2. Requested pairing, reloaded while waiting, and retained the same code/key.
3. Received explicit approval from the disposable test Hub.
4. Entered the IM inbox automatically and displayed seeded chat history.
5. Restarted that Hub and authenticated again with the same approved device.
6. Destroyed the Activity successfully.

The fixture recorded exactly one approved device and two accepted handshakes.
The initial native run exposed `NetworkOnMainThreadException` during Activity
teardown: pooled TLS shutdown can send `close_notify`. Network cleanup now runs
on the existing bounded cleanup worker and `close()` is idempotent. The complete
instrumented run passed again after this change and with the shipping web assets.

The Java/Swift core audit passes generated-client nonce checks (64 checks each),
Node cross-verification and the iOS plugin source typecheck. The Android native
transport audit also passes. These source/JVM checks are distinct from phone UI.

## Other validation and limits

Focused host, identity, startup and device-action tests pass. Browser regressions
cover approval/expiry/removal, wrong-Hub QR repair and persistence, multiple-host
isolation, attachments with captions, question cards, stop races, signed
handshake/revocation, device settings, TLS/relay deployment and native IPC failure
contracts. Browser test fixtures now wait for authenticated completion rather
than clicking the removed manual confirmation button.

The APK keeps `com.tarocub.client`, signing certificate and device storage; version
code 2026101103 permits an in-place update. The Mac package keeps its historical
identifier and bundles the standalone Hub/runtime. Session, memory, workspace,
permissions, message protocol and optional integrations are unchanged. No legacy
TaroCub/Feishu service or real user data was reset or restarted for this work.

Still unverified here: the user's physical phone and Wi-Fi, camera permission and
live camera scanning (instrumentation supplied an image), background/lock-screen
recovery and push, and an installed iOS build. This pairing fixture used seeded
history, not a live Gateway/model CLI. The current Mac native window was not
re-accepted in this pass; its shipping bundled runtime was checked separately.
Desktop remains Apple Silicon only, ad-hoc signed and not Apple-notarized.
