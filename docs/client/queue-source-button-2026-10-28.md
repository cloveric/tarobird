# Visible source navigation for queued messages — 2026-10-28

The queue showed preview text and attachment counts, but its source-message link
was hidden in the desktop context menu. Every queued card now has a visible
source button beside its time and drag handle, including on phones.
The button uses only a thin right-turn arrow in the accent color, with no
visible text label or outlined frame. It keeps the full "View original message" tooltip
and ordinal accessible name. Keeping it in the header avoids adding
another item to the move/edit/cancel row; mobile targets retain the existing 44px
minimum height.

The action closes the queue and uses the App's existing message locator to scroll
the original message into view. It resolves the canonical message ID in the
live queue snapshot, so identical previews and reordered cards do not select the
wrong source. It is also available for attachment-only prompts. The context menu
now calls the same handler; navigation is ignored during a queue drag.
The existing `focused-message` class is a locator marker, not a painted highlight;
this change does not add a bubble outline or change search-word highlighting.

Navigation does not mutate the queue, send a prompt or dispatch work. It retains
the chat draft, unsaved queue edits and pending operation receipts. Read-only
location is not tied to the mutation permission or connection state, so cached
messages can still be located offline. The existing locator reports a deleted
or inaccessible source rather than navigating to a different message.

This is client navigation only: Host APIs, queue execution, protocol and headless
CLI are unchanged, so no CLI command is applicable. Actual Opus 5.5 reviewed the
implementation and owns the new browser regression spec. Source validation does
not update the installed App; no release, installation or Host restart is part
of this change.

Evidence: `/Volumes/gdrive/taro-tmp/queue-trace-20261028`.

Validation on this change:

- Client translation check, TypeScript and Vite build passed (`client-build-r3.log`);
  standalone Host build passed (`host-build.log`). The existing Capacitor keyboard
  mixed static/dynamic import warning remains non-blocking.
- Four new journeys passed in Chromium and WebKit (eight executions): normal
  chat and ADHD locate exact IDs among identical text/attachment previews, retain
  both drafts, handle reordering and suppress navigation during dragging; phone
  navigation works with cached history offline; 320px English labels fit without
  clipping and missing originals report the existing error. Navigation asserts
  no queue mutation, message send or revision change.
- Four existing regressions passed in both engines (eight executions): desktop
  context-menu location in chat and ADHD, phone drag/draft/reload, and history
  focus staying put when new replies arrive.
- Desktop, phone and narrow English screenshots were inspected. Touch targets
  remain at least 44px; the source action does not crowd the mutation controls.

These 16 browser executions use isolated Hub fixtures. They do not claim
acceptance of an installed native App or a published release.

Opus review follow-up: its highlight/documentation finding was resolved by
describing the actual scroll/anchor behavior and preserving the existing
no-frame design from `3840b379`. No new production-code blocker was identified.
An immediate ADHD screenshot suggested possible overlap between decoded images
and the next file card; this was not reproduced as a persistent defect, was not
introduced by the queue action, and remains an observation for message-list
investigation rather than a claimed fix or acceptance result.

## Icon simplification follow-up

The initial circular crosshair was replaced with a return arrow. The owner
then requested a short, solid upward arrow. Both the source button and its
matching context-menu action now share `QueueSourceIcon`, a filled glyph with
a compact shaft. The button keeps its accent color, label,
size, touch target and source navigation. This is a presentation-only change;
Host behavior and headless CLI are unaffected.

Follow-up validation: client translations, TypeScript and production build passed;
all four existing `prompt-queue-trace` Chromium journeys passed (normal chat,
ADHD, phone offline navigation and narrow English layout). Desktop and phone
screenshots were inspected. Evidence: `/Volumes/gdrive/taro-tmp/queue-source-icon-20261028`.
This validates the source change, not a newly released or installed App.

Solid-arrow revision: translations, TypeScript and client production build passed.
The existing Chromium chat source-navigation journey passed; its actual queue
screenshot confirms the compact filled arrow. Evidence:
`/Volumes/gdrive/taro-tmp/queue-source-solid-arrow-20261028`. This replaces only
the glyph; no new test or Host/CLI behavior was added.

## Text-button revision

The owner requested a simple framed text button instead of a symbol. The queue
header now uses an icon-free `原消息 / Source` button with a 1px theme border,
6px corners and at least 44px width. Phone touch height stays at least 44px.
The matching context-menu action also has no source glyph, and the unused shared
icon component was removed. Accessible names, source navigation and draft
retention remain unchanged. This is client presentation only; no Host or CLI
behavior changes.

Text-button validation: client translations, TypeScript and production build
passed. Three existing Chromium journeys passed: desktop exact-source
navigation, phone offline navigation with 44px touch targets, and 320px English
layout/error handling. Desktop and phone previews were inspected. Evidence:
`/Volumes/gdrive/taro-tmp/queue-source-text-button-20261028`. No App release or
installation is implied.

## Right-turn arrow revision

The owner preferred a thin right-turn arrow after reviewing the framed text
button. Both source entries now use `CornerUpRight`; the header retains its
text label and accent-colored icon, with no outlined frame. Its minimum target
width remains 44px, with the existing 44px phone height. Navigation and
accessibility labels are unchanged. Host and headless CLI are unaffected.

Right-turn validation: client translations, TypeScript and production build
passed. Two existing Chromium journeys passed: exact source navigation with
draft retention and 320px English layout/error handling. The actual desktop
preview was inspected and delivered. Evidence:
`/Volumes/gdrive/taro-tmp/queue-source-right-turn-20261028`. This remains a source
change, not an App release or installation.

## Arrow-only revision — 2026-10-29

The owner requested removing the visible `原消息 / Source` label on both desktop
and mobile. The shared queue header now contains only the existing accent-colored
right-turn arrow. The 44px minimum phone target, tooltip, ordinal accessible name,
context menu and exact-message locator are retained. This is presentation only;
Host APIs, queue state and headless CLI are unaffected.

Client translation validation, TypeScript and production build passed. All four
existing Chromium source-navigation journeys passed: desktop, ADHD, phone offline
navigation and 320px English layout/error handling. Desktop and phone screenshots
were inspected. Evidence: `/Volumes/gdrive/taro-tmp/queue-source-arrow-only-20261029`.
No App release, installation or physical-device acceptance is implied.

## Straight right-arrow correction — 2026-10-29

The owner clarified that the icon must point straight right (`→`), without a
turning stem. The shared desktop, phone and ADHD row button now uses `ArrowRight`
instead of `CornerUpRight`; the matching context-menu action uses the same glyph.
The row remains icon-only. Accent color, target size, tooltip, accessible name,
exact-message navigation and draft retention are unchanged. This is presentation
only; Host APIs and headless CLI are unaffected.

Client translation validation, TypeScript and production build passed. The four
existing Chromium source-navigation journeys passed (desktop, ADHD, phone offline
and narrow English layout). Phone and desktop screenshots were inspected and
delivered. No new test was needed for the glyph-only correction. Evidence:
`/Volumes/gdrive/taro-tmp/queue-source-straight-arrow-20261029`.
This source correction does not update an installed App or constitute a release.
