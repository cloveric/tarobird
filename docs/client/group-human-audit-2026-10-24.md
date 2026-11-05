# Group chat human-behavior audit — 2026-10-24

Status: source changes validated with independent Opus review; no release or installed-App claim.
Baseline: `2fa2cdca805a5ebfc516c5e381c8a03fd6aab455` (Agent Bus audit already integrated).

The owner requested the same hands-on audit used for Agent Bus, including unexpected input and alternate entry points. Root owns product edits, regression tests and integration. CC1 runs **Claude Opus 5.5 [1m], xhigh**, independently exercises the UI with real engines, records reproductions and reviews the diff. Findings are not accepted solely because a model proposed them.

## Isolation and evidence

The audit uses a fresh Host at `http://127.0.0.1:55674`, state `/Volumes/gdrive/taro-tmp/group24-live/hub`, separate root/Opus test Bots and synthetic tasks. Existing engine authentication is reused without changing configuration. Production conversations, the installed Host and its running tasks are not restarted or migrated.

Evidence directory: `/Volumes/gdrive/taro-tmp/group-human-audit-20261024`. `opus-coverage.md` distinguishes UI reproductions, database read-back, source observations and untested boundaries; `opus-findings.json` records independent findings and dispositions. Root reports, red/green tests, browser traces and screenshots live alongside them. Browser screenshots are not physical-device or native-shell acceptance.

## Confirmed corrections

| ID | Reproduced behavior | Correction and boundary |
| --- | --- | --- |
| R1 | The top **发起讨论** dialog loses its in-memory request ID on reload. If the HTTP receipt is lost and the run finishes, retrying the retained draft starts a second discussion. | Persist the exact start body, attachment IDs, original text and file-draft revision before POST. Retry explicitly with the same request even after a mode change. Clear only matching drafts after confirmation. Cross-window compare-and-swap prevents a second claim; corrupt receipts require deliberate recovery. Main-composer receipts and scheduler semantics remain intact. |
| R2 | Invisible-only topics/notes (`U+200B`, joiners and other default-ignorable characters) can launch model work. | Reject new visually empty automatic-discussion input at the shared Hub write boundary. Valid text retains its original joiners, emoji, paragraphs and indentation; attachment-only notes remain valid. Check existing receipts first so old confirmed requests can still be replayed. |
| R3 | `@Bot` inside an unfinished Markdown fence is treated as a recipient or unknown mention. | Scan fence boundaries, including unfinished and longer fences, before resolving mentions. Only recipient discovery is affected; the original message text is preserved. |
| F02 | Enter followed immediately by typing can retain the already-sent prefix in the next note/topic. Changing a quote during the same receipt window can also change the draft intent. | Keep the group draft read-only and its editing controls unavailable until the current send receipt settles, retaining input focus. The same-size send button shows a static hourglass and exposes `aria-busy`; no new animation or layout row is added. Restore the draft after failure. Direct-chat/native-engine input behavior is unchanged. |
| F03 | **重新发送消息** on a run-scoped supplemental note bypasses discussion routing and creates a recipient-less ordinary record. | Remove ordinary resend from these notes, just as for existing topic/scheduler inputs. Recognize the historical `gdnote_` message IDs too. Copy, quote, forward and history remain available; discussion retry uses its existing run controls. |
| F04 | The top start dialog ignores the composer's **可发言** selection and includes excluded Bots. | Both entries share the same selection and disambiguated Bot names. Preview and request use saved speaking order filtered by that selection. Fewer than two participants are explained; single-Bot messages stay in the composer. Older Hosts cannot silently broaden a selected subset. Pending receipts retain their original participants. |
| F05 | Scoped npm packages and Chinese-adjacent email addresses are mistaken for unknown mentions; code annotations cannot be sent without rewriting the text. | Full Bot aliases (including dots/slashes) take precedence over package/domain syntax. Literal prefixes that overlap any complete alias stay blocked; other explicit package/domain syntax is prose. Unknown `@` text remains blocked initially, with an explicit one-send **将未识别的 @ 作为正文发送** action. Known recipients, allowed-speaker checks, draft intent, attachments and receipts still apply. The choice does not authorize the next message. Duplicate Bot names are separately identified and cannot use the literal-send bypass; the user must choose a specific Bot. |
| R4 | The start dialog's attachment preview is clipped because only main/side composers override an obsolete absolute-position layout. | Apply the existing attachment tray styles to the discussion dialog as well; assert that the complete preview fits its list item on phone and desktop. |
| F06 | Phone discussion speaker selection occupies the input toolbar and squeezes an empty textarea to about 76–102 px in the reproduced layouts. | Put the phone selector above the input, in the same position as ordinary-group recipients. Reuse the same chooser and state; desktop placement and platform font sizes do not change. |
| F07 | A rejected offline group message offers retry/remove but no convenient way to reuse its original text. | Add **复制文字**, with success shown only after the clipboard confirms. Keep the original outbox record, attachments, quote and revision guard intact; no automatic resend under a different policy. |
| F08 | Forwarding with reply does not read the target discussion mode; multiple recipients or an active discussion fail later with raw internal codes. | Read and recheck the target mode, use a single-recipient radio group in automatic discussion modes, block reply during an active run while allowing save-only forwarding, and keep the Hub race guard. Scope readable failures to the outbox instead of a global banner. A failed preflight retains the source and dialog. |
| V15 | A rejected offline group-policy guard leaves a global error banner visible after switching conversations. | Keep request-bound `group_reply_mode_changed` feedback on its own failed outbox row, like the two forward/discussion rejection codes. The row and all retry/clipboard protections remain. |

