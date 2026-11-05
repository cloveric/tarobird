# Dialog and settings copy audit — 2026-10-13

## 1. Findings

The reported deletion dialog gave the question, recovery route, cross-device
scope, retained data and running-task behavior nearly the same visual weight.
The reset/disconnect confirmations, Bot permissions, persona editor, notification
policy and route explanation had the same problem: multiple distinct facts in
one paragraph, often followed immediately by another muted paragraph.

The audit also checked group/topic removal, group membership help, host invitation
and device reset copy. Short contextual notes were left intact; operational errors
and security-specific warnings were not globally hidden or truncated.

## 2. Implemented changes

| Surface | Result |
| --- | --- |
| Delete conversation / dissolve group / delete topic | Named target, one-sentence effect, aligned recovery/retention/task facts; group and topic scope stays explicit. |
| Reset / disconnect / clear session choice | One-sentence result and short consequence rows; cancel receives initial focus. Unsaved-name confirmation no longer repeats its heading. |
| Bot permissions | Two labeled facts for when changes apply and where approvals happen. Engine-specific permission description and active-task warning stay visible. |
| Persona | One save-timing sentence. Shared memory and independent chat context are explained as separate facts in the existing disclosure. |
| Notifications | Four rows: when, muted when, notification content, device scope. |
| Connection routes | Short default summary; connection order and recovery behavior in an optional disclosure. |

`ExplanationList` provides semantic definition lists, aligned labels, wrapping
values and inherited theme typography. Confirmation dialogs use a 460px desktop
measure, phone-width sheets and controls at least 44px tall. Theme color/radius
variables preserve the existing light, dark, terminal and pixel styles. English
translations accompany every new string.

Deletion remains recoverable archival. No storage, synchronization, authorization,
queue, task, persona-save or notification-delivery behavior changed.

## 3. Validation

- Client build (translation checks, TypeScript, Vite) and root standalone build passed.
- Seven focused Chromium suites cover 32 distinct cases: conversation context
  actions (3), conversation settings (15), topic actions (3), permissions (1),
  persona/mobile polish (2), routes (1), notification settings (7).
- Old sentence-based expectations were updated to the new equivalent copy.
  The final removal/topic rerun verifies restore, preserved history/bindings,
  unaffected sibling topics, cross-device updates and pending-operation behavior.
- Rendered screenshots reviewed at desktop 1360x900 and phone 390x844 / 320px;
  IAB checks also cover CLI dark and Pixel light with English at 320x740.
- Checked label alignment, wrapping and horizontal overflow. Phone action buttons
  are 44px minimum; a wrapped English action grows in height rather than clipping.
- Final captures and logs are under the local audit artifact directory
  `/Volumes/gdrive/taro-tmp/dialog-polish-20261013/`. Accepted desktop/topic/persona/
  permissions screenshots come from connected, isolated Hub/Gateway fixtures.
  IAB captures verify notification/route disclosures and theme compatibility.
  Early blurred desktop IAB captures were rejected as typography evidence.

These are source, build and browser checks. Installed macOS/Android applications
were not rebuilt, replaced or tested on a physical phone in this change. No live
Bot configuration, conversation or production service was modified.

## 4. Review rule for future explanatory UI

- State the result first. Give the named target its own line when relevant.
- Keep recovery, affected devices, retained data and task effects visible at the
  decision point. Do not hide material consequences in a disclosure.
- Use short labeled facts for independent effects. Avoid adjacent muted paragraphs
  and repeated headings/questions.
- Put optional mechanisms and background guidance in a named disclosure.
- Review actual desktop and narrow-phone screenshots, including a long translation;
  check awkward one-word lines, label alignment, overflow, focus and touch targets.
