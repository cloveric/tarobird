# Header activity for long-running replies

The chat header and composer inspected only the last eight messages. A run could
still show “正在执行” in its card while later messages pushed it outside that
tail, hiding both “正在回复” and the phone Stop action.

`App.tsx` now collects working Bot authors and pending replies during its existing
conversation message-index pass. The projection is memoized by messages and
selection, so draft edits and connection renders do not scan history. It uses
the same message snapshot as the run cards and is independent of the virtual
viewport. Multiple running replies from one Bot count once; finishing one does
not finish another. Pending replies retain their queue controls without claiming
that the Bot is replying. Forwarded copies and mirrored Agent Bus records do
not count as the current conversation's work.

Disconnecting hides the live reply status; reconnecting, reloading and returning
to the conversation restore it from current message state. Completion, errors
and personal deletion remove only the corresponding active reply. A different
conversation never inherits that activity.

This is shared desktop/mobile presentation. Host execution, stopping APIs,
protocols, storage schemas and headless CLI behavior are unchanged; no CLI
command is needed. There is no version bump, App release or installation.

## Verification

The isolated Hub/browser regression first reproduced the old behavior: a
streaming native run initially showed header activity, then twelve completed
deliveries hid that activity while the run remained streaming.

- Client translation, TypeScript and production build passed; standalone Host
  build passed. Existing bundler warnings remain.
- Four focused unit suites passed: 95 tests covering agent activity, reply
  status, run presentation and Agent Bus record classification.
- Chromium and WebKit passed the six `user-reply-status` journeys each,
  including the new phone/desktop long-running case and group counts. The
  restart fixture correctly expects the existing Bot-offline hint after the
  final reply, because no Gateway reconnects in that fixture.
- Chromium compact phone-header and independent Bus record journeys passed.
  The three Stop journeys and cross-device steering/queue journey also passed.
- Phone and desktop browser screenshots were inspected. New fixtures use a
  synthetic host name; raw test artifacts stay outside Git.

These checks use isolated Hub/browser fixtures and no model calls. They do not
establish installed Android/iOS or desktop App acceptance. No App was released
or installed.
