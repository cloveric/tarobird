# Remove completed and cancelled tickets

The owner can remove a completed or cancelled ticket from a Chancellor’s ticket
list. Desktop and phone ticket rows expose **移除 / Remove** with an inline
confirmation that states the retained scope. Active, paused, blocked and
awaiting-review tickets cannot be removed; cancel them first. Pending execution
stop must settle before removal. This action does not cancel or start execution.

## Shared Host and CLI behavior

- Owner `POST /api/tickets/:id/action`, `{requestId, action: "remove"}`.
- CLI: `tarobot tickets remove TICKET --request-id REQUEST` uses the same route.
  The Bot-run CLI rejects this owner-only action.
- A durable, primary-key-indexed `dispatch_ticket_removals` table hides the entry
  from full/overview/open lists on every device connected to that Host. It does
  not change ticket status, attempts, worker conversations, generated files or
  request deduplication. Direct `tickets show TICKET` remains available, with
  existing owner/dispatcher authorization. Hidden execution chats also remain
  available through the existing show-ticket-conversations setting.
- The owner/session guard, terminal-status check, all-attempts-ended check,
  removal marker and request receipt run in one transaction. Duplicate removals
  and retries are harmless; reusing a request ID for another action is rejected.
  Removal emits no coordinator prompt and sends no stop request to a worker.
- This is an additive visibility table within schema 24, not a new ticket status
  or a change to strict ticket JSON. Older Hosts ignore the table and may display
  removed entries after downgrade; returning to this Host restores filtering.
  Both the App and Host need this change for the new action.
- The UI removes a row only after a confirmed action response or a fresh Host
  list. Failed/unknown actions keep their request ID for retry. List requests
  started before/during an action cannot overwrite its completed result. A
  missing row in a capped list is not itself treated as an action receipt.

## Verification

- Initial negative run: the four new Host/CLI removal cases failed on the old
  action/command schema, before production edits.
- Focused Host/CLI/auth/efficiency: 64 passed; the additional existing-schema
  upgrade regression passed separately (65 distinct tests). Covers done and
  cancelled removal, unfinished-attempt rejection, owner/session guards,
  request replay/conflict, retained results/files/conversations, restart and
  additive upgrade without a schema-version change.
- Final Chromium browser run: 6 passed. Desktop, iPhone-sized and Android-sized
  layouts cover the entry, confirmation, backing out and both terminal states.
  Polling cases cover pause/resume retry preservation, a done-status read that
  must not acknowledge removal, same-ID retry, late list replies and reload.
- Visual review found that a confirmation at the bottom of a long list could
  be below the scroll edge. Opening a confirmation now scrolls it into view
  once; the platform cases assert that the confirmation button is in view.
- Standalone Host build and final client build passed, including TypeScript and
  translation-key checks. Existing Vite chunk/dynamic-import warnings remain.
- Evidence: `/Volumes/gdrive/taro-tmp.noindex/ticket-removal-20261103/` (focused,
  upgrade and browser-final logs; final phone/desktop screenshots).

All verification uses isolated state. These browser tests are not physical
phone or installed-App acceptance. The owner’s real tickets, installed App and
model settings are unchanged. No release or local installation is included.
