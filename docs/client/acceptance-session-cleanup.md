# Native acceptance session cleanup

## Cause and correction, 2026-10-02

Real-engine acceptance isolated the Hub, Bot and workspace files, but used the
operator's existing native Codex configuration and session history. Deleting a
temporary workspace did not archive its native sessions. Repeated session/reset,
Bus, backup and question/permission runs accumulated visible historical threads.

The screenshot's session/persona/memory group contained 10 ended test sessions.
An inventory across both temporary-directory locations found **62** confirmed
acceptance sessions: 53 under the overridden test temp root and 9 under the
macOS default temp root. Their workspaces no longer existed and no corresponding
test worker was running. All 62 were archived through the Codex app's supported
API, retaining recoverable history. A subsequent database inventory and app list
showed zero remaining visible matches; the current task remained present.

## Future runs

`tests/helpers/codex-acceptance.ts` is called by the real Codex fixtures (including the mixed-engine Crew and native App tools)
after Hub/worker shutdown and before temporary-directory removal. It:

- Requires a known fixture prefix directly beneath the current OS temp root.
- Resolves only the fixture's root, project/workspace and managed Bot workspaces;
  rejects paths escaping that root through a symlink.
- Calls native `thread/list` with exact workspace filters, collects every page
  before mutation and independently checks each returned workspace.
- Refuses to archive an active owned thread; archives only matching sessions
  through `thread/archive`, then verifies an empty non-archived result.
- Fails visibly and preserves the temporary files when cleanup fails. It never
  deletes Codex history, edits live SQLite state or archives general user paths.

This is teardown cleanup, not a separate native home. Sessions can still appear
while a real test is running; a forcibly killed test runner can skip teardown.
Archive after the run preserves the resume/reset behavior being tested.

## Verification

- Six focused tests passed: ordinary-root refusal, symlink/sibling exclusion,
  complete pagination, active-worker refusal, loop detection, read-back failure
  and propagation of archive errors (some scenarios share a test).
- A real **Codex CLI 0.160.0** probe briefly restored one already archived test
  session, then used the new helper to archive it and verify no visible result.
  No new native session or model turn was created for this probe.
- Playwright successfully discovered all six updated real-engine fixtures.
  The model-driven scenarios were not rerun solely for this cleanup change.
- Mandatory gate passed: **3,427 tests, 1 skipped, 220 files**, followed by a
  successful root build. Logs: `/tmp/t/tarocub-session-cleanup-focused.log`,
  `/tmp/t/tarocub-session-cleanup-native.log`,
  `/tmp/t/tarocub-session-cleanup-browser-list.log`,
  `/tmp/t/tarocub-session-cleanup-complete.log`.

The later `live-crew` scenario also passed with its scoped archive/read-back teardown.
See the mixed-engine receipt（本地材料：`evidence/live-mixed-crew-2026-10-02.json`）.

On 2026-10-03, the narrowly allowed `live-app-tools-` fixture prefix was added,
with a seventh focused test proving that sibling workspaces remain excluded.
Both the initial run (test restart-wait assertion failure) and the complete
passing real-model run archived one owned session each and confirmed no visible
fixture sessions remained. See native App tools（本地材料：`evidence/native-app-tools-2026-10-03.json`）.
