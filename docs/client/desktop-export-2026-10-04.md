# Desktop file-save integrity

2026-10-04. The native save path previously ignored the byte count returned by
Tauri's file writer. An injected short write saved only 69,807 bytes from a
2,097,329-byte attachment while reporting success. The corrected loop keeps
writing each chunk's remaining suffix and advances only by the confirmed count.
Zero, negative, fractional, non-finite or oversized counts fail immediately.
Every opened handle is closed, and close failure cannot become success.

This conclusion is grounded in the installed JavaScript plugin and Cargo-locked
Rust dependency, both `tauri-plugin-fs` 2.6.0. `commands.rs::write` calls
`std::io::Write::write`, not `write_all`; `error.rs` serializes native errors as
strings. The parent checked both directly. The reviewer's restricted Read tool
could not access Cargo sources, so its native-source assertion was an inference,
not independent confirmation.

Actual Claude Opus 5.5 at xhigh reviewed the code and tests. It found no blocking
defect in the write-count fix, and suggested follow-ups now included: native
string rejections receive a translated save-error message, filename truncation
does not split surrogate pairs, Unicode names have a 240-byte UTF-8 cap, and the
entrypoint map includes export tests. Truncation also trims terminal dots/spaces
after limiting length. The review receipt（本地材料：`evidence/desktop-export-opus55-2026-10-04.json`）
retains the reviewer's distinctions between findings and unverified hypotheses.

## Verification boundary

`desktop-export.spec.ts` loads the shipped Tauri JavaScript SDK and supplies a
narrow IPC double which writes actual temporary OS files. It verifies length
and SHA-256 after alternating 4,093/65,537-byte short writes across 1 MiB chunks,
invalid counts, cancellation, I/O and close failures, native string rejection,
and empty files. Initial reproduction: seven failed and two passed. Final
export, filename/preview safety and download-validation cases: 22 passed.

This is controlled native-contract fault injection, not the macOS save dialog
or actual WebView IPC. The Mac was locked when native app access was attempted.
The parent inspected Tauri's IPC encoder (`Array.from` for typed arrays), but
has not exercised the real serialized boundary with an injected short write.

Chromium and WebKit also exercised the real isolated Hub, two browser clients,
120 MiB download interruption, backup route recovery and SHA-256 checks. The
initial WebKit attempt began on backup and therefore never triggered the
primary-only fault. A repeated isolated failure confirmed this was not merely
test load. The test now waits for its intended primary-route baseline before
starting; it does not change production route selection or bypass recovery.

## Remaining limits

- Creating the selected file can truncate an existing target. A later I/O error
  can leave a partial file; this change is not an atomic-save guarantee and does
  not widen filesystem permissions to delete arbitrary paths.
- If both write and close fail, the close failure may replace the earlier error.
  The operation still fails; it never reports a successful save.
- Download cancellation stops only the network phase. The subsequent
  [file-action refinement](file-actions-qa-2026-10-05.md) removes that control
  during native saving/sharing and displays the actual phase. Native write/share
  cancellation is still not claimed; closing the preview does not abort it.
- Long-name truncation can remove the extension. The complete original name
  remains displayed in the conversation; native save-dialog behavior is pending.
- Physical phones, public-network conditions and native save-dialog/runtime
  acceptance remain separate gates. Browser saves do not satisfy those gates.

Final build, package and test details are recorded in the
evidence receipt（本地材料：`evidence/desktop-export-2026-10-04.json`）.
