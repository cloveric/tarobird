# Open a saved attachment

A completed desktop Save As now offers **Open file**, both in the preview and
in the attachment card after the preview closes. It uses the actual chosen path,
including a renamed filename, with the operating system's default application.

- Success is reported only after all bytes are written and the handle closes.
- The path stays in the current card's memory; it is not synced or persisted.
  Starting another save clears the previous target, including if that attempt
  later fails or is cancelled, so a partial replacement cannot appear successful.
- Open failures keep the successful save result and offer an actionable message;
  Open file can be retried, or Save As can be used again. Parallel actions are
  guarded, and closing a preview does not cancel an in-flight save/open.
- Native opening checks the file grant from the save dialog, rejects relative
  paths, directories and missing files, and rechecks canonical paths. No broad
  opener/filesystem permission was added. There is no automatic opening or shell
  interpolation, and no new dependency.
- A browser download or phone share sheet does not reveal a confirmed saved
  destination. These keep their existing accurate handoff status and do not show
  a nonfunctional saved-file button. Phone document previews remain supported.

## Verification

- Root/client builds pass; Rust scoped-file test passes, including missing paths,
  directories, denied paths and changed symlink targets.
- Chromium: 17 desktop-export/file-action cases pass. WebKit: all 7 file-action
  cases pass. IPC doubles cover selected filename, write/close failures, open
  failures and retry, closed preview, cancelled/new saves and 320px layout.
- A separately identified macOS 1.0.12 preview paired to a disposable local Hub.
  Its real Save As dialog renamed `saved-open-check.txt` to a Chinese filename.
  Open file launched TextEdit with that exact on-disk path and all 85 bytes;
  closing the preview left the Open file action in the chat card.
- No user installation, Hub data or running legacy Bot services were changed.
- Android release APK built; no physical Android device is connected. Its real
  device behavior, and Windows/Linux default-app opening, remain unverified.

Release: `v0.1.385-test.1`; desktop `1.0.12`, Android code `2026101113`.
