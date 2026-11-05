# TaroBot IM interface upgrade — 2026-10-11

This change makes conversation content the default surface. Bot configuration,
effort, capabilities and session management remain available through the chat
identity, with their existing permission, persistence and engine rules intact.

## Reference and current-state audit

Reference: [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot).
Read its README and inspected `docs/images/team.zh.png`, `details.zh.png`, and
its client styles, themes, motion and details drawer. The useful methods were
quiet surfaces, consistent spacing, a clear content hierarchy and a separate
context directory. No reference branding, assets or source code were copied.
Its playful continuous avatar motion was not adopted.

The before images below were captured from the actual current TaroBot build at
1280 × 860 and 390 × 844, using an isolated local Hub with synthetic messages.
The audit found a nested desktop reading frame, configuration mixed into the
header, a blocking management form as the only details view, and a phone input
that used two rows even when empty. The existing mobile inbox, topic navigation,
attachment picker and message-action sheet were retained.

## Implemented behavior

- The title and avatar form a labelled details trigger. Desktop details use a
  nonmodal 320 px rail, so writing and reading can continue. At 761–1100 px the
  conversation list temporarily gives way to the rail; closing restores it.
  Phones have a full-page details view with an explicit Back to chat action.
- Details group model/configuration, Bot-scoped effort, files, Skills/MCP,
  operations, conversation management and connection. In a group the selected
  Bot is carried into the configuration and capability screens. Existing edit
  dialogs still guard unsaved changes and in-flight operations.
- Desktop chat uses one continuous reading plane, restrained flat user bubbles
  and a bounded message width. Selected conversation rows use one quiet tint
  and an accessible current-page state.
- Empty phone input starts on one line alongside voice/send. Multiline or long
  drafts expand to full width with a separate toolbar. Text grows up to six
  lines; short viewports preserve the Send target and scroll overflowing content.
  The group recipient picker is a sheet instead of an always-visible checkbox
  row. Collaboration remains in More; Plus still offers camera, photos and files.
- A `ResizeObserver` tracks input width and draft changes, not streaming tokens.
  No animation is applied to virtual message positioning. Details enter over
  the existing short motion token; reduced-motion disables that animation.
- Settings reuse the same typography and divider rhythm, removing decorative
  card borders/shadows while retaining all controls and scope explanations.
- Connection rate limiting now explains automatic retry rather than suggesting
  that pairing has been lost. No authentication or retry behavior was weakened.
- A cache preparation failure before the initial handshake is now reported
  instead of being silently treated as a failed connection. Regression tests
  cover the error and a late failure from a superseded connection.
- Removed the final `desktop-simplify.css` override layer. DesktopMenu owns its
  popup skin; base layout edits live in the existing brand/mobile files. The
  details directory owns its new component stylesheet.

Bot, group, topic, workspace, memory, session, authorization and synchronization
schemas were not changed. Quote, forward, attachments with captions, voice,
steering and stopping continue through their existing handlers.

## Before and after

All browser comparisons use the same synthetic workspace. Content/scroll
position changed during functional testing; these are layout comparisons.

### Desktop chat and conversation list

| Before | After |
| --- | --- |
| Desktop before (historical image omitted from this clean snapshot) | Desktop after (historical image omitted from this clean snapshot) |

### Details

| Before: blocking management form | After: contextual rail |
| --- | --- |
| Details before (historical image omitted from this clean snapshot) | Details after (historical image omitted from this clean snapshot) |

### Phone chat and input

| Before | After |
| --- | --- |
| Phone before (historical image omitted from this clean snapshot) | Phone after (historical image omitted from this clean snapshot) |

### Settings

| Before | After |
| --- | --- |
| Settings before (historical image omitted from this clean snapshot) | Settings after (historical image omitted from this clean snapshot) |

### Responsive and interaction details

| Phone details | Short phone, long draft and attachment | Attachment menu |
| --- | --- | --- |
| Phone details (historical image omitted from this clean snapshot) | Short viewport (historical image omitted from this clean snapshot) | Attachment menu (historical image omitted from this clean snapshot) |

## Verification and limits

Completed:

- Root pre-completion hook: **252 suites, 3,920 passed, one skipped**. This is
  the backend/protocol/unit suite, not the browser or mobile-device suite.
- Client translations, TypeScript and Vite build passed. Existing browser
  helpers/specs were updated for details and recipient disclosure. Added
  `conversation-details.spec.ts` for draft ownership, focus restoration,
  desktop/phone details, recipients and input growth. These browser regression
  files were syntax-checked; the automated browser suite was not executed here.
- Actual browser checks: desktop 1280 × 860, narrow desktop 820 × 820, phone
  390 × 844 and short phone 320 × 500. No page-level horizontal overflow in
  the measured narrow layouts. English/dark and Chinese/light were checked.
- Sent text, a long filename plus caption and code/list content, quoted an
  existing reply, and forwarded a reply to another conversation. Read-back
  showed the attachment, quote target and forwarding source. Bot working and
  stopped states were observed with the demo Gateway. The offline Bot in the
  group correctly produced a partial-stop warning.
- The local preview hit handshake rate limiting. Its audit log confirmed
  `rate_limited`; after restarting only this synthetic Hub, the queued message
  delivered and its response appeared. Production services were not restarted.
- Reduced-motion emulation reported the details animation as `none`, duration
  `0s`. Browser emulation was restored after testing.
- Native macOS debug bundle built and ran with an isolated preview identifier.
  Pairing, conversation/topic switching, empty topic, details and a full
  message/reply round trip were checked in the actual Tauri window. The app was
  sealed with a local ad-hoc signature; this is not a notarized release.

Native send/reply check earlier in this iteration:

Native Tauri preview (historical image omitted from this clean snapshot)

An initial native attempt used the same bundle identity as an older running
preview and showed an IndexedDB delete error after sending. A fresh independent
preview (`com.tarocub.impreview`) completed pairing and send/reply without that
error. However, reopening the final build preserved history and draft writes
but repeatedly failed to connect to the same synthetic Hub. The Hub's health
endpoint and browser connection remained available. No new successful native
authentication appeared in the Hub audit log. The cause remains unresolved;
native restart/reconnect is **not accepted**. The shared-preview collision is
only a suspected cause of the earlier storage error, not a proven product fix.
The older preview was not used as final native acceptance evidence.

Final native build with unresolved reconnect (historical image omitted from this clean snapshot)

Not verified in this iteration: physical Android/iPhone keyboard, camera,
microphone and long-press gestures; real-device relay/push; live model streaming
or multi-engine behavior; a long-session performance benchmark; signed release
install/update; and the full automated Chromium/WebKit suite. The existing
phone message-action sheet was exercised through its visible menu entry; the
in-app browser could not synthesize touch-hold input. Browser phone dimensions
are not a substitute for native mobile acceptance.

All reply content in this evidence comes from the deterministic demo Gateway,
not a model. No production workspace or Bot memory was changed.
