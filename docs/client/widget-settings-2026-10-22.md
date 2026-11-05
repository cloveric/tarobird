# Visual reply settings and prompt cost — 2026-10-22

The host exposes **Settings → General → Visual replies → Generate interactive
visuals** on desktop and mobile. It defaults to on, preserving
existing behavior. This setting belongs to the selected host and applies to its
Bots, including headless operation. It is not a device-only rendering preference.

The settings UI shows the host scope, switch and one short state-dependent
description. Prompt/history mechanics remain documented here rather than in
the normal settings flow. This copy/layout simplification does not change the
Host policy, permission checks, read-back verification or headless CLI behavior.

When off:

- New turns omit proactive widget guidance and the full authoring recipe. A short
  14-token disabled notice counters instructions left in resumed history.
- New native sessions use the existing frozen three-tool v3 contract, with no
  `app_show_widget` or `widgets` capability topic. An existing Codex v4 session
  retains its exact registered schema and history; its calls are denied at runtime.
- Native, compatibility-fence and direct CLI publications are checked on the host.
  The Hub checks immediately before a new message write, inside the database queue
  shared with settings commits. This also covers older workers and calls already
  in flight. Replaying an already published message still returns its old receipt.
  Compatibility directives fall back to their text conclusion; native calls
  receive an explicit, durable `published:false` error on authoritative denial.
  Unchanged historical reports can still receive version/status updates.
- Existing reports remain viewable and can be forwarded. Ordinary images, Markdown, attachments and
  other App tools are unchanged. A reply already running can still spend tokens
  generating a report that the host refuses to publish.

Enabling again never resets a conversation. Codex sessions created while off keep
v3 and use the existing compatibility publication route; a new session gets v4.
Claude tool-set changes use the adapter's existing worker reconfiguration rules;
background work may defer reconfiguration, temporarily using compatibility
file delivery. A tool-set change can restart the Claude session worker lazily
with resume and rebuild its cached prefix; it does not restart the host/Bot
service or erase conversation history. DeepSeek uses its existing per-turn
installation. Kimi/Antigravity continue through shared compatibility delivery.
The host gate is authoritative even if an engine retains old instructions/tools.

Neither disabling nor enabling erases earlier tool arguments, recipes or HTML
from model history. Starting a new conversation avoids carrying those entries
forward. This is not a CPU kill switch for reports already displayed; the existing
viewport lifecycle and [execution limits](inline-widgets-performance-2026-10-22.md#remaining-execution-limits)
still apply.

## Prompt measurements

Measured from the frozen pre-switch commit `8d52505` and the implementation, with
`gpt-tokenizer` / `o200k_base`. These are text/tokenizer estimates, not provider
billing, cache-hit measurements, or model-latency benchmarks.

| Component | Extra tokens |
| --- | ---: |
| Native standing widget line | 31 |
| Compatibility / old native standing line | 60 |
| Claude standing widget line after MCP name expansion | 47 |
| Native schema set v4 minus v3 (serialized JSON) | 205 |
| Full recipe when loaded | 1,033 (5,216 characters) |
| Short disabled notice in subsequent turns | 14 |
| HTML in the earlier real Codex acceptance report | 2,024 (6,218 UTF-8 bytes) |

Claude refreshes its short App contract in private turn instructions as well as
its worker system prompt. Cached prefixes, accumulated conversation history and
provider serialization affect actual token accounting. Native sessions do not
receive the full recipe automatically; compatibility engines select it for
visual-related requests, so keyword matching is not a perfect intent detector.
Generated HTML and repeated reports can cost substantially more than the brief
standing instruction. No claim is made that every response has the same overhead.

This change adds no renderer polling, model request, or extra library. A bounded
policy read happens at turn/call/publication boundaries. In a 2,000-read local
warm-disk sample, the median was 0.004 ms with no settings file, about 0.011–0.013 ms
with a saved on/off policy, and 0.018 ms with 32 receipts. P95 was at most 0.029 ms;
individual samples reached 3.3 ms. These are local file-read samples, not network
filesystem, battery or end-to-end response guarantees. Rendering measurements
remain those in the earlier efficiency audit; the renderer did not change here.

## Shared contract and persistence

`GET/PUT /api/settings/widgets` is owner-authenticated, advertised as
`widgets.settings.v1`. PUT requires `{requestId, revision, enabled}`; it uses a
bounded request-receipt log and revision checking. Saving uses an atomic rename
of `widget-settings.json`, serialized with Hub publication admission and an audit
record. A malformed/unreadable policy disables publication and reports a settings
error instead of silently re-enabling it. Malformed JSON in an owned private
regular file can be restored to off through the UI or CLI, using a revision
fingerprint of the damaged bytes. A concurrent edit invalidates that recovery.
Enabling is a separate subsequent action. Unknown/newer formats, unsafe file
permissions, symlinks and oversized files remain unavailable for operator repair;
the UI never overwrites them. The file is `<host dir>/widget-settings.json`. Missing policy preserves default on.

The settings page verifies a successful PUT with a GET and receipt. A conflict or
lost response disables the switch until an explicit read-back; it does not
silently retry the mutation. Older workers are listed when they do not advertise
`widgets.policy.v1`, because blocking publication does not prove their prompts
have changed. No active Bot or installed App is restarted by saving.

CLI, against an already running matching host:

```sh
tarobot widgets status --json
tarobot widgets set --enabled off --revision REV --request-id UNIQUE_ID --json
tarobot widgets status --request-id UNIQUE_ID --json
```

Use `on` to re-enable. Preserve the same request ID and parameters when reconciling
an uncertain request; a new ID is a new command. `widgets publish` uses the same
host gate and returns `widgets_disabled` when disabled.

## Acceptance

Evidence directory: `/Volumes/gdrive/taro-tmp/widget-settings-20261022`.

- Independent review: CC1, `claude-opus-5-5[1m]`, effort `xhigh`; frozen-source
  prompt measurements in `opus/evidence/prompt-cost.json`. Final review in
  `opus-final.md` found no merge blockers; 133 independent focused tests passed
  against a frozen implementation copy.
- 395 focused host/tools/engine/store/CLI regression tests passed; the recovery
  follow-up passed its 77 related tests again. Coverage includes persistent v3/v4
  contracts, runtime denial, old-worker admission, receipts, auth revocation,
  corrupt policy, stale requests, and ordinary-message/history preservation.
- Chromium: 18 existing widget scenarios plus four settings scenarios passed.
  WebKit: all four settings scenarios passed. Settings cover desktop 1360px,
  phone layout 390px, light Chinese/dark English, keyboard access, reload,
  cross-device revision conflict, lost-write-response recovery, damaged-policy
  recovery and the member role.
- Standalone host and client translation/type/Vite builds passed. Built CLI
  read-back is recorded separately from testing the command function.
- Real Codex (`gpt-6.1-sol`, low) passed the complete browser journey: proactively
  published one native report while on, then answered both the persisted v4
  conversation and a new v3 conversation with text/tables while off. Both off
  replies had zero new widgets and the expected total of 9. The original report
  remained visible; the two persisted tool-contract digests were distinct.
  Evidence: `live-complete/**/live-widget-off.json` and `live-widget.json`.
- This is source and isolated browser/host acceptance. No installed App update,
  physical phone run, Windows native run, or production setting change is implied.
