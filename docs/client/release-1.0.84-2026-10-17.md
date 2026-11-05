# TaroBot 1.0.84 / host CLI 0.1.432

This development preview makes disconnected Bot visibility optional on phones and desktops, moves Connection above My network, explains separate relay endpoints for each host, and keeps Bot captions and attachments in one bubble. The GitHub overview retains adjacent desktop and phone showcases with explicit labels. Cross-host Bot tasks and the previous Windows startup repair remain included.

## Versions and compatibility

- App: **1.0.84**, macOS arm64 / Windows x64 / Android.
- Android: **2026101702**, original `com.tarocub.client` identity and signing certificate.
- Bundled host and standalone CLI: **0.1.432**. Executable source: **[8e94d5d](https://github.com/cloveric/tarobot/commit/8e94d5dae73936e4f1472b1ae9cc3ccf2ee1558c)**; artifact digests are recorded in the verification receipt.
- Client protocol **1**, network membership **2**, Hub schema **17**, supported upgrade input schemas **1–17**. Never open a newer database with an older incompatible runtime.
- Bundled Node **24.14.0**; standalone CLI needs Node 20.17+ (official Node 24 recommended).
- These changes are presentation-only: no new CLI command or host authorization behavior. The matching CLI archive includes the same updated web client and shared host as the desktop bundles. Existing Bot-to-Bot commands remain available; Agent Bus remains local.

[Release downloads and SHA-256 checksums](https://github.com/cloveric/tarobot/releases/tag/v0.1.432-test.1).

## Independent review and fixes

Claude Opus 5.5 was invoked with `--effort xhigh` for a read-only audit of the changes since the previous executable release, followed by a narrow review of the fixes. The returned canonical model identifier was `claude-opus-5-5` on both calls. Model review is not execution evidence or proof that the whole repository has no bugs.

Both confirmed product defects were first reproduced by browser tests:

1. **Explicit history became inaccessible.** With disconnected Bots hidden by default, opening a suspended host’s “View history” hid its other direct chats. The explicit history view now shows that host’s retained history without changing the saved visibility preference, restoring authorization or revealing other hosts’ hidden chats. Desktop Bot/flat and grouped/combined lists, plus phone read-only navigation and retained drafts, are covered.
2. **Empty lists lost their creation path.** An offline Bot without any conversations could cause a misleading “hidden Bots” message, and remove phone creation even when another Bot was online. Empty conversation states now count actual hidden conversations and retain the available creation path.

The follow-up Opus review found no additional confirmed defect in those fixes. Unreproduced suggestions were not converted into speculative product edits.

## Verification

Final results are recorded in the sanitized [verification receipt](evidence/release-1.0.84-2026-10-17.json). Artifact hashes are rechecked after download from GitHub.

| Surface | Result | Boundary |
| --- | --- | --- |
| Source gate | **314 files, 4,141 passed / 1 Windows-only skipped**, four workers | Full standalone build and Vitest; no relaxed test timeout or assertion |
| Client | Clean locked install; translation, TypeScript and Vite build passed | UI build, not native provider permissions |
| Browser UI | **Chromium 351 passed / 1 skipped / 1 existing budget failure; WebKit 36 passed** (unique cases, including precise reruns) | Chromium and WebKit are browser acceptance, not physical devices |
| CLI | Clean production install, dependency audit, archive extraction and package startup passed | No external package-registry publication or OS service installation |
| CLI upgrade | **0.1.431 → 0.1.432**, identity/controller/network/workspace retained; upgraded host started | Disposable external-disk state |
| Real Codex | Text/two-client sync, byte-preserving file return, local ASR, question submit/resume, streaming stop/context recovery passed | Packaged CLI/Hub/Gateway and protocol clients; other engines not rerun live |
| Final Mac DMG | Read-only mount; deep/strict seal; icons/version; embedded HTML/JS/CSS; **746** identical CLI/host files; packaged-Node host smoke passed | Ad-hoc signed, not Apple-notarized; no full App GUI acceptance |
| Final Windows NSIS | Extracted PE runtime imports and exact embedded renderer passed; **746** identical CLI/host files | Unsigned x64 cross-build; no new physical Windows execution |
| Final Android APK | Original signer; version/code; non-debuggable; icons/alignment; **388** frontend files matched; **30 JVM tests**; lint **0 errors / 22 existing warnings** | No physical-phone or push acceptance |
| Android upgrade | Emulator **1.0.83 → 1.0.84**, first-install time retained, cold launch/crash check passed; pairing page visually checked | Emulator only |

### Existing startup budget remains exceeded

The unchanged pairing-page budget requires decoded JavaScript below **700,000 bytes**. The current package loads **825,941 bytes**; rerunning the same test against the released 1.0.83 frontend gives **822,540 bytes**. The increase is **3,401 bytes (0.41%)**. No chat App, Markdown or PDF chunk leaked into pairing. Five local empty-cache browser contexts measured a median **122.5 ms** (previous package **120.1 ms**) to the enabled pairing button, but this is not native startup timing. The budget test remains failed and its threshold was not raised; the expanded browser suite is therefore not described as entirely green.

### Failures investigated during verification

Initial high-concurrency source runs timed out in frozen-runtime probes and the relay installer harness. The host-update file passed all 40 tests unchanged on its own; the complete gate then passed in **151.10 seconds** with four workers, retaining original timeouts and assertions.

Browser fixtures needed explicit offline-history opt-in, correctly scoped controls, waits for persisted preferences/network identity and current host-profile naming. Deletion-related tests were aligned with the existing documented behavior that clears stale quotes/forward dialogs, while retaining text, file-byte, zero-delivery and no-replyTo assertions. An event-failure test originally received ACK before the event it intended to fail; its relay now explicitly queues ACK after the user event, preserving all pending-copy/recovery/exactly-once assertions. Initial failures and precise reruns are retained rather than counted as new passing cases. The Chromium skip is an opt-in check requiring a separately supplied existing MP4; generated video fixtures were verified.

Offline-history browser fixtures explicitly enable “Show disconnected Bots” because they deliberately run without a Gateway. They do not fabricate online presence or silently change normal navigation helpers. Real-Gateway/default/presence scenarios retain their original conditions. Existing fixture timing and selectors are corrected only where an observed failure identifies the mismatch; initial failures and precise reruns are retained.

## Update and acceptance boundaries

Updating the phone changes its interface, not a remote host. Desktop-managed hosts should finish active work before restarting. CLI-managed hosts use the documented stage/apply workflow; installing a command does not switch an existing frozen service. Publication itself does not restart production Apps, Hubs or optional adapters.

Mac packages use ad-hoc signing without Apple notarization. Windows is an unsigned x64 cross-build. Browser and emulator checks are not physical Android or native Windows GUI acceptance, and prior physical-host results are not relabeled as this installer’s results. Cloud [Source checks run 38987624265](https://github.com/cloveric/tarobot/actions/runs/38987624265) did **not start**: GitHub reports failed account payments or an increased spending limit is required. Both jobs have no executed steps. Local results are not cloud CI success.
