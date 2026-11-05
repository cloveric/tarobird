# APNs topic routing for old and new iOS identities — 2026-10-29

## Problem

The Host sent every APNs token with one configured `push.apns.topic`. A token is
valid only for the App (bundle ID) that received it, so a Host topic serves
either the old `com.tarocub.client` App or the new `com.tarobot.client` App, not
both. APNs answers a mismatched token with `400 DeviceTokenNotForTopic`; the
sender classified that as `gone`, and the push worker then cleared the device's
subscription. Whichever topic was configured, the other App's first alert
destroyed its valid subscription and Notification readiness asked for a repair
that the next alert undid. An isolated repro (stubbed `node:http2`, real sender)
showed `sent` for the matching App and `gone` for the other under each topic.

## Behavior

- Protocol: the APNs subscription accepts an optional `topic` (bundle-ID
  syntax). Subscriptions without it — every existing record and older client —
  keep the Host's configured `topic`.
- Capability: `GET /api/notifications` returns `apnsTopics` only when APNs is
  configured: the configured `topic` first, then `push.apns.topics`
  (at most 8 additional bundle IDs). Older Hubs return no list.
- Registration (`PUT /api/push`) and token rotation (`PATCH /api/push`) reject a
  declared topic outside that list (`push_subscription_not_allowed`); nothing is
  stored.
- Sending uses the subscription's declared topic. If that topic was later
  removed from the configuration, delivery waits (`unconfigured`) and is never
  sent under another topic. `DeviceTokenNotForTopic` is now `rejected`: that
  alert is marked failed and the subscription is retained. `BadDeviceToken` and
  `410` remain `gone`.
- iOS client: the topic is the installed App's native bundle identifier from
  `App.getInfo()` (validated, cached per installation), never a bundled
  constant. Enabling, background token rotation and explicit readiness repair
  all declare it. Against a Hub without `apnsTopics`, or whose list excludes this
  App, enabling stops before the permission prompt or any Hub write with a
  localized explanation; rotation and repair do not write. Background rotation
  bounds its capability read with the loop's cancellation/20-second signal.
- Readiness never reports ready for such a Host, even with a stored
  subscription: it shows that the Host cannot push to this App, with "update the
  Host" (no `apnsTopics`) or "allow this App's identifier" (not listed), and
  offers no reconnect button.

## Configuration

Keep `push.apns.topic` as the route for subscriptions registered without a
topic (the installed old App). Add the new App with, for example,
`"topics": ["com.tarobot.client"]`. Use credentials authorized for both bundle IDs before sharing
`teamId`/`keyId`/`keyFile`; registering an identifier alone does not verify
the signing key's APNs scope. `sandbox` remains
one Host-wide setting. A Host older than this change rejects a config file that
contains `topics`; remove it before downgrading. No live Host configuration was
changed by this work; the CLI has no push-configuration command, so this is a
`config.json` edit.

## Verification

- `tests/hub-push-apns-topic.test.ts`: five cases failed before the change
  (per-subscription routing, removed-topic wait, mismatch classification, worker
  retention, capability/registration/rotation enforcement) and pass after; a
  Hub without APNs rejects a declared topic.
- `client/tests/apns-topic.test.ts`: maintenance declared no topic / rotated an
  unroutable token before the change; capability, native-identity validation
  and caching are covered.
- Browser: `system-push-native` adds topic-bearing enable/rotation writes and
  the older-Hub/not-allowed refusal before any prompt or write;
  `notification-readiness` adds the older-Hub and not-allowed states (both
  failed before as "ready");
  `native-events` and `notification-readiness` fixtures model the native App
  identity and the advertised list.

Not established: real APNs delivery for either App, TestFlight/App Store builds,
or physical-device acceptance.
