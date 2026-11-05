# Avatar PR 100 and 101 integration — 2026-10-31

The owner requested merging both avatar follow-ups. The combined review starts
from main `2c303eb4e654684d7b79de4ee5cbc728289b3dd4` and integrates:

- #100, `b18f66369c4b24b876c076ec98f26af141dd5bad`: keep the done smile and
  failed `> <` eyes until read, without replaying completion motion on remount.
- #101, `5160152afbfc8940645b91e29cd41d6ca1ee188d`: working head sway,
  reading eyes and typing bubble, all controlled by the existing avatar setting.

Both merge cleanly. Production changes are confined to avatar presentation.
The shared Host protocol and headless CLI have no behavior change. This review
neither releases an App nor updates an installation.

## Review correction

The first combined WebKit desktop case exposed a nondeterministic test setup:
the fixture could initially select the octopus conversation, then correctly
mark its newly published error reply read. The test was expecting its unread
failure badge to remain. The retained failure trace shows that conversation
open and the badge removed after read acknowledgement. The corrected fixture
explicitly opens the quiet conversation before publishing the replies under
test. The corrected desktop case passes in Chromium and WebKit; the existing
explicit final read-acknowledgement assertion is retained. No production unread
logic was changed. The state table now describes the new working motion.

## Verification

- Focused logic: 13 passed (`client-agent-state`, `client-avatar-face`,
  `bot-avatar-catalog`).
- Host standalone build passed (478 modules); client translations, TypeScript
  and production build passed. Existing chunk-size and mixed keyboard-import
  warnings remain.
- Combined browser coverage: 22 Chromium scenarios passed; WebKit initially
  passed 21 with the desktop unread fixture failure described above. After the
  fixture correction, that desktop scenario passed in both browsers. All 44
  distinct browser scenarios therefore have passing results; repeat runs are
  not added to the coverage count.
- Browser suites: `avatar-agent-state`, `avatars`, `bot-avatar-library`,
  `conversation-avatars`, `layout-density`. No unrelated full-suite rerun.
- GitHub check annotations explicitly report that account payment/spending limits
  prevented jobs from starting; these remote checks are not counted as passed.
- Browser desktop/iOS/Android layout checks do not establish physical-device
  acceptance. Installed 1.0.122 is unchanged.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/avatar-merge-100-101-20261031/`.
The first run is retained alongside the corrected desktop-case runs.
