# Review since 1.5.1

The review compares the published 1.5.1 source
`352a6c8ae25080580cbf758c721da76f662492b8` with
`c2704770b1d03ac28eab279a980e1e970163d0d6` (314 changed files).
The integrator reviewed the client, clipboard ownership, folder ordering,
notification and screen-control changes, native code, installers and candidate
publication scripts. Fable reviewed Pi, DeepSeek profile isolation and the
shared Host/Gateway/CLI entry points. Findings require a concrete reproduction
or an explicitly labelled fault-injection result; passing an existing suite is
not evidence that every edge case is covered.

## Corrections

- A rejected rich selected-text clipboard write could fall back after a newer
  App copy or native Copy/Cut and overwrite that newer content. The fallback
  now retains the original write's ownership. Same-owner plain-text fallback
  remains available. Three negative cases failed before the change; the
  regression and existing plain-message tests pass afterward. Stored messages,
  copied content formats and headless CLI output are unchanged.
- Pi imports with owner-chosen names, such as `backup.jsonl`, were listed but
  could not be found by the Host after its worker restarted. The fix gives new
  imports a session-id suffix and reads bounded headers for existing imports.
  Header identity and workspace checks remain authoritative; imports do not
  overwrite the source file. This shared adapter affects App and headless CLI.
- A model catalog that had already been read could be reported as unavailable
  when removal of its private temporary directory failed. Cleanup no longer
  replaces the catalog result and uses bounded background retries. The
  Windows-style directory-busy condition is fault-injected, not Windows
  physical-device evidence.

- A Pi process could exit while a descendant still held its output pipes. The
  Host then waited for the descendant and left requests pending with no live
  peer. Exit settlement now has a quiet grace and an absolute bound, while
  retaining trailing responses and UTF-8 decoding. This is reproduced with
  real synthetic processes, not attributed to Pi's built-in tools.
- Pi parsed commands from the composed model prompt, including quoted text.
  The typed owner message now crosses Core and Bridge separately: shell and
  extension arguments do not include a quoted reply, and Bot/delegated/cron
  input cannot directly invoke Pi's command language. Other engines ignore
  the additional field. Templates and skills retain model context.
- A Pi confirmation explanation was dropped by the shared card normalizer.
  Titles and explanations now share the visible question text. Browser checks
  cover English at 390 px and Chinese at 1360 px, with no automatic answer,
  no horizontal overflow and a negative answer that returns `confirmed: false`.
- Native Pi command replies can contain old delivery or schedule tags, for
  example when `/copy` returns an earlier response. Such replies are displayed
  literally using the Host's existing directive detector; they do not trigger
  those actions again. Model-produced delivery instructions and explicit
  exports to the request output directory keep their existing behavior.
- A DeepSeek private-profile refresh could lose a copied file when replacing
  it with a link failed, discard progress after another file failed to copy,
  or forget ownership of a nonempty conflicting directory. File replacements
  are staged, completed copy records survive partial failures, and an owned
  directory can be replaced after the owner removes its unowned contents.
  No shared profile write or recursive deletion of private files is added.
  Four negative cases fail before the patch; 75 related checks pass afterward.
- A saved Pi executable path or service override cannot be read by the strict
  1.5.1 Host. The managed-service/update preflight now requires `pi-state-v1`
  when those keys exist, and rejects an incompatible runtime before mutation.
  Seven negative cases fail before the patch; 179 service/update/settings
  checks passed at that stage. This is not protection for an old executable launched
  manually outside that update flow.
  Cross-review caught an overly early settings read in the first patch: a
  damaged settings file must not stop the current capable Host from starting
  for repair. The capability check now comes first; only an older target needs
  a readable settings file. Three additional negative regressions cover invalid
  JSON, a non-regular file and non-private permissions. The final 182
  service/update/settings tests passed, and Fable independently repeated its
  current-runtime probe successfully after this correction.

Further Pi command fixes preserve explicit confirmation for model-scope
selection, skip malformed custom-provider identities without losing the valid
catalog, avoid splitting Unicode names, and share tree-index/depth computation
across a history listing. Pi `/goal` returns a clear unsupported-mode explanation
without starting a failed run card. These do not add a Pi goal or Superagent mode.

