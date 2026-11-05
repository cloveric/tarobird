# Lossless migration of legacy UTF-16 strings

During actual Tauri 1.0.119 → Electron 1.0.122 acceptance, the native window stopped at `migration_export_failed`. Installed Host 0.1.467, identity/history read-back and the installed-Node model response had passed; none established GUI or legacy-profile migration success.

## Reproduction and correction

An isolated copy of the quiescent pre-install WKWebView backup reproduced the failure. The native writer returned `migration_record_invalid`; its JSON parser reported `unexpected end of hex escape`. A message's two summary fields contained a lone UTF-16 surrogate. JavaScript/IndexedDB preserve those code units and JSON.stringify escapes them, while serde_json requires valid Unicode scalar values. The reader's catch also discarded Tauri's string rejection reason because it only handled Error instances.

`encodeRecordLine` now wraps affected encoded keys/values in the existing content-addressed JSON-blob format. The native writer still verifies the same allowlist, bounds, manifest authentication and blob hashes; the existing JavaScript importer restores the original code units. No record is deleted, repaired with replacement characters, or silently skipped. Valid emoji and literal backslash-u text remain inline. Native errors retain only bounded public migration reason codes; arbitrary details stay hidden.

The format version and importer are unchanged. CLI/Host state and network protocols are unaffected: this is the one-time desktop WebView-to-Chromium data boundary.

## Verification

- 18 focused migration tests passed, including lone high/low surrogates in values/property names/IndexedDB keys, normal emoji, literal escape text, and safe native string errors.
- Client TypeScript check and full client build passed. The initial root TypeScript invocation used the wrong compiler version; the client compiler and build completed successfully.
- Real isolated WKWebView export through the unchanged Rust writer completed: 9,332 records, 84,756,977 bytes, 147 blobs; zero skipped records and zero re-pairing requirements.
- The **original 1.0.122 decoder** read every exported record, including 8,302 messages and four drafts; the previously rejected record retained its exact code units.
- Read-only comparison of every SQLite table cell/type/row/schema proved the original legacy data matched the stopped backup. Changed physical files were WAL checkpoint differences.

Private profiles, keys, exported records and probe data are excluded from Git. Regressions use synthetic values only.

## Local recovery versus distribution

For the owner's Mac, the verified export was admitted with the unchanged installation marker, full manifest/hash verification, a stable source fingerprint and the logical-equivalence checks above. This operation did **not** write an imported-profile marker or receipt. The user-facing Retry action then ran the original installed migration gate; it imported all records and wrote its own committed receipt. CUA verified the actual 1.0.122 window, original macmini connection, existing Bots/conversations and retained appearance; a full application-menu quit and relaunch preserved that state. The Host PID stayed unchanged throughout this recovery.

The published and installed 1.0.122 App remains byte-identical to source `2aee119c15deec1917113ccff16db048a4d6bb65`. This source fix does not retroactively change those assets. A fresh unassisted 1.0.122 upgrade from a legacy profile containing lone surrogates can still hit this error; its original data is retained. Do not reset the profile or re-pair as a workaround. A later release must include this correction and repeat existing-profile acceptance. No replacement version was published by this repair.
