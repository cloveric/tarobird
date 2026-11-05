# Card constructor coverage

Shared Core card constructors are exercised by translation snapshots, including
retained historical envelope fixtures. These do not install or operate Feishu. Public constructors are invoked directly; private
constructors are reached through the real delivery/approval/action handlers.
Gateway workflow tests additionally use a real Hub and Gateway, with fake engines.
The two native command constructors are additionally covered by semantic
translation tests in `command-result-cards.test.ts` and real Gateway/browser
journeys in `gateway-command-parity.test.ts` and `command-cards.spec.ts`.

| Constructor | Source | Golden scenario |
|---|---|---|
| `renderLarkAccountCard` | account-card.ts | account (retained Core compatibility fixture) |
| `renderCoreBoardTaskCard` | board-card.ts | board_todo/ready/running/review/blocked/done |
| `renderCoreStatusCard` | command-cards.ts | status |
| `renderCommandResultCard` | command-cards.ts | command-result-cards: Markdown preservation; command-cards browser: help/settings |
| `renderCommandUsageCard` | command-cards.ts | command-result-cards: empty/metered/unmetered, zh/en; command-cards browser: phone/desktop |
| `renderCoreResumeScanCard` | command-cards.ts | resume |
| `renderCoreConfigCard` | config-card.ts | config |
| `renderCoreArchiveSummaryCard` | files.ts | archive |
| `renderCoreRunCard` | card-renderer.ts | running/completed/error/interrupted, goal_running/completed |
| `renderCoreRunCardCompact` | card-renderer.ts | compact |
| `renderCoreRunCardMinimal` | card-renderer.ts | minimal |
| `renderCoreReminderCard` | card-renderer.ts | reminder |
| `renderCoreApprovalCard` | card-renderer.ts | approval, approval_allow_once/allow_session/deny |
| `renderCoreQueueWaitCard` | card-renderer.ts | queue |
| `renderCoreQueueLifecycleCard` | card-renderer.ts | queue-notice (preparation and skipped states) |
| `renderCoreQueueCancelledCard` | card-renderer.ts | cancelled |
| `renderCoreNotificationCard` | card-renderer.ts | notification |
| `renderCoreContinuationCard` | card-renderer.ts | continuation |
| `buildCoreImageCard` | delivery.ts | image_batch (two titles, two opaque image keys) |
| `buildCoreToolCard` | delivery.ts | choice, authored_card |
| `renderCoreAskUserQuestionCard` | card-actions.ts | ask_claude/kimi/deepseek, question_retry_form |
| `renderCoreAskUserQuestionSubmittedCard` | card-actions.ts | question_submitted |
| `renderCoreAskUserQuestionRetrySentCard` | card-actions.ts | question_retry_sent |
| `renderCorePendingTimedOutCard` | card-actions.ts | AskUserQuestion_timeout, Bash_timeout |
| `renderCorePendingInterruptedCard` | card-actions.ts | AskUserQuestion_interrupted, Bash_interrupted, native cancellation contracts |
| `renderCorePendingClosedCard` | card-actions.ts | shared terminal shell in both timeout/interruption cases |
| `renderCoreChoiceSubmittedCard` | card-actions.ts | choice_submitted |
| `renderPreservedCoreChoiceSubmittedCard` | card-actions.ts | preserved_choice_submitted (body retained, callbacks disabled) |
| `renderCoreArchiveContinuationSubmittedCard` | card-actions.ts | continue_archive_submitted |

Tests and snapshots live in `tests/gateway-cards.test.ts`,
`tests/gateway-card-states.test.ts`, `tests/gateway-workflows.test.ts` and their
`tests/__snapshots__/` files. `gateway-card-inventory.test.ts` checks the source
constructor list against this ledger. Text-only fallback helpers and element
builders are not whole-card constructors. They are covered by the card snapshots
and existing Feishu tests rather than counted as separate cards.

Additional contracts cover cancellation before an initial or replacement native
card's send receipt arrives, duplicate choice taps, group mini-bus state, board
actions, config callbacks, forms and image batches in the browser.

## Visual acceptance remains separate

These are protocol/behavior snapshots. They do not establish Feishu visual parity.
The required real Feishu samples have not been captured or sent to a live chat.
`client/test-results/` contains only local client screenshots. The constructor
export and browser gallery now exercise 33 source cases, with 14 light/dark
comparisons and five mobile captures. Geometry, typography, explicit card line
breaks and overflow checks are automated. Reference status and reproduction are
tracked in `client/visual-baseline/README.md` and `manifest.json`. When live reference
capture is authorized, store source and client light/dark comparisons under
`client/visual-baseline/`, with source version, viewport, font size, locale and
theme. Include at least running, completed, error, interrupted, goal, thinking,
tool timeline, approval, choice, AskUserQuestion, Kimi form, config, board, image
batch, archive and continuation. Record mismatches rather than replacing the
Feishu reference with a synthetic screenshot.
