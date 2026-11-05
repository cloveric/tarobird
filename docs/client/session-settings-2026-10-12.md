# Conversation settings with understandable session actions

The phone previously presented five engine commands as a wrapped button strip.
It mixed a new independent chat, context maintenance, engine recovery discovery,
detaching and resetting without explaining their different effects.

The settings panel now shows full-width rows with icons, labels and descriptions.
New independent chat remains visible. Summarize context appears only for Claude,
Kimi and DeepSeek, matching the actual `/compact` handler. The other engines do
not advertise an unsupported action. Bot selection in groups remains explicit;
session commands still target that Bot in the current conversation.

Advanced session options are collapsed by default. They contain:

- Continue an existing session: explicitly load the Bot's session list, select
  one and apply it. The explanation states that the next message uses that
  context, and any chats sharing that session share context and serialize work.
  The picker appears only after a successful nonempty list; empty results are
  explained and offer engine recovery options.
- More recovery options: sends `/resume` to the selected engine, which can show
  native session discovery or engine-specific recovery guidance.
- Disconnect from the current session: sends `/detach` only after confirmation.
  It prefers a pre-resume session, but can detach the current native session and
  start fresh if no previous context exists. The UI states both possibilities.
- Start with fresh context: confirms `/reset`, explaining that earlier chat
  context is no longer carried over while visible messages and persona remain.

Existing uncertain-send IDs, mutation receipts, dirty name protection, archived
conversation restrictions and broken binding recovery remain intact. The name
field and Save action share a row. Styling uses existing palette tokens and works
at small phone widths, in Porcelain Teal and Monochrome, light and dark.

The engine session implementation has not changed. Browser tests exercise the
UI, Hub and Gateway routes; test doubles are not real model execution or physical
phone acceptance.

## Validation

- Core standalone build and gate: 221 files, 2,862 tests passed, one existing skip.
- Chromium and WebKit: 20 tests passed in each engine. Includes 320px layout,
  light/dark Monochrome screenshots, action descriptions and confirmations,
  engine-specific compaction, uncertain sends, binding receipts, device sync,
  broken recovery, and group target isolation.
- Android release build, unit checks and lint passed; signed APK assets match the
  built native public directory and retain the prior test signing certificate.
- Native container code was not changed. Physical phone acceptance remains
  separate from browser and installer verification.

Default phone layout (historical image omitted from this clean snapshot)
and advanced options (historical image omitted from this clean snapshot).
