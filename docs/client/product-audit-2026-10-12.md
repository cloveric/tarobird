# Product audit — 2026-10-12

## Fixed behavior

- **Phone composer:** short text with a quote and multiple attachments used a
  wrapping horizontal layout, placing the text field below the visible keyboard
  area. Rich drafts now use the existing vertical layout and shrink rules.
  Draft text, quote and attachments survive keyboard hide/zoom and send together.
- **Cron revisions:** recording a run or toggling a task could move `updatedAt`
  backwards after a same-millisecond edit. All three mutation paths now advance
  the revision monotonically, so stale clients cannot overwrite or remove a job.
- **Historical conversations:** a valid cached direct conversation with no Bot
  members could crash the sidebar while computing an animal avatar. Such chats
  now remain readable in a conversation section, with their normal context menu
  and no phantom Bot settings or creation actions.
- **Avatar editor recovery:** a failed optional chunk previously unmounted the
  whole chat through an uncaught React lazy rejection. The editor now handles
  loading/failure locally, keeps the draft and presents a localized retry hint.
- **PDF resources:** the shared attachment workflow releases its PDF parser after
  both successful and failed extraction; cleanup errors do not discard extracted
  text or the original attachment.
- **Regression infrastructure:** QR payload helpers no longer import scanner UI
  or CSS. Settings fixtures load real component styles; dashboard controls are
  scoped to their panel; phone collaboration follows the current chat menu.
  Local revocation fixtures use the explicit local-owner API. Math snapshots
  track the updated KaTeX output; all original text nodes remain identical.
  Permission fixtures explicitly exclude the operator's Antigravity executable.
  Vitest excludes compiled `dist` copies to avoid collecting legacy tests.

- **Private macOS packaging:** the first raw Tauri bundle retained only a linker
  signature. The distribution was re-bundled with an explicit ad-hoc identity and
  verified as a sealed App. The release checklist now requires this step and
  verification inside the mounted DMG.

Bot identity, sessions, workspaces, memory, permissions and message protocols are
unchanged. The installed App and existing Hub/Bot services were not restarted.

## Dependency review

- Updated production `adm-zip` to 0.6.1 for the
  [archive allocation fix](https://github.com/advisories/GHSA-7q85-xj36-vmfc).
- Deduplicated transitive KaTeX to the already-used 0.18.10, removing older
  0.16.47 copies from Markdown dependencies. See the
  [KaTeX advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
- Updated `source-map-js` to 1.2.2 and the development test runner to Vitest 4.1.11,
  removing the affected old mocker and Tinypool chain. Node 20 compatibility is
  preserved for the Hub; native client tooling retains its existing Node floor.
- Host production `npm audit --omit=dev`: no reported vulnerabilities.
- Remaining: client Mammoth's unused CLI dependency chain (`argparse` →
  `sprintf-js`, three moderate package findings). Only `mammoth/bin/mammoth`
  imports argparse; neither it nor sprintf appears in the built DOCX worker.
  [sprintf advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
  The root's legacy web build plugin also retains the unpatched braces chain
  (three high package findings, development only, repository-controlled patterns).
  Automatic fixes propose obsolete major downgrades; these were not applied.

## Verification

- `scripts/pre-complete-hook.sh`: standalone build and 205 test files passed;
  2,743 tests passed and one existing case skipped. The release graph contains
  280 modules with no legacy Feishu transport or SDK.
- Clean `npm ci --prefix client`, translation verification, TypeScript and the
  production client build passed.
- Full browser sweeps: Chromium 609 passed / 11 failed / 41 opt-in skips;
  WebKit 563 passed / 12 failed / 42 opt-in skips. Failures exposed the empty-Bot
  crash and stale fixtures described above. The final build was then checked
  against 83 affected cases per browser, including the new historical-chat case.
  Both finished with 82 passing cases and one large-list load timeout under
  concurrent native compilation. That remaining case passed in both engines when
  rerun alone after compilation, without changing its thresholds: 5,000 task rows,
  16–53 ms category switches and 67–94 ms phone stop receipt. All full-sweep
  failures have passing final reruns; this is sweep-plus-targeted evidence, not a
  claim that the original full sweeps were green in one pass.
- Real isolated Tauri window: first-device pairing, avatar selection/save,
  message context menu/reply and retaining the existing draft verified. Native
  transport exercised authenticated HTTP/WebSocket, 8 MiB upload, 512 MiB download
  integrity, certificate/proxy rejection and peer-confirmed close.
- Android JVM and iOS Foundation/Security transport cores passed. Native identity
  cores passed 64 checks each, plus two Node cross-verification proofs and iOS
  plugin type checking. These use synthetic stores, not physical phone vaults.
- Standalone directory and separately unpacked npm tarball installed outside the
  checkout with production dependencies only, started a real Hub under a fresh
  home/minimal PATH and served client assets with no Feishu SDK, credentials or
  CLI. These are install/start proofs, not real-provider engine round trips.
- Android release build, lint and all 20 JVM unit tests passed. APK alignment and
  v2/v3 signature verified with the existing private test certificate. All 335
  client files matched packaged assets (with the intentional mobile CSP rewrite);
  no development server URL is configured.
- macOS 1.0.20 / Hub 0.1.393 and Android 0.1.393-test.1 (code 2026101208)
  are the prerelease artifacts. Mounted-DMG checks validate the App signature,
  version, embedded Node runtime and matching Hub/client assets. macOS retains
  the existing ad-hoc signature; no notarization claim is made.

## Visual evidence

The keyboard comparison uses the same simulated 390 px phone viewport and rich
draft. The desktop screenshot is a real isolated Tauri window using fixture data.

| Keyboard before | Keyboard after |
| --- | --- |
| Clipped field (historical image omitted from this clean snapshot) | Visible field and send controls (historical image omitted from this clean snapshot) |

Native desktop after avatar save and reply (historical image omitted from this clean snapshot)

## Acceptance boundaries

- Android device inventory is empty. Phone viewport and native core checks are
  not physical Android keyboard, camera, background or install acceptance.
- Provider CLI round trips and installed-App upgrades were not repeated in this
  audit. Integration tests use isolated Hub/Gateway fixtures and engine doubles.
- No Apple notarization or signed automatic-update feed is configured; macOS
  prereleases keep the existing ad-hoc signature distribution boundary.