The discussion summary button also gains an accessible name. A second review caught duplicate names in the newly reused dialog chooser; it now uses the same disambiguation map as the main composer. Opus also caught dot/slash prefix collisions and a duplicate-name literal-send bypass in the initial patch; both were corrected and covered before final acceptance. Pause-action radios and microphone entry points follow the same send-in-flight lock.

## Coverage and acceptance

- Real Codex, Claude, Kimi, DeepSeek and Gemini (via the Antigravity adapter) runs: sequential two rounds (10 completed turns), independent review two rounds (10 completed turns), and pause + two corrections + atomic resume with same-request replay. Verified the saved policy order, phase isolation and next-speaker timing against retained Hub records. `root-live-validated.json` explains two incorrect initial probe assumptions (creation order versus saved order; pre-pause completed speakers versus resumed speakers); no product change or repeated model run was used to conceal them.
- Real headless CLI against the isolated Host: 20 invalid-input/settings/control cases rejected with no discussion created. Includes empty/invisible-only/overlong/non-UTF8 input, stale revisions, bad participant lists and malformed settings.
- WelcomeHome **开一个群组** is directly exercised by `group-entrypoints.spec.ts` on a fresh Host (Chromium and WebKit). It is a separate button from the sidebar **新建群组**; the earlier creation test did not establish WelcomeHome coverage. Opus could not reach this empty state on his populated Host and correctly did not claim a manual pass.
- Opus UI coverage includes ordinary, parallel, sequential and independent modes; creation and settings entries; speaker selection; CJK/fullwidth/duplicate-name mentions; stop/correct/resend; pause/notes/continue; topics and navigation; member removal and Bot deletion during a run; lost receipts; mobile and desktop layouts. The final independent coverage file is the authoritative per-case ledger.
- Full unit regression: **480 files, 6,627 passed, 5 skipped** (`full-unit-controlled.log`, `vitest run --maxWorkers=2`). A preceding higher-concurrency run had three Kimi fixture prompt-start waits expire at two seconds and a cleanup rejection; that adapter and its tests are unchanged. The entire Kimi file passed separately (116), and the controlled full rerun passed without unhandled errors. The initial failed logs are retained rather than counted as passes.
- Complete browser suites: **138 Chromium + 138 WebKit passed** (`final-chromium.log`, `final-webkit.log`), including all group/discussion/offline/creation/forward/retry suites. WelcomeHome's separate entry test passed in both engines, bringing unique cases to **139 per browser**. Final V15 scope correction rechecked 14 cases in each engine. The same-size busy-button indicator was then built and checked in all three pending-send scenarios in both engines (`busy-*.log`).
- Host standalone build and client translation/type/build checks passed. The isolated Host was gracefully restarted from the candidate without changing identity; the 20-case CLI boundary pass includes the new invisible-only rejection.
- Opus independently recorded **76 initial cases and 19 recheck rows**, including findings and one explicitly untested manual WelcomeHome entry. Final verdict: no blocking issue on the validated candidate. Four-mode real-engine recheck scanned 114 final Bot replies with no visible stance-control fence/JSON leak. Detailed root/Opus probes remain in the evidence directory; each boundary is stated rather than labeling every conceivable input tested.

