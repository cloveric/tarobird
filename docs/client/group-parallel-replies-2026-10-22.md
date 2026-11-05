# Parallel group replies

Choose **群组设置 → 群聊方式 → 并行回复** (Group settings → Parallel
replies). Save once, then send normal messages. Saving does not invoke a Bot.

- Without an explicit recipient, every current group Bot receives the user's
  message independently. Bots can start concurrently, subject to their own
  existing queues, engine availability and concurrency limits.
- An @ mention or the reply-recipient picker narrows delivery to those Bots.
  Clear the selection to return to everyone. The composer says **全员回复**
  when that default applies; recipient selections remain persistent drafts.
- Replies are addressed to the user. Bot publications do not trigger peers,
  start further rounds, or create a discussion run. Forwarded reference
  messages retain their existing explicit-recipient rule.
- Each Bot keeps its existing session for this group or topic. Peer replies
  are not automatically inserted into subsequent prompts. Changing modes does
  not erase context already present in a resumed session. Explicit user
  requests to discuss/delegate remain subject to normal permissions.
- Topics inherit their root group's policy. Parallel replies supports the
  normal group limit of 1–32 Bots; automatic discussions still require 2–8.
  End an active automatic discussion before selecting parallel replies.

The other modes retain their behavior: ordinary group chat records an
unmentioned message, roundtable speaks in order, and independent review uses
a blind first round followed by discussion. See [group discussion modes](group-discussion-2026-10-20.md).

## Host, client and worker contract

`groups.parallel.v1` advertises support. New Apps disable the choice on older
hosts. A client that does not advertise this capability cannot submit an
unmentioned message to a parallel group: the Hub returns
`group_parallel_client_update_required` without saving or delivering it.
Explicitly selected recipients continue to work. Older Apps may also be unable
to read the new policy value; update App and host together.

`HubStore.sendMessageInTransaction` resolves ordinary human recipients from
the saved policy inside the existing message transaction. Explicit recipients
win; delegated Bot inputs and scheduler inputs never default to a broadcast.
The actual recipients are frozen in the message's existing `mentions` field,
so a retry, a later mode edit, and existing @-only workers use the same set.
Bot output publication and forwarded-reference delivery do not use this path.
No new scheduler, peer-history collection, model call or polling loop is added.
The group strip supplies its already-read mode to the composer. A short
turn-scoped instruction tells ordinary group Bots to answer the user
independently; it is not added to direct chats or automatic discussion turns.

Schema **21** atomically expands the settings table's mode CHECK while retaining
existing policies, revisions, messages and runs. Runtime rollback protection
is updated to match. An older Hub must not open schema 21; a release must ship
the App host and standalone CLI from the same revision.

## Headless CLI

The CLI uses the same settings API and capability check:

```sh
tarobot groups show GROUP_ID
tarobot groups update GROUP_ID --from group-settings.json
```

Build the settings file from the latest `show` result; copy `group.title` and
`group.botIds` into both current and expected fields, retain `policy.botOrder`
and `policy.maxRounds`, set `policy.mode` to `parallel`, and use the returned
`revision` as `expectedRevision`:

```json
{
  "title": "Project group",
  "expectedTitle": "Project group",
  "botIds": ["bot_a", "bot_b"],
  "expectedBotIds": ["bot_a", "bot_b"],
  "policy": {"mode": "parallel", "botOrder": ["bot_a", "bot_b"], "maxRounds": 3},
  "expectedRevision": "COPY_CURRENT_REVISION"
}
```

`groups start` is for automatic discussion modes and rejects `parallel`.

## Verification and release boundary

- Hub tests cover recipient freezing, explicit @, topic inheritance, duplicate
  submission, old-client rejection, permissions, no peer/forward fanout,
  active-discussion exclusion, one-member groups, schema-20 migration and restart.
- Gateway integration uses a real Hub, three real Gateways and Core with
  scripted engine outputs. A gate proves all three reach the engine before any
  reply finishes; later @ narrows delivery and peer text is not injected.
- Authenticated CLI tests save and read the same policy across host restart.
- Browser journeys cover desktop/phone widths, settings persistence, concurrent
  dispatch, explicit selection, composer labeling and older-host capability
  gating. Browser engine evidence is separate from native/device acceptance.

October 22 local evidence: the seven focused suites passed 114 tests; WebKit
passed all 20 group discussion/settings journeys. The full unit run covered
419 files (5,792 passed, 23 failed, 5 skipped). It exposed the backup schema
allowlist omission and one remaining schema expectation. Both are fixed.
The remaining voice-stop assertion also failed on an isolated checkout of
baseline `72be62d`: delivery acknowledgement precedes queue cleanup. The test
now waits for the actual queue to empty, then verifies the next message works.
All five affected/related suites passed on rerun (142 tests), including the
authenticated WebSocket capability guard, backup/restore, voice, Agent Bus
and CLI management. App translation/type checks and both builds passed.
Chromium covered 66 group/settings/topic/mobile/ADHD journeys: 65 passed
initially. The remaining narrow-group fixture sent an unmentioned message in
ordinary mode and then expected a Bot question. Selecting its intended Bot
fixed that stale fixture; the complete journey passed on rerun. No layout
assertions were removed or relaxed.

This is a source change. It does not update the installed App or publish a CLI
package. Real model, native desktop and physical phone behavior are not claimed
from the scripted integration/browser tests.
