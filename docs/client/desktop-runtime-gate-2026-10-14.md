# Full-host package integrity — 2026-10-14

The desktop resource directory is reused by macOS and Windows builds. The old
build guard only rejected non-arm64 Mac targets and still described Windows as
a companion without host resources. It did not compare the runtime receipt or
binary bytes with the actual target. A leftover Windows host could consequently
enter a Mac package, or a Mac host a Windows package.

`src-tauri/build/desktop_runtime.rs`, called by `build.rs`, now validates an
existing host directory before Tauri builds. It checks the receipt's platform,
architecture and standalone SDK, rejects a leftover foreign Node executable,
checks Node and every native addon using their Mach-O/PE headers, and requires
the Hub entrypoint, frontend and SQLite addon. A missing host is permitted only
for source/unit builds; installer resource mapping still requires the host.
Cargo watches the complete host directory so changing only an addon also reruns
validation during incremental builds.
Prepare the correct platform with `scripts/prepare-desktop-host.mjs`; never
modify the receipt to get past a target mismatch.

The generic client workflow now prepares and tests the same full-host targets
as the dedicated Windows workflow: macOS Apple Silicon and Windows x64. Both
include an isolated synthetic-engine host round trip executed with the packaged
Node on the target OS. The earlier universal/Intel Mac and native Windows ARM64
installer rows did not prepare compatible host runtimes and are no longer
advertised as working packages. Windows ARM64 continues to use the x64 package
under OS emulation; genuine additional architectures require separately
prepared and verified Node/SQLite resources before restoring installer jobs.

The GitHub standard `macos-latest` runner is currently arm64, while the Windows
row uses x64. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Validation

- `node client/scripts/desktop-runtime-audit.mjs` compiles the exact guard in a
  temporary small Rust crate, without rebuilding Tauri or replacing host files.
  Four tests cover both valid targets, cross-target reuse, relabelled Node and
  SQLite binaries, unsupported targets, mixed runtimes, missing/invalid receipts,
  incorrect CPU architecture, truncated headers and incomplete payloads.
- Optional `host-directory target-triple` arguments also inspect prepared or
  extracted package bytes. The existing 1.0.66 Mac and Windows resources were
  inspected with this mode; this is an architecture check, not code execution.
- `cargo metadata --locked --offline --no-deps` accepts the added build-time
  serde_json dependency without changing the resolved dependency versions.
- The revised workflow parses as YAML. It has not been executed on GitHub in
  this audit, so no new CI or Windows runtime acceptance is claimed.

Finish package copying and verification before preparing another platform;
Mac and Windows builds must not concurrently replace the shared host directory.
