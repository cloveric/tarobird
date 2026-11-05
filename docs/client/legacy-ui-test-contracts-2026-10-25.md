# Legacy UI test contract alignment — 2026-10-25

The three failures reported by the UI styling pass were two outdated
expectations, reproduced in both its modified checkout and clean baseline.

- The desktop/phone attachment-action cases expected initial focus on the image
  Close button. The viewer intentionally focuses its passive title first after
  `c3e6a3f`. Commit `190dac6` updated both cases to check title focus, Tab reaching
  Close, focus containment and restoration after dismissal.
- The technical reading-card fixture used a `text` fence while its test required
  horizontal scrolling. Explicit `text`/`txt`/`plaintext` fences have wrapped since
  `34ff70e`. This update labels the program-code example `ts`, makes its second
  line a valid comment, and verifies the language label and preserved whitespace
  before the existing horizontal-scroll and page-overflow assertions.

No assertions are skipped or weakened. `plaintext-blocks.spec.ts` remains the
separate contract for prose wrapping, original whitespace/copy, native and legacy
cards, themes, code/ASCII/unknown-type column alignment and copy-error feedback.
It is rerun alongside `card-layout` and `attachment-message-actions`.

This is a test/fixture-only update. App rendering, Host behavior, data and CLI do
not change; CLI-not-applicable. It does not require an App release or installation.

Evidence: `/Volumes/gdrive/taro-tmp/legacy-ui-tests-20261025` contains the Chromium
and WebKit suite logs, browser artifacts and client translation/type/build log.
Both browsers passed all 18 focused cases (36 executions, no skips or failures),
including the three originally failing cases. The client build passed.
Earlier failure records remain under `ui-layers-tests3` and `ui-layers-baseline3`;
the independent cause checks remain under `ui-failures-diagnosis-20261025`.
