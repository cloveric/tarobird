# Follow-up corrections: joint review

Scope: the seven commits from `27ee6a83` through `8e374c5c`, covering eight user
reports. The cancellation-button color report had no reproduced defect and no
source change. Reviewers: Codex and CC1 running `claude-opus-5-5` / xhigh in a
dedicated collaboration conversation. Opus first reviewed the baseline without
editing production files; confirmed findings were then assigned by file owner.

Confirmed repairs:

- Compaction without a terminal receipt could fence a thread indefinitely.
  The 5-minute wait deadline preserves the original thread; at 15 minutes the
  app-server is recycled once its other work is idle. Pending retries now have
  accurate localized copy. Goal writes honor the same fence. Cross-review also
  fixed Stop during initial status publication and made the hard deadline
  independent of wall-clock corrections. Late receipts and stale timers stay
  bound to their operation and child generation.
- A long public thought stopped refreshing when its stored prefix reached the
  per-entry limit. Thinking now retains the latest bounded text; other journal
  evidence and global capture limits retain their existing behavior.
- The client excerpt could begin with an orphan surrogate when it cut through
  an emoji. Tail excerpts now omit that partial character.
- CJK strong formatting still failed for labels such as `**结论：**TaroBot`,
  `**注意：**1.0.117` and `**结论：**😀好`. Full-width punctuation boundaries now
  support mixed-script prose. Code, escapes, whitespace and ordinary English
  punctuation retain their existing Markdown behavior.

The earlier broad compaction-status failure was a test defect: the first
mid-journey clock override reset `performance.now()` below the history reader's
saved timestamp. Installing the clock before navigation fixes the test. A Hub
phase assertion also distinguishes stored state from client rendering.

No additional defect was found in the Bot settings authorization entry, audio
attachment placement, search-field color, subtitle removal or forwarding.
The latest thinking preview intentionally remains during answer streaming and
is removed on completion; review did not turn this product choice into a bug.

UI/Markdown changes are CLI-not-applicable. Host recovery/journal changes are shared
with standalone CLI Hosts; no new command, schema migration or configuration
change is required. No production restart, release, installation or physical
device acceptance occurred.

Detailed independent findings and focused verification logs are retained in
`/Volumes/gdrive/taro-tmp/followup-joint-audit-20261027/`.

## Verification and limits

- Compaction/goal/error coverage: 13 related unit files, 420 passed after the
  final goal-fence change. The deadline group covers 18 cases, including stale
  timers, late receipts, unrelated active work, Stop and wall-clock jumps.
- Journal/preview coverage: 4 files, 112 passed after the rolling-tail repair;
  the later Unicode excerpt addition passed all 57 presentation-unit cases.
  These runs overlap and are not added into an inflated total.
- Run journeys: 6 Chromium and 2 WebKit cases passed across the corrected
  compaction paths and the phone/desktop long-thinking preview lifecycle.
- Markdown: all 10 Chromium cases and the WebKit streaming case passed; the
  latter checks both phone and desktop widths.
- Official Host build (`tsconfig.app.json`, standalone graph) and client build
  (translations, TypeScript, Vite) passed.
- The additional repository-wide `tsconfig.json` check still fails with 123
  diagnostics. An isolated `git archive 8e374c5c` baseline produced the same 123
  diagnostics, with none added or removed after normalizing checkout paths and
  line positions (`typecheck-comparison.json`). It is not counted as a pass;
  unrelated baseline errors were not rewritten as part of these corrections.

Recovery is deferred while other native work is active. An idle ephemeral side
session can expire with its shared app-server, as with the existing recycle
mechanisms. Verification used isolated protocol/browser fixtures, not a forced
production compaction or a new native installation.
