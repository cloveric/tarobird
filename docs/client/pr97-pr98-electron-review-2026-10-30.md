# PR97/98 review against the Electron migration — 2026-10-30

The owner requested review and merge of the two open PRs, plus a device-local
animated-avatar switch on phone and desktop. This work does not authorize a
release, installation, production restart or real artifact cleanup.

## PR97: temporary App retention

The original PR97 head `bad06c4` predates the Electron migration. Root and
Claude Opus 5.5 reviewed the changes against `d3c29e3`. Seven conflicts were
resolved while retaining the current Electron desktop build/dev/release paths,
packaging, signing and update transaction code. No desktop command was restored
to Tauri. The retained native/iOS acceptance scripts still use the shared
physical `.noindex` path helpers.

Confirmed corrections before merge:

- An `OWNER-HOLD.json` release had no activation receipt and would become
  cleanup-eligible after six hours. Owner-held candidates now stay protected,
  including when an explicit output root is below the task containing the hold.
- Electron packaging is driven by Node scripts. The active-build guard now
  recognizes those scripts, plus `ditto` and `hdiutil` stages.
- A verified backup moved or replaced between verification and retirement no
  longer justifies continuing to clear older candidates. Cleanup defers on
  identity loss. A separate fixture confirms that merely adding a newer backup
  does not delete the initially verified backup.
- The workspace helper supplies Electron output/cache/target variables; the
  publisher considers its explicit output root. The copied CLI-package fixture
  now includes the new path-helper dependency.

The cleanup uses `/usr/bin/trash`, excludes `/Applications`, keeps the newest
signed `macos-ready`, and retains six-hour, active-file and pending-activation
fences. All mutation tests used disposable fixtures and a fake Trash destination;
no real artifact was moved during this review. The installed release-artifact
skills were synchronized only after confirming their previous contents matched
the reviewed PR version.

PR97 was merged as `0bd2029451ba00ce49e74107ecf2158f6fae130b`, from reviewed
head `5fe6d45e819e47a5bb715f9fa4046d983e6716c0`.

## PR98: animated avatars and the setting

The original PR98 head is `ff53c5f`. Its shared React components and additive
IndexedDB reply projection apply to Electron, iOS and Android. No shell bridge,
Host protocol, delivery ordering or native update behavior changes here.

The setting is **Settings → General → Appearance → Animated avatars**, default
on. Its Chinese label is **动态头像**. It applies only to this device. Turning it
off stops body/eye/badge motion and removes the animated face overlay; static
completion, error and pending-request badges remain. Turning it back on does
not replay old completion/failure gestures. Ordinary UI/reply animation stays on.
Both preference stores and the startup appearance mirror preserve explicit off.

Root reproduced an image lifetime bug before editing: the 96-entry face cache
revoked an object URL while a mounted consumer still held it. Loading the full
144-image library invalidated the first retained face. The cache now retains
self-contained image data; evicted data stays valid while a consumer holds it.
The browser regression checks that retained image after eviction.

Opus independently reviewed the production diff, checked projection, migration,
cache lifetime and toggle behavior, ran the two focused unit suites and client
TypeScript, and found no blocking issue within that scope. The 13 reviewed
production files were hash-checked before commit.

## Verification

| Scope | Result |
| --- | --- |
| PR97 guarded cleanup fixtures | 25 passed |
| PR97 path/finalization helpers | 6 passed |
| PR97 release/signing/CLI-focused tests | 117 passed |
| PR97 Electron/build tests | 142 passed |
| Client unit regression | 45 files, 262 passed |
| Electron main/preload contracts | 132 passed |
| Chromium browser cases | 21 distinct cases passed across focused runs |
| WebKit browser cases | 8 distinct cases passed |
| Host standalone and client production builds | passed |
| Client translations/TypeScript | passed |

Browser checks cover live work/completion/failure/questions, avatar library and
custom-image behavior, offline reload, connection recovery, no replay, settings
persistence, 44 px controls and viewport fit at desktop 1360, iOS layout 390 and
Android layout 412. Screenshots were inspected. These are browser layouts, not
physical iPhone/Android or installed Electron acceptance.

Four `porcelain-details` failures from the original PR also reproduced on
unmodified main. Three sampled CSS transitions before they settled; the tests
had assumed OS reduced-motion would stop App animation, contrary to the current
always-on policy. Tests now wait for final paint while retaining their expected
values. The fourth constructed unsupported CLI/light appearance; CLI is dark
only. All four pass after test-only corrections. No production style was changed
to satisfy them. An initial phone test also needed to return from the Me tab to
Messages after closing settings; an overlapping browser run's report-directory
collision was rerun with unique output directories.

### First-upgrade cache measurement

A real IndexedDB fixture contained 20 conversations and 2,000 messages with
8 KiB bodies (16,384,000 text bytes). Initial reply metadata projection took
33.6 ms in Chromium and 65 ms in WebKit on this Mac. The second read took 0.2 ms
and less than 1 ms respectively. Original text, previews, unread counts and the
disabled-avatar preference were unchanged. This is one local sample per engine,
not a phone performance claim or a measurement of full App startup. It does not
justify a database-schema rewrite during this merge.

## Boundaries and dispositions

- A cached streaming reply can remain visually working until terminal state
  arrives. No arbitrary age cutoff was added: long real tasks must not be
  reported idle merely because of elapsed time. Complete offline/restart
  terminalization is not established by this review.
- Deleting the newest reply clears that avatar's completion badge rather than
  reviving older one-shot gestures. Existing unread counts are unchanged.
- The Android wrapper's line-ending-only checkout diff is excluded.
- Local checks do not replace Windows execution, physical-mobile testing, or
  the next signed-release/install acceptance. No new release was produced.
- GitHub jobs were blocked before running by account billing. Red status is not
  a passing or failing source-test result; local results above are independent.

Evidence is retained in the local `pr97-pr98-review-20261030` lab: independent
Opus findings/reviews, mutation fixtures, source hashes, per-run logs and browser
traces/screenshots. The CLI impact is limited to build-helper compatibility;
avatar presentation has no separate headless CLI command.