## Entry and behavior inventory

| Area | Exercised paths |
| --- | --- |
| Group creation | Desktop new menu, phone new menu, WelcomeHome, blank/long/emoji names, repeated create, one-Bot group, lost creation receipt |
| Settings and members | Clicked-group menu, header settings, phone sheet, rename, mode/order/round changes, remove members or delete a Bot during work, stale settings |
| Sending | Main composer and top start dialog, zero/one/multiple allowed speakers, selected subset, names/IDs, duplicate names, CJK/fullwidth `@`, code/email/package/annotation text |
| Discussion lifecycle | All four modes, two rounds, stop then correct, pause/add/resume, retry failed speaker, skip, end, rapid repeated controls, cross-group concurrency |
| Context and media | Root versus topic, cross-topic guards, quotes, attachments, forward save-only versus reply, immutable run membership and speaking order |
| Recovery | Offline/cold start, stale reply guards, lost HTTP receipt, reload after completion, old Host capabilities, two windows and draft compare-and-swap, clipboard denial |
| Presentation | Phone widths 320/390, desktop 1360/1440, light/dark, ADHD, participants, progress details, attachment geometry, hidden ordinary resend on discussion notes |
| Headless | Real `groups show/update/start/pause/note` (including atomic resume and exact replay), status/read-back, invalid controls and payloads; creation-command gap listed below |

## CLI and compatibility

The shared Hub validation also protects `groups start` and `groups note`; the existing CLI still uses the same authenticated APIs. Status, settings, controls, attachments and exact request IDs retain their formats. UI-only work adds no CLI flag, protocol capability, database migration or engine-specific behavior.

The new local operation record is stored in the existing per-Host client cache under `operation:group-discussion-start:<conversationId>`:

```json
{
  "version": 1,
  "body": {
    "requestId": "gdc_…",
    "revision": "r…",
    "text": "Original topic",
    "attachments": ["att_…"],
    "participants": ["bot_a", "bot_b"]
  },
  "draftText": "Original topic",
  "fileRevision": "…"
}
```

`participants` is sent only when the existing recovery capability is advertised. `fileRevision` is optional. No automatic retry or new run is triggered by opening the dialog, reconnecting or resetting a corrupt local record. Existing confirmed invisible-input receipts are checked before new-input validation; old schemas and history readers are kept permissive.

## Observations and remaining boundaries

- F01: Kimi's public reasoning can discuss the internal stance protocol. The final reply and canonical control fences are filtered correctly. We preserve public reasoning instead of deleting arbitrary explanatory text by keyword. This is documented as a presentation boundary, not an execution or provenance leak.
- While a group send awaits its receipt, the current draft is temporarily read-only. New keystrokes in that interval are not buffered; focus is retained and the button shows a static waiting icon. This prevents prefix merging and changed-intent replay, but is not claimed to support uninterrupted type-ahead.
- A note sent after a discussion has already ended may be a new topic if drafting begins after completion; a draft started during the old run remains bound and requires an explicit rebind. The two cases must not be conflated.
- Paused **补充并继续** resumes immediately. To deliver several corrections before anyone resumes, write them as one note; no new batch-notes UI is introduced here.
- A rejected offline request keeps its exact old revision: **重试** does not adopt changed settings. Use **复制文字** to compose a new request after reviewing the new mode. Automatic restoration of rich outbox content to a draft is not added.
- Resending a historical ordinary, recipient-less record retains that record-only intent; it does not silently become an automatic discussion. Start a new discussion explicitly through the composer. Forwarding still starts with the existing first-member selection in ordinary/parallel groups; automatic groups now allow only one selected recipient.
- Existing headless CLI has no group/topic creation command. Existing group settings/discussion/control commands were exercised; adding new creation commands is a separate capability gap, not claimed complete by this audit.
- No real iPhone/Android hardware, remote Tailscale route, native Windows, real IME/keyboard, manual non-owner account controls, or new release/local installation is claimed by browser and isolated-Host evidence.
