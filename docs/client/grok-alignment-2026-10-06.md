# Grok Bot alignment — 2026-10-06 batch

This batch improves three everyday paths in the existing desktop/mobile client.
It does not declare complete Grok Bot parity or replace the native CLI engines.

## Delivered behavior

1. **Complete local conversation drafts.** File bytes, completed voice recordings,
   quotes, link-preview choice/style and reply recipients persist across reload or
   reopening, alongside the existing text draft. The status reports successful
   saving or a retryable failure. Per-host pairing identity, cache generation and
   conversation ownership keep drafts separate. Revision checks reject old-window
   writes; late send/steer receipts retain newer edits. Failed storage and capacity
   checks preserve the visible draft and never evict another unsent draft.
2. **Skills/MCP next steps.** Configuration-status filters and expandable details
   distinguish discovered/configured/disabled metadata from unverified runtime
   health. Add/check prepares an editable message for the selected Bot and host.
   Confirmation creates one direct conversation and saves its message as a draft;
   the user still sends it. Previous conversations and attachments remain intact.
   The phone directory uses a near-full-height sheet with fixed context/tabs.
3. **Mobile pending requests.** The message-list `待处理 / Needs attention` filter
   gathers native questions and approvals, including group topics. Each row opens
   the oldest pending request at its exact message. Working/queued ordinary
   messages, forwarded cards, disabled actions and archived groups do not count.
   Requests disappear when the host confirms resolution, not merely when a reply
   enters the local queue. Only messages synchronized to the client are indexed.

The draft store has a 32-attachment / 64 MiB conversation limit, 128 MiB per-host
limit, 1 MiB metadata limit and 1,000-active-draft bound. These bound offline drafts,
not uploads. Recording in progress must be finished before it can persist; killing
the app before a successful save is acknowledged does not guarantee recovery.
Drafts are local to the device; this batch does not synchronize unsent drafts
between devices.

## Review and fixes

Actual `claude-opus-5-5` at `xhigh` implemented the capability directory refinements;
Astra implemented the persistent draft layer. A second agent implemented pending
requests and independently reviewed integration. Their edits were integrated and
checked against the real Hub paths rather than isolated UI mocks alone.

Cross-review fixed two receipt races: an old dismissed capability dialog could
navigate/close a newer dialog, and treating HTTP 408 as a new creation could
duplicate a conversation. All retry outcomes retain one client action ID, and
old callbacks are guarded while allowing the original draft save to finish.
Review also removed empty rich-draft writes on ordinary text-only send receipts.
Manual phone review prompted an explicit near-full-height cap and shorter copy;
the directory test now guards usable reading space below the fixed header.

The completed Opus review（本地材料：`evidence/grok-alignment-20261006/opus-final-review.md`）
and repair dispositions（本地材料：`evidence/grok-alignment-20261006/review-dispositions.md`）
record the follow-up fixes: clean-draft revalidation after returning to a window,
active-only draft limits, key-rotation cleanup, recording during steering, short-window
capability layout and preserved capability-dialog state through temporary Bot loss.

## Evidence and acceptance boundary

- Repository gate: 237 suites; 3,802 checks passed and one skipped; root and relay
  builds passed. See `evidence/grok-alignment-20261006/root-gate.log`.
- Client translations, TypeScript and production build passed.
- Chromium after review fixes: full focused regression 65/65 and steering-draft
  regression 4/4; 69 distinct cases passed.
- WebKit after review fixes: focused regression 65/65 and steering-draft 4/4;
  69 distinct cases passed. Final logs live in the same evidence directory.
- Coverage includes exact attachment/audio bytes after closing the page, storage
  failures, multi-window CAS, identity revocation/reset, delayed receipts, committed
  creation with a lost 408/503 response, topic navigation, multi-host isolation,
  native forms, voice, attachment composition, steering, snapshots and Back.
- Live Chrome manual inspection used an isolated loopback Hub and fixture Bot,
  normal pairing and the production client. The phone configuration flow reached
  the correct new conversation with `草稿已保存`, with no model turn started.
- No real-engine authorization/installation was executed by these tests. Metadata
  alone does not prove MCP health. This is not a universal OAuth manager.
- Browser viewport and WebKit evidence do not certify an installed Android/iOS
  app. The Mac was locked; packaged native interaction/performance was not accepted.
  No installed application, production Bot fleet or VPS service was changed.
- Application-layer E2EE and a Rust migration remain deferred by the user.

Phone capability inventory（本地材料：`evidence/grok-alignment-20261006/capabilities-phone.png`）

Pending requests from two hosts（本地材料：`evidence/grok-alignment-20261006/attention-two-hosts-phone.png`）

Configuration message saved as a draft（本地材料：`evidence/grok-alignment-20261006/mobile-config-draft.jpg`）

## Development package

macOS universal r28 receipt（本地材料：`evidence/macos-r28-2026-10-06.json`） records both CPU
architectures, strict local ad-hoc signature verification, DMG integrity, read-only
full-bundle comparison, source stability and the matching Downloads copy. Android
and iOS shell assets each match all 303 final frontend files; neither phone app was
compiled or installed in this batch. r28 supersedes the interim r27 package and
includes the final Opus review repairs. The last text-only change updates the
attachment footer to wait for “Draft saved” before quitting; translations/typecheck
and the final native build include it.

Delivery: `~/Downloads/TaroCub_1.0.0_universal-development_20261006-r28.dmg`.
SHA-256: `672167458c8a0ea7a07dc78df363434c9cee61efc2fcb0fff35e966cb209c153`.
