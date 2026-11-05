# Porcelain detail polish: PR 61 review

PR: <https://github.com/cloveric/tarobot/pull/61>.

The change refines Porcelain and Monochrome surfaces, sidebar selection, menus,
settings, attachment tiles and phone action sheets. It retains the existing
layout and platform density preferences. Bot-message grants use the shared
Avatar component. Terminal-family palettes are excluded from Porcelain color
rules and custom checkbox painting. Shared component changes include the
host-grouping checkbox dimensions, grant avatars, voice heading and ADHD icon.

This is App presentation only: no Host/API, protocol, persisted state, model,
queue or headless CLI behavior changes. Reviewing and merging this PR does not
publish a release or update the installed App.

## Review base

- Original PR head: `c9d5cfc5dfb25dc11169de2621c957826b6ebcc0`.
- Current main integrated before review: `306ebb73e8aa40492c4e8a796b0762075412a731`.
- The merge was clean. Recent avatar selection/order fixes and interactive-report
  work remain included; their browser regressions are part of this review.
- The original `palettes.spec.ts` adjustment waits for conversation transition
  animations before measuring touch targets. It does not relax the target size.

## Confirmed problems corrected

| Problem reproduced in the original PR | Correction |
| --- | --- |
| Pressing an unselected conversation in dark mode paints a light background under light text (measured contrast approximately 1:1 in Violet, Teal and Monochrome). | Use the theme's `--canvas-hover`; assert actual pressed text contrast. |
| System-dark mode differs from explicit dark: unread badges and select chevrons retain light-mode colors. | Add matching system-dark rules and compare real rendered controls. |
| File actions shrink to 32px on phones and expanded touch windows; an expanded iOS settings select measures only 38px. | Restrict compact desktop control rules to a fine pointer with hover. Retain existing touch target rules. |
| Focusing the phone composer brings back a large full-container shadow. | Keep a quiet border on narrow layouts and coarse-pointer touch windows. |
| WebKit expands a portrait inside an aspect-ratio tile beyond its bound (368px against a 320px limit). | Contain the image absolutely within the existing positioned tile, preserve intrinsic ratio and full-image visibility. |
| Forced-colors mode paints the custom checkbox mark and fill alike, so checked appears empty. | Fall back to native checkbox painting in forced-colors mode. |

The phone-composer regression and expanded touch consistency are distinct:
unchanged main already has a small focus ring at 1024px. Removing that ring on
wide touch windows is an intentional consistency improvement, not a claim that
the PR introduced it. Main passes the dark-mode and forced-colors probes; its
WebKit desktop media check also passes. The original PR fails those checks.

The new `porcelain-details.spec.ts` exercises real paired fixture clients:
dark pressed rows, explicit/system dark equality, Android/iOS touch sizing,
expanded iOS controls, forced colors, and the new three-image layout on phone
and desktop. Existing `media-thumbnails` verifies original proportions, image
opening, decoded video covers and byte-identical downloads.

## Verification

Evidence root: `/Volumes/gdrive/taro-tmp/ui-pr61-review-20261025`.

- App build: translation check, TypeScript check and Vite build pass.
- Root build passes.
- Focused unit coverage: 19 passed in `client-reading-scroll-platform`,
  `client-viewport` and `bot-avatar-catalog`.
- Initial corrected UI probes plus media tests: Chromium 6 passed; WebKit 5
  passed, 1 explicitly skipped because WebKit does not emulate forced colors.
- Three-image regression: 1 passed in each engine, covering both 390px and
  1360px in each test.
- Broad integration run: Chromium 211 passed, 1 skipped, 1 failed; WebKit 210
  passed, 1 skipped, 2 failed. All three failed executions are the two fixture
  issues described below, corrected and successfully rerun in both engines.
- Final distinct coverage, combining the broad run and corrected reruns with
  the Porcelain/media probes: Chromium 219 passed / 1 skipped; WebKit 218 passed
  / 2 skipped. Total: 437 passed, 3 conditionally skipped; no unresolved failure.
  This is combined coverage, not a claim that the initial broad runs were green.
  Chromium skips iOS WebKit scroll compensation; WebKit skips the Chromium
  touch-driver journey and forced-colors emulation.

The broad run covers `palettes`, `sidebar-layout`, `layout-density`, `mobile-im`,
`mobile-settings`, `conversation-details`, `settings`, `settings-notifications`,
`settings-devices`, `settings-language`, `bot-message-grants`,
`attachment-message-actions`, `attachment-composer`, `file-actions`,
`card-layout`, `adhd-board`, `composer-model-controls`, `image-tap-highlight`,
`claude-send-choice`, `iphone-duo`, `safe-area`, `theme-font-size`,
`bot-avatar-library`, `inline-report` and `widget-mobile-parity`.

Representative captures include `settings-system-dark.png`,
`touch-android-390.png`, `touch-ios-390.png`, `touch-ios-1024.png`,
`forced-colors-checked.png`, `image-ratios-1360.png` and `three-images-390.png`.
These are browser-rendered evidence, including simulated platform attributes,
viewport and pointer conditions. They do not establish physical iPhone/Android,
native Mac window or screen-reader acceptance. No production host was restarted.

## Test-fixture corrections

Two existing assertions needed evidence-based corrections without reverting
the UI:

- The attachment tray's smaller tiles can display four items at 390px. The old
  test waits for a scroll button even though there is no overflow. It now adds
  enough documents to overflow both 320px and 390px, then still opens the last
  file, checks literal-text safety, removes the added files and verifies draft
  restoration. It does not skip scrolling coverage.
- The avatar modal test sometimes creates the second conversation and publishes
  the first conversation's message within one millisecond. Both Bots then have
  equal activity time and the valid name tiebreak orders beta first. A separate
  30-sample fixture probe reproduced 20 ties. The test now starts the two fixture
  conversations in the past, so the first published message unambiguously leads.
  Real later activity still reorders rows while the avatar editor stays open.

Both corrected paths pass in Chromium and WebKit: three tests per engine.

## GitHub Actions boundary

The original PR's Source checks and Secret scanning jobs never started. GitHub
annotations identify failed recent account payments or the spending limit, not
a source/build/scanner failure. The original job IDs are `121078882614` and
`121078882511`. Local builds and browser tests above are independent evidence.
Local privacy guards (3 tests) and the repository's full-history secret scan
with the required Gitleaks 8.30.1 also pass. Do not report remote CI as passing.
