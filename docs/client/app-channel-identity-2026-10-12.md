# TaroBot App channel identity — 2026-10-12

## Diagnosis

Read-only inspection of the reported DeepSeek conversation's durable prompt
confirmed that its IM question received `You are replying in TaroCub App`.
Six earlier prompts still contained the old `<lark_context>` routing wrapper;
the available skill catalog also included Lark integrations. Current App
messages no longer receive that wrapper, but the existing native session retains
its history. Those labels are not evidence of Feishu delivery. Private message
IDs, user content and credentials are not included in this report.

A native acceptance run exposed a second, independent conflict. The bridge
launches `dsh web` solely for its loopback RPC transport. Installed Harness
0.2.0-rc.2 enables `web-runtime.config.surfaceContext` by default, registering
the `app:web-surface` system section that says the user is interacting through
DeepSeek Harness Web GUI. It also exposes `DSH_WEB_URL` as a shell variable.
That system-level claim can override the correct per-turn App identity: an
initial compatibility-path answer named the Web GUI and qualified TaroBot as
an unverified claim. The acceptance assertion was strengthened to reject this,
rather than accepting an answer merely containing the word TaroBot.

## Changes

- The shared App contract identifies the current client as TaroBot App and the
  route as its host, not Feishu/Lark or Telegram. It explicitly distinguishes
  older history, routing IDs, compatibility tool names and available skills
  from the current chat channel. All five engines and all App instruction
  contexts use this contract, including native and fallback delivery.
- Resumed conversations receive the current contract every turn. Histories,
  durable session IDs, Bot personas and memories are preserved.
- The private DSH home now overrides the `web-runtime` row with
  `surfaceContext: false`. This suppresses the GUI system section and shell
  variable while preserving readiness URL output, loopback RPC and no-browser
  startup. The user's shared DSH configuration and independent GUI are untouched.
- DSH search guidance uses a neutral host-provided tool description. App help
  and status commands use TaroBot. The actual Feishu transport keeps its own
  instructions and behavior.

## Validation and limits

- Seven focused suites passed **210 tests**: App contracts/tools, startup,
  real Hub-to-engine request flow, workflows, command parity, DSH adapter and
  private host configuration. Coverage checks repeated prompts on an existing
  session, queued/quoted messages, native/fallback contracts, private-only
  patching and repeated host preparation.
- The separate legacy Lark instruction suite passed **12 tests**.
- `npm run build` passed; the standalone graph contains 293 modules and no
  legacy transport or Feishu SDK.
- Opt-in `live-deepseek-app-identity` passed against the real installed DSH
  in **9.0 seconds**. A synthetic old-channel history and random marker were
  saved in a temporary session. Separate restarted private hosts resumed that
  same session with native tools enabled and with compatibility fallback.
  Both returned `client: TaroBot App`, `viaFeishu: false`, `viaTelegram: false`,
  and recalled the marker. The recorded client identity rejects Web GUI,
  loopback URLs and qualified/unverified TaroBot claims.

Temporary hosts were closed and their fixture data removed. No production
Bot, App process, real session or shared DSH settings were changed. Source and
native-fixture validation do not update the installed desktop host; the fix
takes effect when that host is rebuilt and installed.
