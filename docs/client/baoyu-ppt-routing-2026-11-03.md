# Native and Baoyu PPT selection

The owner's rule is explicit: “用 Design 做 PPT” uses the engine's native
presentation skill; “用宝玉 / Baoyu PPT” selects `baoyu-ppt`. The voice alias
“宝育 PPT” counts when it clearly names that tool. The word Design, a Workbench
label, or an already selected Baoyu project must not redirect a new ordinary
presentation request to Baoyu.

| Request | Selection |
| --- | --- |
| 用 Design 做 PPT / Use Design to make a PPT | Engine-native presentation skill |
| 做 PPT 放工作台 / Put the PPT in Workbench | Engine-native skill; Workbench is the destination |
| Ordinary PPT, presentation, keynote, 演示 or 簡報 request | Engine-native presentation skill |
| 用宝玉 PPT / Use Baoyu PPT / clearly intended 宝育 PPT | `baoyu-ppt` |
| Explicit Baoyu Design request for a PPT | `baoyu-ppt`, never a canvas |
| Continue the unambiguously selected Baoyu PPT | `baoyu-ppt`, exact existing target |
| Explicit native/no-Baoyu instruction | Engine-native presentation skill |
| Comparison or quoted tool name alone | Discussion, no creation |
| “Current PPT” with two plausible native/Baoyu referents | Resolve the intended project before editing |

## Implementation

2026-11-04 correction: selecting the Workbench destination does not select an
authoring skill. The model must not recommend a branded format or manufacture a
native-versus-Baoyu question merely to put a PPT there. A user accepting such an
assistant-invented option does not supersede the original ordinary PPT request.
Product labels and generated questions use neutral PPT/canvas/Workbench names;
direct questions about the skill actually used still receive truthful answers.

An explicit Workbench PPT request may open `design.open` with `format:slides`
while retaining native authoring. The guide describes publishing that authored
content into the existing editable slide format without loading `baoyu-ppt`.
This is not binary PPTX import: retain/deliver the native original when requested,
and do not promise byte-identical conversion or automatic synchronization.
New native tool contracts use neutral descriptions in v13; persisted v1-v12
descriptions/digests remain frozen and receive corrected turn/on-demand guidance.

`src/gateway/design-guidance.ts` owns the shared selection rule. The on-demand
browser/widgets guide and `tarobot workbench guide` return it. Turn instructions
also include it for presentation wording, closed-panel openers and
selected Design contexts, so resumed sessions with old tool descriptions receive
the correction. The text pattern attaches guidance only: it does not choose a
tool, dispatch `design.open`, authorize a write or change a frozen target.

Both adapted skill descriptions and bodies carry the same distinction. Generic
Workbench Design selection is limited to canvas work; PPT rules are explicit.
Current selection guidance supersedes older generic Design-open hints for
PPT/deck requests only, without rewriting user-owned Bot memories. Native
presentation skill names remain
engine-owned rather than hard-coded to Claude's `pptx`.

CLI impact: the shared headless guide changes with the App guide. No new CLI
command or transport operation is needed. Previously persisted tool-schema
digests remain intact. Canvas,
PPT editing, target ownership and export code are unchanged; Motion is excluded.

## Validation

### Destination correction, 2026-11-04

- Four new contract cases failed before the correction. Final focused source
  regression: 95 tests in four files passed (routing, native tool contracts,
  CLI guide and exact Workbench target routing). Root build passed; the built
  CLI guide returned the same corrected native-authoring route.
- New v13 tools use neutral descriptions. Both frozen v12 hashes still restore
  exactly and receive the new on-demand guide without rewriting their records.
- Opt-in `client/e2e/live-ppt-workbench.spec.ts` passed with a real Claude model,
  temporary Hub/Gateway/Core and paired Chromium. Assistant metadata confirmed
  `claude-opus-5-5`. The ordinary Chinese request named a Workbench destination
  and supplied fictional weather facts; it did not select a branded skill.
- Execution called `Skill` with `pptx`, never `baoyu-ppt` or `baoyu-design`, and
  asked no format/brand question. It opened slides, read/published/read back two
  pages and delivered a real `.pptx` attachment. The Workbench rendered Chinese
  and English, retained two pages and reopened after reload. The screenshot was
  inspected. The original PPTX ZIP/XML contains both pages and the supplied text.
- The native model's separate local PPTX preview lacked Chinese glyphs; this
  check does not certify native PowerPoint rendering or pixel-identical import.
  The Workbench copy is independently editable, not automatically synchronized
  with the native original. No binary import capability was added.
- Client UI source was unchanged; the real-model browser check used the built
  `d2c6288` UI. No installed App, production Bot, global skills, Kimi or other
  model engines were tested or changed in this correction. No release/install.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/native-ppt-workbench-20261104/`.
The opt-in test needs `PPT_LIVE_CLAUDE=1`, `PPT_NATIVE_SKILL` and an isolated
`PPT_NODE_MODULES` directory containing `pptxgenjs`; `PPT_CLIENT_DIST` selects the
built App. Keep any retained private fixture directory local; it is not a report
attachment. The earlier selection-only results below remain separate.

### Original selection correction, 2026-11-03

A blind routing-only probe on actual `claude-opus-5-5` reproduced four incorrect
Baoyu selections in 12 independent Chinese/English cases: ordinary Design PPT,
English Design PowerPoint, new PPT with Baoyu slides selected, and new PPT with
a Baoyu canvas selected. After the fix, the same 12 cases all matched the owner's
rule. Claude's available native presentation skill was `pptx`.

The expanded final model probe passed **18/18** cases, including alternate
presentation wording, explicit Baoyu Design PPT and ambiguous current-project
references. Execution-stream assistant messages independently confirmed
`claude-opus-5-5`; other engines were not live-model tested.

The initial 13 prompt-contract regressions failed before the fix. Four added
language-trigger regressions also failed before extending the guidance trigger.
Three final negative cases covered 投影片 and keeping PPT-specific hints out
of poster/design-system turns. The final local source run passed **97 tests in
seven files**, including all 20 selection tests and existing opener, CLI,
tool compatibility, instruction and
widget contracts. These test guidance delivery across Codex, Claude, Kimi,
DeepSeek and Antigravity; they do not prove all five models' live selections.
`npm run build` passed with a 489-module standalone Host graph. The selected-skill
installation/resource test passed in a temporary destination.

Evidence is retained in
`/Volumes/gdrive/taro-tmp.noindex/baoyu-ppt-routing-20261103/`: baseline and final
probe JSON, actual-model transcript checks, red/green test logs and build logs.
No probe invoked a skill, generated a deck, opened an editor or changed a project.
This is source and real-model semantic selection evidence, not installed-App or
end-to-end PPT generation acceptance.

## Release hold

Publication, version bumps, installation and global skill synchronization remain
held until the owner explicitly permits a release. Existing installed skills and
the running Host do not acquire these source changes from a Git commit. On the
authorized update, sync the adapted skills and validate actual native/Baoyu skill
invocation in the installed App before claiming end-to-end routing acceptance.
