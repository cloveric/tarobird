# Antigravity effort compatibility — 2026-10-04

Update 2026-10-11: the CLI flag union is not a provider capability matrix.
Gemini Flash rejects xhigh despite the CLI accepting that level for other
models. App choices now use actual advertised variants; see
[the startup fix](antigravity-startup-2026-10-11.md). Historical adapter fixtures
below prove argument forwarding, not provider support.

The installed Antigravity CLI is 1.2.16. Its local `agy --help` advertises
`low|medium|high|xhigh|max`. The App's older four-level allowlist rejected xhigh,
and the native adapter independently dropped it before launching a process.

## Change

The shared config allowlist now includes xhigh. The adapter derives its type and
runtime set from that same constant. App settings, config loading, Telegram and
Lark accept xhigh; ultra remains invalid. Bilingual command errors list the actual
accepted levels. This does not change per-Bot scope, permissions, sessions,
workspace, memory, active-turn interruption, or the meaning of defaults.

## Evidence

- Before the source fix: the five focused files had 9 failing assertions and
  154 passes, reproducing rejected/dropped xhigh through each affected boundary.
- After the fix: the same five files passed all 163 tests.
- Adapter tests cover both persistent chat workers and single-process `/goal`
  startup flags with fake processes. They also cover effort-only reload of an
  idle worker while preserving the native conversation ID.
- Chromium and WebKit each passed the desktop/phone journey. The phone group
  picker shows the five native levels plus default, saves xhigh for Antigravity,
  and updates the desktop direct conversation for that Bot. Kimi and Codex retain
  their independent settings. Files and sessions are read back; the test asserts
  no messages were created and no engine was invoked.
- The first whole-repository run found one stale Lark test that still expected
  xhigh rejection. It now checks successful xhigh persistence followed by ultra
  rejection without changing that value; the focused Lark regression passed.

The screenshot below was inspected at 390×844 in WebKit. It shows the selected
Bot, shared scope, saved xhigh value, next-task timing and reachable buttons.

Phone Antigravity xhigh saved（本地材料：`screenshots/antigravity-effort-20261004/webkit-phone-xhigh.png`）

Raw local receipts: `/tmp/t/tarocub-agy-effort-20261004/`. The final required gate
passed 232 test files, 3,656 tests, one existing skip, and the root build. After
[Opus 5.5 xhigh review](antigravity-effort-opus55-2026-10-04.md) found no blocker,
its stronger parameter-adjacency and direct Antigravity rejection checks were
added and passed: 57 adapter tests and one journey on each browser.
Machine-readable evidence（本地材料：`evidence/antigravity-effort-2026-10-04.json`）.

## Limits

The CLI help confirms accepted parameter names, not every model's capabilities
or actual use of a particular reasoning budget. These tests invoke no paid Bot
model turns. Browser phone contexts are not physical-device acceptance. An older
Antigravity binary may not accept xhigh. No native App file-tool integration for
Antigravity/Kimi, production Hub restart, deployment, or new package is claimed.
The frontend is unchanged; r8 remains the current client development DMG, and
using this fix requires the updated host runtime.
