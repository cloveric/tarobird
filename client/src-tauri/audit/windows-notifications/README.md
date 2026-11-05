# Windows notification and attachment provenance module check

This crate includes the production `state`, `windows_payload`, `windows`, and
`windows_identity` modules directly. It also compiles the Windows `saved_file_quarantine` implementation
and its NTFS provenance test (the test is executed only on Windows). The Windows bindings and direct versions
match the desktop crate. It adds no production dependency and has no binary.

```sh
cargo check --manifest-path audit/windows-notifications/Cargo.toml --target x86_64-pc-windows-msvc --tests
cargo check --manifest-path audit/windows-notifications/Cargo.toml --target aarch64-pc-windows-msvc --tests
```

Run from `client/src-tauri` with the corresponding Rust target libraries present.
These commands type-check the real WinRT and COM call sites. They do **not** link,
run Windows APIs, compile the complete Tauri app, compile NSIS hooks, install an
application, or test delivery/click behavior. Full app checking requires the
Windows C toolchain (including headers for ring); installer/OS acceptance is a
separate gate. Portable route/XML tests also run in the desktop Rust test suite.
