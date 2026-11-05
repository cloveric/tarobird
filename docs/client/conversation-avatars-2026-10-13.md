# Independent conversation avatars

Phone: open a chat, tap its avatar/name in the header, then choose **设置对话头像** directly in **对话详情**. The visible shortcut explains that it changes only this conversation; on older hosts it stays visible with an upgrade hint. Cancel or save returns to the shortcut and preserves the chat draft. Holding a conversation in Messages offers the same action. Desktop: switch to **按对话**, right-click a conversation, then choose the same action. **对话设置** also includes the avatar editor. Choose a system mascot or upload and crop an image. **恢复默认头像** resumes using the Bot's current avatar.

The picture belongs to the conversation, not to its Bot. Conversation lists, the chat title, details and forwarding destinations show it. Bot messages, Bot settings and the **按 Bot** tree keep the Bot's picture. Other conversations with the same Bot are unaffected. Existing group pictures and topic inheritance remain unchanged.

## Storage and compatibility

- Reuse the legacy `group:<conversationId>` avatar wire/storage namespace for root conversations. No database rebuild or new enum value is needed, and older clients can still parse `ready` and `avatar.updated` frames. `bot:<botId>` is never written by the conversation editor.
- A new `conversation-avatars.v1` capability enables direct-conversation editing. On an older host the action is disabled with an upgrade hint; normal chat stays available.
- Direct conversation pictures can be edited only by the conversation creator and read only by conversation members. Existing group permissions remain unchanged. Topics inherit their parent group's avatar.
- Existing authenticated PNG upload, metadata stripping, size limits, revision conflict checks and host/device-scoped offline cache apply. Two hosts with equal conversation IDs and equal revisions retain separate images.
- Editors load image tools lazily; a failed optional chunk leaves the active chat and draft usable. Cancellation does not write an image. Transparent pictures retain their alpha without a group-colored tile behind them.

## Verification scope

Regression coverage: `tests/hub-avatars.test.ts`, `client/e2e/conversation-avatars.spec.ts`, and existing avatar library, group-settings and forwarding tests. Exercises real disposable Hubs with Chromium and WebKit desktop/phone viewports, upload/crop, system choices, cross-device updates, restore, Bot/sibling isolation, equal IDs across hosts, reload/offline cache, older-host capability gating, and optional-chunk failures. Backend coverage includes restart, permissions and stale writes.

These are source/build and browser checks. They do not assert installation or physical-device acceptance of Android, macOS or Windows packages. The published 1.0.65 packages predate this feature.
