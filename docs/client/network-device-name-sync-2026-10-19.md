# Cross-host device names

## Problem and behavior

Names in this document and its new fixtures are synthetic examples.

example-windows could show another computer as “这台电脑” even after that computer was
named example-mac. The previous neutral-label repair only rendered “Mac 电脑”; it
did not synchronize the name. Original enrollment publication changed just one
binding, remote enrollment copied a client-cached name, and materialization never
updated an existing imported device row. A stale peer directory could also
restore an older name during authority reconciliation.

The signed network member identity now connects the original device's name to
its host-specific enrollments. A native desktop that has proved its local key
already shares its host profile name; a phone retains its own device name.
Only an exact original binding (`host == originHost == attestedBy`, matching
member ID derived from host and device ID) supplies the name. Platform, matching
labels and being the current viewing device are never identity evidence.

The authority keeps active binding names consistent, including admission review
lists. Receiving hosts also derive the name themselves, so an old authority with
stale attested names can work with an updated receiver. Reconciliation takes
mutable device descriptions from the newer signed directory, while preserving
the existing union of grants and irreversible revocation/conflict tombstones.

## Ownership and compatibility

- `private-network.ts` owns source selection and exact imported key/member/network
  validation. A revoked, blocked, inactive or missing source cannot rename rows;
  no naming operation restores authorization. Local native host-name bindings
  take priority over imported naming provenance.
- `network-device-name.ts` records automatic-name provenance in independent
  `network-device-name:v1:*` meta entries, scoped to the exact device key and
  network member. No wire version, database schema or strict private-network
  state shape changes. A malformed or mismatching marker does not authorize a
  rename.
- New imports follow the source. Existing imports with the recognized legacy
  relative defaults migrate on their next verified network reconciliation.
  An existing nonrelative name without provenance is preserved: it may be an
  intentional alias. Equality with an old cached binding alone cannot prove the
  absence of an explicit same-value or ABA edit.
  A pre-upgrade manual alias identical to a recognized relative default cannot
  be distinguished from that default and is migrated too; this is an explicit
  legacy-data limitation, not a claim that every old alias is recognized.
- Automatic names continue following only while the row matches the last applied
  automatic value. An explicit rename writes an alias marker atomically with the
  row update, including an API request that saves the same name. Permission checks
  precede both writes. Downgraded/external changes that differ from the last
  automatic value are preserved as aliases.
- Explicit aliases belong to the viewing host; they do not rename the source
  computer. There is currently no “resume following source” control. No automatic
  override of these aliases was added.
- A source that has never been named still has its original default; the client
  uses the existing neutral platform fallback. Independently manually paired
  identities with no attested member link are not guessed into one device.
- Device rename validation now matches the existing network name schema. Control
  and format characters, including ZWJ sequences unsupported by that schema, are
  rejected before saving instead of breaking subsequent publication. This does
  not silently rewrite invalid names that were saved by an older version.
  The existing pairing input schema still accepts such characters; repairing
  that separate entry point and already-invalid historical names is not part
  of this change. Such pairings can still block network publication.

`PreferencesPanel` reloads device records when the accepted network ID/revision
changes. It does not refresh for every streaming event, and independent name
editor drafts remain intact. The remote row is not given `nameSource: "host"`:
that flag belongs only to the viewing host's proven native desktop, otherwise
the client could incorrectly replace example-mac with example-windows.

## CLI and entry points

Desktop, mobile and headless CLI use the same Hub records and endpoints:

```sh
tarobot devices list --json
tarobot name "example-mac"
tarobot devices rename DEVICE_ID --name "Office Mac"
```

The last command creates a local alias for an independent accessing device.
The host-bound native desktop still uses `tarobot name`; its separate device
rename endpoint remains rejected. No new command or engine-specific behavior is
needed. Codex/Claude/Antigravity/Kimi/DeepSeek execution is unchanged.

## Verification and review

Codex reproduced three primary failures before the repair: initial remote name,
legacy-row migration, and stale-directory rollback. Opus independently reviewed
identity, naming provenance and the in-progress implementation. Two additional
findings were reproduced before repair: equal-name native/imported binding
priority and rename inputs incompatible with the signed-directory schema.

- Backend/network/host profile/native-controller/CLI: 129 focused tests passed.
- Device-label unit checks: 10 passed.
- Chromium: 13 passed in the final combined run (two desktop/mobile two-Hub
  workflows and eleven existing device/host-name settings regressions). The two
  new workflows are repeated after sanitizing fixture labels.
- Production host build, client build, translation and client type checks passed.
  The host build includes `tsconfig.app.json`; an additional broad `tsconfig.json`
  attempt includes legacy/test code and failed on existing cross-package Zod/test
  type errors. It is not reported as a successful check.
- WebKit was attempted: browser page creation failed, one check failed before
  executing and one did not run. No WebKit or native Windows/phone pass is claimed.

Opus offered a target-only simplification. We retained signed-directory naming
so admission/review lists improve too, with conservative legacy-alias handling
and explicit limitations above. The reviewer described this option as acceptable;
no proof of “never manually renamed” is inferred from string equality. Native
priority and schema findings were tested and fixed. Final review disposition is
recorded separately from Codex test results in the private task evidence.
The final Opus5.5/xhigh review confirmed no blocker in exact identity association,
alias preservation, atomic writes or recovery, and accepted this documented
tradeoff. The CLI model receipt independently verifies model and effort; the
reviewer did not claim to run Codex's tests.

Private evidence directory `taro-tmp/tarobot-network-device-names-20261019` contains
before snapshots, focused patches, RED/GREEN logs, screenshots, actual Opus model
configuration, requests and replies. Browser fixtures use isolated real Hubs,
signed memberships and databases; native enrollment markers are fixture stand-ins,
not physical Windows/macOS acceptance. No production pairings were edited.

The original Git permission denial is resolved; follow-up source delivery and
browser results are recorded below. Installed Apps still require a corresponding
host/client update. GitHub Actions billing remains outside this task.

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.
