# Mac recovery simulation on external storage

The requested simulation ran in an isolated process/data laboratory on
`/Volumes/gdrive/taro-tmp/tarobot-mac-recovery-odczamg8`. It used real packaged Mac
host runtimes, synthetic identities/history and isolated browser profiles. It was
not a virtual machine and did not replace, restart or reset the production App.
The complete laboratory occupied approximately 165 MiB after verification.

## Runtime evidence

The old runtime came from the installed Mac App 1.0.71 (host 0.1.424). The new
runtime was the Mac release 1.0.73 host 0.1.425 staging tree: all 4,894 files
matched the manifest captured from the final released DMG. The DMG itself matched
SHA-256 `e934598f8463e9583344bdabcb9f35b1e4ff908448eebead6e26615b952b165c`.
This turn's attempt to mount it read-only was denied by the OS, so the verified
staging tree was used; no new DMG/native installation acceptance is claimed.

`scripts/verify-macos-recovery.mjs` executes each package's own Node and entrypoint
against newly created external state directories. It never changes HOME,
CODEX_HOME, provider login, the credential store, installed OS services or App
files. Six scenarios passed:

| Scenario | Observed result |
| --- | --- |
| Empty profile with either runtime | Status/resume recognize an unconfigured host; no state is created implicitly. |
| Old runtime first start | Real local Hub starts, health responds, and a synthetic owner completes signed enrollment. |
| Replacement runtime with retained data | The same host identity, device authorization, synthetic conversation/message and workspace file survive. |
| Dead owner's stale lock | Resume recovers automatically without replacing the host identity. |
| Truncated configuration | Two retained-state attempts fail with `Unexpected end of JSON input`; isolating the old profile permits fresh startup and new-device enrollment. |
| Damaged SQLite database | Two retained-state attempts fail with `SQLITE_NOTADB`; isolating the old profile permits fresh startup and new-device enrollment. |

The damaged files and synthetic workspace remain unchanged in the laboratory
backups. Fresh hosts have distinct identities, only their newly enrolled device,
and no old conversations. This validates state isolation as a recovery mechanism.
It does **not** implement or validate a native Mac “Start fresh” button; profile
isolation in these scenarios is performed by the laboratory script.

## Client cache and initialization evidence

At source revision `58a0b3f`, an isolated checkout's production frontend build,
translation checks and TypeScript checks passed. Thirty-six distinct browser
journeys pass in each of Chromium and WebKit (72 total):

- 28 network/cache journeys, including a known local-cache failure, native
  startup failure, interrupted cleanup, stale writes, multiple windows and drafts.
- Three local-reset journeys, including cancelled key cleanup, retry after
  failure, and completing reset before returning to the first-use chooser.
- Four desktop initialization/local-route journeys and one missing-chat-chunk
  recovery journey.

The first run had one failed key-cleanup test per browser. Its IPC double rejected
every `desktop_host` call, including the legitimate unconfigured-host query after
cleanup. The fixture now answers only `resume`/`status` with the actual empty-host
contract. It additionally checks that these queries cannot precede key cleanup.
No production startup or identity check was weakened. All eight affected/related
browser journeys passed in the final run of each engine; the unchanged 28 cache
journeys had already passed.

The WebKit screenshot `desktop-fresh-after-reset.png` shows the first-use chooser
after simulated native key cleanup. The bridge is a test double; this does not
exercise actual macOS Keychain prompts, AppKit or a newly installed WebView.

## Isolation and remaining work

Afterward, the production host PID was unchanged; its identity and configuration
hashes matched their pre-test values. No Node process belonging to the laboratory
remained. All test state, builds and logs are on the external disk; existing
browser executables and dependencies were reused without a new VM/browser download.

Mac still lacks the Windows installer's whole-profile fresh-start operation.
These simulations reproduce plausible residual-state failures, not the unknown
root cause on the user's unavailable Windows computer. Real Mac fresh-start UI,
credential prompts, installation replacement and Windows-native acceptance remain
separate work. No release, production migration or user-data cleanup occurred.

CLI impact: this change adds a verification script, fixes an obsolete test double
and records results. Host APIs, schemas, CLI commands and product behavior are
unchanged. Runtime tests exercise the same packaged desktop-host core used by the
App and CLI.

To rerun, use an existing parent directory on `/Volumes/...`, a *new* child lab
name, and explicit package roots:

```sh
"/path/to/new/package/host/node" scripts/verify-macos-recovery.mjs \
  "/path/to/old/package/host" \
  "/path/to/new/package/host" \
  "/Volumes/gdrive/taro-tmp.noindex/new-mac-lab"
```

Do not point the lab argument at existing application state. The script requires
a new directory, preserves its synthetic backups/results and stops its own hosts.
