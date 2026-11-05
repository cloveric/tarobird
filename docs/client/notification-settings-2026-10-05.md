# Notification settings follow-up — 2026-10-05

Development continued while the locked Mac prevented native UI acceptance. A lock-screen or an unavailable mobile SDK does not block source work, isolated Hub tests, browser verification, or design review. The overall product-plan acceptance gates remain open.

## Behavior fixed

- Notification drafts now participate in PreferencesPanel's close, Escape/native Back, dialog-close and host-management guards. Returning to categories preserves the draft and shows an accessible unsaved marker. “Continue editing” returns directly to Notifications when its draft is unsaved.
- Pending notification writes, including UnifiedPush provider changes, block exit and conflicting controls. Same-tick duplicate actions are fenced. A background refresh does not hold the whole settings dialog open.
- NotificationSettings observes the connection's accepted notification store, so live changes and its existing generation/request fence apply. A late old GET cannot replace an accepted newer snapshot.
- Online first-load failure now has a retry action. Offline cached settings remain readable and network mutations are disabled.
- A successful PUT is a receipt even if the follow-up GET fails. The accepted preferences update the shared connection store immediately, including desktop notification policy, rather than only a local UI overlay. The UI labels refresh failure separately and never asks the user to discard an already acknowledged write. Provider changes pass the exact preferences they successfully wrote through the same receipt path.
- The receipt updates the store after the write returns, invalidating reads started before that acknowledgment. A regression reproduced the previous failure: while the original PUT was held, another window saved 18:00; the original PUT then saved 23:00 and the following GET failed. Before the fix the UI displayed 18:00 despite the 23:00 database receipt; after the fix both match.

## UI changes

Following a source-and-screenshot review by actual `claude-opus-5-5` with `--effort xhigh`:

- State and the appropriate action share a single notification card; unavailable push no longer shows an unusable filled primary button.
- Technical setup details and notification policy are expandable. Device/host scope remains visible above the controls.
- Start/end times are aligned in separate rows. The saved/unsaved state and clear/revert/save actions occupy their own area.
- Empty or unchanged hours do not submit a no-op save. An active schedule can explicitly adopt the device's current timezone.
- Existing palettes, native time controls, focus states and reduced-motion settings are preserved; new labels are translated.

## Evidence

Actual Chrome UI against an isolated, paired Hub was inspected at 390px Chinese/light, 320px English/dark and 1280px desktop. The mobile exit guard was exercised through the visible controls; Continue editing returned to the preserved draft. The 320px DOM measurement showed no horizontal overflow. No production conversations or devices were changed.

- Before（本地材料：`evidence/notification-settings-20261005/notifications-before.jpg`）
- Phone after（本地材料：`evidence/notification-settings-20261005/notifications-final-phone.jpg`）
- English dark 320px（本地材料：`evidence/notification-settings-20261005/notifications-320-en-dark.jpg`）
- Desktop（本地材料：`evidence/notification-settings-20261005/notifications-desktop.jpg`）
- Discard guard（本地材料：`evidence/notification-settings-20261005/notifications-draft-guard.jpg`）
- Opus initial review（本地材料：`evidence/notification-settings-20261005/opus-focused.md`）
- Opus follow-up（本地材料：`evidence/notification-settings-20261005/opus-followup.md`）
- Opus third review（本地材料：`evidence/notification-settings-20261005/opus-final.md`）

The third review led to separating native distributor reread errors from successful writes and keeping retry feedback/focus visible until a new read settles. Its additional stale-read concern was checked against the connection request fence and a dedicated delayed-GET regression. Final shared-store receipt handling explicitly fences those reads as well, and a real HubConnection test verifies that desktop policy and preserved conversation mute data see the accepted write after stale/failed reads.

The initial review prompt incorrectly stated that PUT returned preferences. The actual Hub returns `{ok:true}`; this was corrected for subsequent reviews. The final implementation records confirmed preferences through `HubConnection.acceptNotificationPreferences`, fences older reads and notifies all store consumers. UI receipt metadata is used only to explain refresh failures. The server contract remains unchanged.

## Verification status

Final focused coverage: 31 Chromium checks and 31 WebKit checks passed (29 settings/provider cases plus two shared-policy/mute cases). The keyboard-focus retry case was separately rerun after correcting the test to activate with Enter: Safari pointer clicks do not focus buttons by default. Source hashes, run logs and resource verification are in the evidence directory（本地材料：`evidence/notification-settings-20261005/validation.json`）. Earlier regression failures were retained: the draft-discard test failed on both desktop and phone before the fix; the held-write race failed with expected 23:00 / received 18:00 before the receipt fix. A concurrent WebKit run had two initial pairing timeouts and an offline-simulation mismatch. Disconnect verification now stops the isolated Hub, because browser offline emulation does not consistently terminate existing WebSockets. A sequential WebKit run verifies the actual disconnected state.

The first full pre-complete run was stopped after timeouts while browser suites were also running and host load was high (39.6 load average on 10 CPUs). It is not counted as a pass. The final pre-complete hook passed with two workers, including all 237 root test files (3,802 tests passed, one skipped) and the build, after browser suites had finished. No test budgets were increased.

Android/iOS public resources were copied from the same client build and all 303 files matched by SHA-256. This is resource verification, not an installed mobile binary test. No application replacement, fleet restart, VPS change, signing, release or application-layer E2EE change was performed. Native device acceptance remains a separate pending gate.
