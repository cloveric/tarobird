# Chancellor model-selection help

A small question-mark button now sits beside **As Chancellor** in New Bot and
beside **Chancellor settings** for an existing Chancellor. Desktop hover uses
the browser's native title hint. Touch, click and keyboard activation open the
same explanation in the existing accessible dialog; closing restores focus.
The help button is outside the checkbox label and has `type="button"`, so
reading help neither changes the role nor submits the creation form.

The Chinese and English copy explains that automatic selection currently tends
toward the Chancellor's own model family and recommends naming another family
when the user wants it. It retains the installed/allowed-engine prerequisite.
It does not claim that cross-family routing is impossible: the
[paired Opus/GPT run](dispatcher-opus-coordinator-comparison-2026-11-02.md)
already observed an autonomous Opus-to-GPT selection.

This is UI help only. Routing, permissions, engine allowlists and existing Bot
configuration are unchanged. CLI applicability: no new Host capability or
setting, so no CLI behavior or command needs modification.

Validation:

- Client translation check, TypeScript check and production build passed.
- Existing dispatcher creation/settings browser regression: 1 passed.
- Isolated Chromium desktop and WebKit 390px touch walkthroughs confirmed the
  hint text, explanation dialog, unchanged checkbox, restored focus and no
  horizontal overflow. Screenshots were inspected after transitions completed.
- The first phone walkthrough used an obsolete test navigation assumption
  (`New Bot` as a direct button); it timed out before reaching the modified UI.
  Using the existing New menu route completed the walkthrough without changing
  production code.

Artifacts: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-routing-help-20261102/`.
These are source/browser checks, not installed-App or physical-phone acceptance.
No App release or local installation was performed.