The production-minified chart regression fixture also omitted the real App
entry and failed the required editor asset transform check. Its build now
includes that entry alongside the report fixture; the production guard remains
enabled. Pi browser suites are included in the opt-in WebKit configuration.
CLI typography and theme screenshot fixtures now set a synthetic Host name,
so local Host metadata cannot accidentally enter those captures.

## Verification boundaries

The initial full unit run passed 9,923 tests (18 skipped) across 701 passing
files (one skipped). This included the clipboard correction and preceded the
final Pi changes. A subsequent full run on the final source with eight workers
passed 9,984 tests, skipped 18 and hit one five-second timeout in the unchanged
group-recording reuse test. Four workers reproduced that same timeout. The
test passed in isolation (2.75 seconds total). Timed baseline/current probes
completed all six turns in about 2.4 seconds alone, 4.7–4.9 seconds with four
parallel copies, and 15.5–16.0 seconds with eight copies on both revisions.
All original assertions passed. This demonstrated an insufficient integration
test budget rather than a regression. The test now explicitly uses its existing
30-second wait budget at the outer level and additionally verifies that the run
and every turn completed successfully. No production timeout was changed.
The two full runs with a five-second timeout are not recorded as all passing.

The final full functional run passed **9,985 tests**, with 18 skipped, across
707 passing files and one skipped file. All source/test/package hashes matched
the validation snapshot afterward. A collaborator briefly ran additional CPU
and filesystem diagnostic load during this run; the passing functional
assertions are retained, but the run duration is not a performance benchmark.
The focused discussion rerun passed 40 tests across three files, including the
stronger completion assertions. Repository post-test checks passed 20 tests.
The final staged privacy scan and version consistency check passed.


Fable's final focused suite passed 1,001 tests with one skipped across 34 files.
It also exercised 36 single-line production mutations; every mutation was
caught after adding the missing header-identity regression. The affected
name-clipping mutations were repeated after the final Unicode change. Host and
client builds and production type checking passed. The clipboard regression
suite passed seven cases in Chromium and seven in WebKit, including actual paste readback.

Native checks ran on macOS: 43 desktop-native tests, 73 updater tests and
26 Windows notification-policy tests. The latter exercise portable policy,
not actual Windows notification delivery. Electron focused checks passed
49 tests, plus 11 installer tests after supplying the required isolated lab
root. These installer tests do not establish Windows uninstall acceptance.

The Pi WebKit attempt stalled waiting for a pairing code, before Pi controls
were reached, and was interrupted. Fable later read eight Playwright keychain
prompt events in the system log during that run. This is consistent with a
blocked pairing-crypto operation, but native desktop inspection was unavailable
and the exact mechanism was not confirmed in this run. No keychain entries or
permissions were changed; pairing WebKit was not retried. That journey remains incomplete; clipboard WebKit results do not
substitute for it.

The broader Chromium run passed 136 cases and exposed only the chart fixture
failure described above; the corrected minified fixture passed its focused
rerun. Seven CLI typography/theme cases passed again with synthetic Host
metadata. The two new Pi confirmation journeys passed in Chromium. Another 20 Pi
question/session/steering cases passed after the command and card changes.

Fable ran isolated native Pi 1.5.2 and 1.6.0 command probes with a synthetic
loopback model provider. They confirmed owner commands still work, templates
receive quoted context as model input, and Bot-origin command text and quoted
shell lines are not executed as native commands. This verifies the CLI and
adapter boundary, not paid-provider or installed-App acceptance.

The Pi command and adapter suites cover history navigation, fork selection,
cancellation, invalid entries, replacement-session routing and stale operations
after a fork. Current presentation uses chat selection cards; a fork replaces
the underlying Pi session for the same App conversation. This review does not
claim a complete installed-App fork/navigation journey or a visual tree view.

This review does not install or publish a build. Physical-phone acceptance,
Windows package acceptance, real remote-screen targets and paid-model network
execution are separate checks. No dependency or product-version change is
included. A candidate still needs its affected runtime checks and the owner's
trial before stable promotion.
