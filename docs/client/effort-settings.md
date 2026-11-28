# Chat effort settings

Effort remains a **Bot-wide setting**, matching TaroCub `/effort` and the instance
`config.json`. Every direct conversation, group and topic using that Bot shares
it. Other Bots retain their own settings. Creating a conversation starts separate
context but inherits the Bot's model/effort, workspace and durable memory rules.
There is no per-conversation effort override in this implementation.

Open Bot settings and select Model or Thinking effort. Both open Model settings.
The Thinking effort shortcut focuses the level selector after loading. In a group,
choose the Bot in Bot settings first. The desktop composer also offers quick
selection. Saving uses a settings request and takes effect at the next safe task boundary.

Each native adapter reads saved settings at its existing safe boundary. Active
Codex requests and Claude/Kimi background tasks can defer application. A save
receipt confirms persisted settings, not a mid-turn change in reasoning.

## Compatibility

Use the shared engine/model validator for the picker, Bot creation and config
loading. Levels retain native names rather than mapping every provider to one
common slider. Equal names do not imply equal compute or reasoning quality.

| Engine | Explicit non-default levels |
| --- | --- |
| Codex | low, medium, high, xhigh; max/ultra only for explicitly compatible models in the existing catalog |
| Claude Code | low, medium, high, xhigh, max; known older models/Haiku are filtered |
| Kimi ACP | low, high, max |
| DeepSeek Harness | low, high, max |
| Antigravity | low, medium, high, xhigh, max |

Claude compatibility was checked against [the official effort model matrix](https://platform.claude.com/docs/en/build-with-claude/effort)
and the installed `claude --help` on 2026-10-03. Installed Antigravity 1.2.16
`agy --help`, checked on 2026-10-04, advertises xhigh as well as max. The picker,
config validator and both adapter process paths share the accepted levels.
Unknown custom model
capabilities are not queried live by this picker; providers can still reject an
unsupported setting. The existing Codex catalog must be maintained as models change.

“Use defaults” deletes the override. It does **not** promise reasoning is off:
native/model defaults can still enable thinking. In particular, DeepSeek defaults
and Kimi's fallback are not a universal off switch.

## Transport and integrity

- The App uses the owner-only `GET/PUT /api/bots/:id/model` endpoint. With an
  Antigravity preset, changing the level saves the matching model ID and effort
  together. The effort-only endpoint remains available to existing clients.
- The schema limits settings writes to compatible model and effort values. An
  offline Bot or an unreadable configuration blocks saving.
- Saves share the native config file mutex, use atomic writes, retain unrelated
  settings, and read back the result. A revision includes engine/model/effort and
  a nonce, so stale clients cannot overwrite newer UI changes.
- Hub operations for a Bot are serialized to preserve metadata/broadcast order.
  Successful reads and saves update the Bot metadata for connected clients and
  future reconnects. A native `/effort` or external file edit is re-read when the
  picker is opened; this control does not watch arbitrary filesystem edits.
- Settings requests do not enter the offline message outbox. An ambiguous failure
  asks the user to reload and verify instead of automatically resending a write.

## Verification

`tests/effort-settings.test.ts` covers engine/model choices, file/session
preservation, compatibility changes, concurrent saves, defaults, and corruption.
Native adapter regressions cover configuration reload/defer behavior; Antigravity
tests verify xhigh/max reach the persistent-worker and single-process `/goal`
spawn argument boundary, using fake child processes. An effort-only change
restarts an idle worker on its next turn with the same native conversation ID.

`client/e2e/effort.spec.ts` pairs independent desktop and phone browser contexts to
a real Hub/Gateway. It checks same-Bot cross-conversation updates, stale-write
conflicts, group Bot selection, other-Bot isolation, defaults, owner authorization,
offline errors and absence of chat/engine calls. These UI fixtures do not invoke
paid model sessions. Evidence: `design/effort/2026-10-03/`.

The 2026-10-04 regression also checks Antigravity xhigh from the phone group
picker to another desktop conversation, plus Kimi/Codex isolation. See
[the compatibility follow-up](antigravity-effort-2026-10-04.md). This is not a
claim that a particular provider model executed with xhigh or that an older
Antigravity binary supports it.
