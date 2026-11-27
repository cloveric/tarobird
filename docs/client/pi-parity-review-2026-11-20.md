# Pi parity review — 2026-11-20

Scope: ordinary Pi Bots, with independent engine/UI review and a separate
physical Windows validation. Pi remains excluded from Superagent and dispatched
worker roles. No dependency upgrade, release, installation or credential
migration is part of this change.

## Corrections

- Preserve model/provider identity in cross-provider search, display the default
  option, refresh unavailable catalogs and reconcile accepted settings without
  overwriting unrelated unsaved choices. Explain rejected default resets in
  Chinese and English and leave controls usable.
- Apply Bot model and thinking defaults independently, accounting for Pi's
  native model-switch thinking reset. Validate retained Bot effort before a
  model change; reapply it after a previously uncertain write has landed.
  Preserve supported conversation levels during Bot-only model changes; clearing
  an unrelated Bot model default does not impose effort on a conversation-owned
  model.
- Keep startup/runtime extension errors visible with bounded detail and count
  summaries. Extension-only notifications cannot become final delivery commands.
  Remove terminal styling from extension presentation; diagnostic text also uses
  the common credential scrubber, which cannot guarantee arbitrary-secret removal.
- Resolve session discovery and control calls against the actual Bot workspace.
  Compare physical identity while retaining logical Windows launch paths; find
  native terminal sessions through junctions and accepted shell-path forms.
- Retain Pi directory environment settings, enumerate supported skill layouts and
  managed search metadata, and distinguish authentication, no-model, startup and
  inactivity failures. Do not advertise a sandboxed full-auto mode Pi lacks.
- Stop the owned process tree before killing its launcher. Resolve bare Pi
  commands to an installed executable without executing workspace lookalikes.

## Verified evidence

- Host build and production application TypeScript check pass. The broader
  TypeScript project retains its pre-existing diagnostic baseline; it is not
  reported as a clean type check.
- The full source run passed 695 files, with three failing files and one skipped
  file. One failure was the expected config-card snapshot change adding Pi;
  its reviewed update passes. The two timing failures (Host update probe and
  discussion transcript reuse) pass in the isolated 48-test rerun. This is not
  a claim that the original full run was green.
- Final Pi/Host/CLI/Gateway focused regression: 22 files, 835 tests passed.
- Browser fixtures: 28 distinct cases passed across the affected Pi panels,
  creation, ordinary engine controls and Chinese/English phone/desktop widths.
  This is Chromium browser evidence, not a native phone acceptance result.
- Actual Pi 1.5.2 and 1.6.0 processes with isolated loopback providers cover
  native controls, restored sessions, default ownership, known rejection versus
  uncertain writes, extension notifications and terminal-styled output.
- Physical Windows 11 validation covers both versions, npm and official managed
  launcher layouts, junction/native-session recovery and missing-install
  workspace-shadow refusal. Six shutdown scenarios per version leave no owned
  root, Pi, helper or intermediate launcher process alive. Catalog queries in
  that run completed in 204–276 ms, under the four-second deadline.

The Windows broad focused run is **925 passed, 12 failed, 1 platform skip**
across 26 files. The same 12 failures were reproduced on the unchanged tests:
eight Host CLI tests could not initialize without the Windows launcher binary
in the source checkout; four bridge tests assumed filesystem sockets/symlink
privileges or listener-close timing. Native Windows process/bridge probes passed,
but these test failures remain recorded rather than counted as passes.

## Boundaries

No installed-App, real-provider sign-in/model response, physical phone, WebKit,
or store/package acceptance is claimed. Native terminal-only components,
interactive login and independent extension background runs keep the limitations
in [Pi engine](pi-engine.md). Trust decisions are not automatically migrated
between path aliases, so a fresh confirmation can be required.

For Bot-only model edits, preserving the prior supported thinking level is an
App policy; direct native `/model` retains Pi's policy. A conversation-only level
may be lost after an unconfirmed model write and process restart, since native
history then contains the changed level; no automatic operation replay is used
to pretend the old write was cancelled. Known Bot-owned defaults are recoverable.

The headless CLI uses the same Host adapter and authorization; no parallel
engine implementation or new command is introduced by these fixes.
