# Notification settings and delivery choices — 2026-10-27

The owner's WeChat, Claude and DingTalk references put reminder choices first and leave sound, vibration, banners and lock-screen presentation to the operating system. TaroBot's former page instead presented an enable/disable action, a static event list and an expanded quiet-hours form; only Android had a system-settings entry. This change was implemented and reviewed jointly with Opus 5.5.

## Result

- A real, labelled message-alert switch reflects accepted settings. A pending or failed save never appears successful. Existing offline, busy, refresh-failure and quiet-hours draft protections remain.
- Reply completion/background updates, received files/images/audio, and requests needing attention have independent switches. Mixed text and files are admitted if either relevant choice is enabled. Approval, error and incomplete-delivery events follow the attention choice, including when it is off.
- A separate preview choice hides conversation names, Bot names, excerpts and filenames in newly submitted notifications. The generic event text remains useful. Existing notifications already delivered to the OS are not recalled by this setting.
- Quiet hours are a collapsed row with a saved/unsaved summary. Expanding it retains explicit Save/Clear/Restore actions. Healthy reception diagnostics are compact; blocked or uncertain reception starts expanded and does not claim delivery. A user can manually expand or collapse either state without a later render undoing that choice.
- The system-settings entry is available even when message alerts are off. Android opens its notification settings, iOS uses Apple's notification-settings URL with an older-iOS App-settings fallback, Windows opens system notifications, and macOS opens System Settings with explicit Notifications → TaroBot instructions. Failure shows a manual path and does not change notification consent. A delayed native receipt shows neutral manual instructions; a later success clears them rather than leaving a false failure.
- Desktop instructions explain foreground suppression and that completely quitting the App stops local notifications. Desktop notices now identify the conversation and Bot and include a bounded final reply/file summary. macOS requests the default notification sound, subject to the user's OS settings.
- Android recognizes the existing `后台任务更新：` and `交付未确认：` preview prefixes instead of discarding those previews. No new push payload fields or unbounded model/process content are introduced.

## Shared rules and compatibility

`src/client-protocol/notification-content.ts` supplies the same terminal-message classification and bounded preview extraction for Hub pushes and desktop delivery. Streaming runs, queue bookkeeping and cancelled independent Bus records do not become successful reply notices. Thinking, tool output and collapsed process content remain excluded.

The optional `replyCompleted`, `filesReceived`, `needsAttention` and `showPreview` fields default to the prior on behavior. `/api/notifications` advertises `customization: true`; the client exposes the new switches only with that capability. An older Host receives only fields it supports.

New choices live in `device_notification_options`, separate from the strict legacy `device_preferences.preferences_json`. A legacy client updating the four original fields does not clear the new options. Outbox classification is an additive SQL column, not a new key in the strict v1 wire payload. Older queued rows use a conservative wire-kind fallback. This preserves schema readability on downgrade; an older Host cannot enforce options it does not implement, so preview/event customization requires the updated Host.

The push worker checks current topic and preview choices when draining queued rows. A queued private preview is redacted before provider submission if previews have since been hidden. Local desktop delivery checks again after cache reads, native capability discovery and the native operation queue, immediately before IPC. Disabling reminders, muting a conversation or disabling the applicable category suppresses a pending send. A notice initially prepared without details stays private even if previews are enabled while it waits. Already submitted provider/OS notifications cannot be retroactively changed.

The new choices belong to the authenticated receiving device and current Host. They are not global Host preferences. Headless CLI Hosts use the same API, storage and push worker for all engines; the CLI has no native notification surface needing another settings command. The desktop App must remain running to present its own local notifications.

## Verification

Focused results are recorded below after final integration. Browser native bridges are mocks and are not proof of delivery on a phone or Windows machine.

- Chromium notification design/readiness: 35 passed, plus 2 macOS follow-up checks (layout and system entry).
- Desktop queued-consent/preview checks: 9 passed.
- Shared classification, authenticated Hub options, Hub push admission/worker/preview/rotation and actual connection callback integration: 7 files / 108 passed, including the root integration checks.
- Chromium settings/transport/mobile entry integration: 36 passed; the one second-window startup timeout passed in an isolated rerun using the latest build (50.4 seconds).
- WebKit notification choices/layout: 12 passed, including iPhone 320/390 widths; 3 additional review checks passed for category-save feedback, delayed native settings receipts and manual diagnostics expansion.
- Native Rust notification tests: 19 passed, including actual Foundation content, default-sound attachment and Windows payload encoding. Android notification-body JVM tests: 7 passed, also rerun through the real Gradle Debug unit-test task after native plugin integration.
- iOS unsigned simulator compilation passed with the new settings plugin; placeholder web assets were used only for this compile and removed afterward. This is native compile evidence, not an install or device-delivery test.
- Combined desktop lifecycle/design/readiness regression: 78 of 83 passed initially. The five HostApp fixture failures were fixed by explicitly declaring a client-only native shell and using the fixture's actual Add host control; all five then passed. That follow-up ran 8 checks in total, also covering the three review cases. No lifecycle failure remains unresolved.
- Host standalone build and final integrated client build passed. Android Debug Java compilation and the two affected JVM suites passed through Gradle (10 tests total).

A concurrent broad test attempt was stopped after timeouts and is not reported as passing. The first affected pairing case passed in isolation (26.3 seconds); focused regression results, rather than that interrupted run, define acceptance.

The owner received phone and desktop-dark test-rendered previews in the App. No production notification preferences were changed, no real push was sent, and no new App was installed or released. Physical iPhone/Android provider delivery, OS settings navigation and audible sound remain device acceptance gates.

Primary platform references: [Apple notification-settings URL](https://developer.apple.com/documentation/uikit/uiapplication/opennotificationsettingsurlstring), [Microsoft Settings URI reference](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings).
