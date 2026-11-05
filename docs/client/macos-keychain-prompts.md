# macOS device-key authorization

TaroBot stores its device signing key in the macOS login keychain under
`com.tarocub.client.device`. The operating system may ask for the login keychain
password when TaroBot needs to sign a connection challenge or an authorized
device action. This is an OS authorization dialog, not a TaroBot account login.
TaroBot does not receive the password entered into that system dialog.

For the trusted installed app, **Always Allow** remembers access to this keychain
item. **Allow** grants the current request only. Separate device identities may
have separate items. A locked keychain can still require unlocking.

The current macOS development packages are ad-hoc signed. On 2026-10-14, the
installed bundle's designated requirement was a code hash, with no team identity.
Rebuilding changes that hash, so the new binary may fail the previous item's
trusted-application requirement and ask again. Keeping the same app name, bundle
ID or installation path does not make an ad-hoc signature stable across updates.

The durable distribution fix is to sign subsequent builds with a stable
Developer ID Application identity and consistent designated requirement, then
verify keychain access over an actual installed upgrade. The inspected build Mac
had zero valid code-signing identities. This source update does not claim to
resolve the upgrade prompt or provide a signed/notarized installer. Migrating
from an existing ad-hoc build may require one more user authorization.

Keep device keys in the OS keychain. Do not reset pairing, move keys to plaintext,
grant all applications access, or use an identifier-only requirement to hide the
prompt. The native keychain operations already run off the networking executor
and reject concurrent requests instead of queuing overlapping prompts.

When several paired hosts connect together, a concurrent request may return
`system_keychain_busy` without opening any OS dialog. Connection attempts retry
automatically with backoff and now display a secure-storage-busy message. Only a
signature that remains pending uses the keychain-authorization guidance. Manual
device actions are not replayed automatically after a signing failure.

The 2026-10-14 regression checks simulated three concurrent native sign requests
and verified that all three hosts reconnect after the first request finishes,
with separate Chinese and English busy messages. Chromium and WebKit passed;
these mocks did not access the real keychain or verify an installed upgrade.

References: [Apple: Allow apps to access your keychain](https://support.apple.com/guide/mac-help/allow-apps-to-access-your-keychain-kychn002/mac),
[Apple: Code-signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements),
[Apple: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/).
