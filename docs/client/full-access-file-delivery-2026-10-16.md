# Full-access artifact paths

The owner requested that the highest Bot permission default to
`TAROBOT_ALLOW_ANY_FILE_PATH=1`, including sending artifacts directly from an
external drive. Previously App preflight unconditionally disabled arbitrary
paths, and both native send tools imposed a second unconditional restriction.
Changing an env value alone therefore could not enable this behavior.

`core/file-send-policy.ts` now reads validated Bot permissions before each send.
Effective Full access defaults to allowing readable absolute paths, while
ordinary/sandbox modes stay scoped even with an env opt-in. Explicit zero still
narrows Full access. Process settings outrank `bot.env`, which outranks legacy
`lark.env`; canonical spelling wins within each source. Missing/corrupt/unreadable
permission config fails closed. Legacy Claude full-auto and Kimi's explicit Auto
acknowledgment use the existing permission resolver.

Native single/batch tools, markers and send directives share this policy. Native
v1/v2 tool schemas keep their exact digests for resumed threads; new v3 schemas
describe the permission-aware paths. Capability guidance and App failure text
use neutral names. No thread history, routing ID or optional transport state is
rewritten. This does not erase historical Lark wording from resumed model history.

## Boundary review

This intentionally widens the path boundary only for Full access, as requested.
OS readability, credential rejection, realpath checks, size limits, conversation
authorization, cancellation and receipt deduplication remain in force. Credential
matching now also covers named env files (`bot.env`, `integrations.env`, etc.)
and symlinks to them. Relative paths cannot use the external-path allowance.
Explicit env changes already loaded into a worker require its idle restart;
permission changes are read afresh. Replayed receipts do not send again.

The headless CLI host uses the same core, so no separate CLI command is needed.
The next host-affecting release must package the standalone CLI and App host
from the same revision. This commit does not publish either artifact.

## Validation

- Baseline: 9 of 34 focused checks failed, reproducing Full-access path rejection
  and named-env credential classification before the implementation.
- Nine host/permission/native-contract suites: 280 passed. Repair fixtures now
  explicitly choose normal permissions when exercising rejected external paths.
- Final absolute-path boundary and Telegram shared-credential regressions:
  three suites, 66 passed (overlaps the host run; not additive coverage).
- A real isolated Hub/Gateway round trip covered native file, native batch,
  marker and directive delivery from outside the Bot workspace, downloaded the
  stored attachments and compared exact bytes. The model was synthetic; this
  is not production App/device delivery acceptance.
- Root build passed: standalone graph 344 modules, no legacy transport or
  Feishu SDK dependency. Test/build evidence is under
  `/Volumes/gdrive/taro-tmp/tarobot-file-policy-20261016/`.

## Owner's current installation

Read-only inspection found installed Mac App 1.0.71 and the exact screenshot's
old `lark.env` failure template in its bundled host. CC1 and GG1 were already
configured as Bypass, with no Bot env file. At the owner's request, each now has
a private 0600 `bot.env` containing `TAROBOT_ALLOW_ANY_FILE_PATH=1`.
These persisted settings do not remove the old binary's hard-coded restriction.
No active worker was interrupted, and this change has not yet been installed.
