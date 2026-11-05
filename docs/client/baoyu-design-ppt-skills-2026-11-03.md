# Baoyu Design, Baoyu PPT and adapted skills

This change connects the separate upstream Slides editor to the existing Workbench
and installs distinct `baoyu-design` / `baoyu-ppt` adapters. It does not release or
replace an installed App.

## Selection and installation

- “用 Baoyu 设计” selects the canvas; “用 Baoyu PPT” selects the slide editor.
  Explicit Workbench Design tasks and continuation of an already selected project
  retain their existing routing. Ordinary PPT/design requests retain the engine's
  normal skills. There is no assumption that any model's skill is always better.
- Single-chat explicit requests may open the correct format on the sending device.
  ADHD still requires manual opening and never rearranges its panels automatically.
- Both appear separately in the Workbench + menu. Existing custom names are kept.
- `bash scripts/install-skills.sh --skill baoyu-design --skill baoyu-ppt` installs
  the complete adapters and selected authoring references to `~/.claude/skills`,
  `~/.codex/skills` and `~/.agents/skills`. Repeat `--destination` to choose roots.
  Existing sessions may cache discovery; installation is not proof of invocation.
- The upstream raw skills start a filesystem/server workflow. They cannot simply
  be installed unchanged and expected to control an App project. These adapters
  use App tools / the current-turn CLI and preserve target/revision/receipt rules.
- Public skill resources and installer are part of the Host integration allowlist.
  Other installations must run the installer or have their engine's skill manager
  install the packaged adapters; this change does not silently rewrite every
  person's engine configuration during an App update.

## Shared storage, distinct formats

Canvas and slides share `kind:design`, device/conversation storage, leases, atomic
content/layout commits, import/export backups, CAS, deletion and quit protection.
An optional persisted `format:slides` and tab `designFormat:slides` distinguish the
PPT document. Missing format is the existing canvas default. A slide document has
`project/deck.json` v4 and `project/slides/<id>.html`; a canvas has `canvas.json` v3
and `.dc.html`. Cross-format indexes are rejected. The opener chooses matching
format, never a same-named canvas for PPT. Library restoration recovers format
from content when a legacy layout has lost its tab reference.

`design.open/create` gain optional `payload.format`. Host capability
`workbench.design.slides.v1` and App registration `design.slides.v1` fence old
peers. Old Hosts reject PPT before dispatch; a selected old client cannot redirect
the command to a different capable window. PPT tabs are excluded from registration
and frozen context when connected to an old Host. `design.read/publish`, full
explicit targets, turn identity, cancellation and saved receipts are unchanged.
Native App tool schema v11 explains this routing; frozen v1–v10 definitions remain
unchanged (v9 and v10 digests are explicitly covered). Headless CLI uses the same
schemas, capability checks, source identity and guide; it cannot render a project
without a live authorized App.

## Editor boundary

Both editors and adapters are pinned to upstream 2.7.1 commit
`6759e358eb88d83986c753b0fc60c84e4aabdb3a`. `UPSTREAM.json` pins pristine editor bytes
and original SKILL.md/reference hashes. This is aligned integration work, not a
claim that 2.7.1 remains upstream's latest release. The next release must perform
the mandatory upstream update gate, including skills/references/helper scripts.

`client/design-assets.ts` emits a separate lazily loaded `slides-sandbox.html`.
Slides needs upstream's `db` page marker to select the file-backed deck model;
this does not expose a database API or external server. It uses the existing
opaque-origin loader and bounded per-project MessagePort file service. The frame
has no native bridge, parent DOM, arbitrary Host paths or external network. Chat,
comments, rooms, upstream merge/server features and account/share services are not
advertised. Local images and packaged font resources resolve inside the frame.

The adapter settles the upstream live text model before the normal save handshake.
Exports use the existing parent attachment save flow and user-gesture gate. PPTX
creation alone is not a downloaded file. The footer's “备份 PPT 项目” exports a
reimportable `.tarobot-design.json`; PowerPoint/HTML/PDF controls are in the editor.
A slow export can require a second explicit save click after transient activation
expires. No automatic downloads from a Bot publish are authorized.

Mixed upstream notices and third-party notices accompany the editor and skills;
this is not a claim that reconstructed editor/reference/icon assets are MIT.

## Verification

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/baoyu-design-skill-20261103`.

- 209 focused unit/protocol tests passed, including old-tool contracts, wrong
  targets, old peers, orphan recovery, CAS and existing Workbench lifecycle.
- Selected skill install test passed; both SKILL.md files passed the skill validator.
  Global copies in the three roots were read back byte-for-byte (`global-skills.json`).
- Host standalone build and client production build passed. Vendor hashes are
  enforced by the build. Existing chunk-size warnings remain.
- Real browser PPT: Bot publish is visibly rendered, reopens with saved content,
  original canvas stays separate, local SVG renders, immediate close with active
  text preserves edits; a downloaded PPTX ZIP contains the edited slide text.
- Isolated Electron Slides smoke: production CSP/loader, no parent DOM/native
  bridge, visible Bot edit, active-caret save/reopen, theme/resize, save failure
  blocks quitting, retry recovers, actual native quit saves the final text.
  `native-slides-00ccus/verification.json` records 8 checks, not 8 physical-device
  tests. It did not use the production Host or installed App.
- A separate phone-sized WebKit test rendered 9 Chinese slides in order, navigated
  all pages, reopened the project and read back the exact stored order. This is
  WebKit/viewport evidence, not physical iPhone acceptance.
- The public integration packager copied and byte-verified all 42 allowlisted
  resources, including transitive diagram/font/style/print references. Two
  packaging/manifest and symlink-refusal tests and the full-resource installer
  test passed after adding the references. Global copies were refreshed/read back.
- Browser regression: 17 of 21 cases passed in `browser-final.log`; four stale
  literal-name assertions still expected “设计”. After updating them to “Baoyu 设计”,
  all four passed in `open-retest.log`. No production change was made for those
  assertion failures. Together with the separate nine-page WebKit test this gives
  22 distinct passing browser cases. These use fixtures, not the owner's projects.
- The signed-socket Gateway test was then extended to create PPT through the
  actual GatewayTransport → GatewayChannel → app_workbench path. All 15 tests in
  that file passed, including all five engine adapters and both App/Bot capability
  advertisements. Those 15 replace the same cases in the 209 total, not an extra
  model-run count. No real model was called.
- Built CLI `workbench guide browser` includes the same Baoyu routing, slides
  format and ADHD manual-open boundary.
- The staged scanner detected upstream's `aria-keyshortcuts` JavaScript comparison
  as a generic key. Its source bytes are pinned upstream bytes, not a credential.
  The exception requires the exact asset path AND exact expression. Two scanner
  regressions passed: changed syntax, another path, an API-key assignment and a
  synthetic credential in the same file still fail. No vendor-wide skip was added.
  Final staged Gitleaks 8.30.1 scanning passed (`staged-secrets-final.log`, exit 0).

Not claimed: physical iPhone/Android/Windows acceptance, model skill execution in
existing cached sessions, or an updated installed App. No production data was
mutated and no installed App was restarted.
