# Collaboration message stability and efficiency

This source revision addresses unnecessary report callbacks, long waits and
source-turn admission races. It does not release or install an App.

## Return results once

Gateway guidance asks delegated Bots to reply in their collaboration conversation.
The requester reads that reply with `messages wait` or an agreed artifact. Sending
the same report or progress again into the requester's user conversation is not
the default. Explicit callbacks and genuinely new information remain possible;
an acknowledgement does not need another acknowledgement. An interruption is
reported as failure and is not a reason to choose a different owner conversation
for a fallback report. Ticket workers keep their existing result protocol.

Delayed reports must be checked against work already handled before launching
another audit or test run. These are model instructions, not a durable task/result
deduplication protocol. The Host never drops input based on age, text similarity,
hop count or an unrelated completed reply. Owner cancellation and existing exact
request-ID idempotency remain the only applicable removal/deduplication paths.

## Admission and waiting

For Bot-origin writes, an active source context at API entry is insufficient:
the source is checked again after preparation. Same-Host message and conversation creation check it inside their database
admission guard; uploads check before accepting each write and remote requests
check before exchange.
Already accepted sends and upload writes keep their receipts if the source
finishes or the chat is archived afterward; grant and membership checks remain.
In-flight remote effects cannot be cancelled by this check, and an uncertain
transport response is never automatically resent. Result reads remain possible
after the source turn ends. Owner CLI sends retain their existing authority.

`messages wait` reads immediately, then waits 1.5, 3 and at most 6 seconds between
reads. A synthetic one-hour pending task needs at most 605 reads instead of 2,401;
completion detection can add up to one six-second interval, excluding transport
latency. Timeout, cancellation, session refresh and no-resend rules are preserved.
Wire schemas, grants and audit retention quotas do not change.

Accepted results and their files remain readable by exact conversation/message
IDs after archiving. Exact IDs precede names, including an active conversation
whose title happens to equal an archived ID. Exact-ID operations no longer build
the whole conversation directory. Names and listings still omit archived chats;
the original member, grant and request-source checks remain authoritative.
New messages and uploads to archived chats are refused, including an archive
between resolution and upload admission. An identical accepted request may
return its original receipt but cannot enqueue it again or undo cancellation.
An archived default collaboration chat returns `bot_message_collaboration_archived`;
use an explicitly new conversation or ask the owner to restore it. The Host does
not silently rotate the default or unarchive anything.

## Presentation

Bot-origin input is shown as a collapsible collaboration message. Its source and
short excerpt remain visible; the full reader mounts on first expansion. Its
attachments and complete text remain available. Once opened, the reader stays
mounted while folded to preserve preview state. A bounded in-memory preference
survives virtualized row remounts; locating the original expands it once.

Ordinary user messages, Bot replies (including failures), queue controls and
dispatcher notices retain their existing presentation. Collapsing does not mark
anything handled, acknowledge a delivery, cancel work or change model context.
Cancellation and unsupported-worker status cards appended to a Bot-origin input
also remain unfolded, including when they arrive after its body was collapsed.
This presentation change has no CLI state/API equivalent.

## Verification boundary

Focused tests cover the old admission race, rejection without target enqueue,
accepted receipt preservation on local/remote paths, post-turn result reads,
no conversation creation after source completion, bounded polling, timeout,
abort and uncertain-response behavior. Gateway integration tests cover owner,
delegated and ticket-worker instruction separation. UI checks use isolated Hubs
with synthetic messages, paired browser clients and desktop/narrow-phone viewports.
Chromium checks cover 1360, 390 and 320 pixel widths, Chinese and English,
attachment previews, original-message location, retained disclosure choices,
reload, non-overlapping measured rows and absence of page errors. The attempted
WebKit full-App journey stalled during pairing before reaching conversation UI;
it is not a passing full-App or iOS acceptance result. A separate WebKit fixture
using the actual disclosure component passed at the same three widths in both
locales (lazy mounting, expand/collapse, locate, remount and layout bounds).

These source and browser checks are separate from installed-App, physical-phone,
multi-machine and real-model behavioral acceptance. Instructions reduce redundant
callbacks but cannot guarantee every model will comply or infer report freshness.
