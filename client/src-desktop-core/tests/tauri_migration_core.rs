//! Compiles the Tauri transition build's migration writer without building
//! Tauri. Its own unit tests run here, plus a fixture writer used by the
//! Electron verifier's cross-language check (only when explicitly requested).
#[path = "../../src-tauri/src/desktop_migration.rs"]
mod desktop_migration;

use serde_json::json;

#[test]
fn exports_design_comments_history_and_objects_with_native_validation() {
    let state = std::env::temp_dir().join(format!("design-migration-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&state).unwrap();
    let host = "tarocub-host-hub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0f8fad5b-d9cb-469f-a165-70867728950e";
    let sha = "ab".repeat(32);
    let records = [
        json!({"d":"tarocub-hosts-v1","s":"hosts","k":"host","v":{"id":"host"}}),
        json!({"d":host,"s":"workbenchDesignMeta","k":["scope","design","comments"],"v":{"schema":1,"revision":1,"threads":[]}}),
        json!({"d":host,"s":"workbenchDesignMeta","k":["scope","design","history"],"v":{"schema":1,"revision":0,"versions":[]}}),
        json!({"d":host,"s":"workbenchDesignObjects","k":["scope","design",sha],"v":{"base64":"aGlzdG9yeQ==","contentType":"text/plain"}}),
    ].iter().map(|record| format!("{record}\n")).collect::<String>();
    let mut session = desktop_migration::ExportSession::begin(&state, &[8u8;32]).unwrap();
    assert_eq!(session.write_part(0, records.as_bytes()).unwrap().records, 4);
    let metadata = serde_json::to_vec(&json!({"appVersion":"1.0.127","databases":[
        {"name":"tarocub-hosts-v1","version":2},{"name":host,"version":13}
    ]})).unwrap();
    let summary = session.commit(&metadata, 1_793_300_000_000).unwrap();
    let export = state.join("desktop-migration/exports").join(summary.export_id);
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(export.join("manifest.json")).unwrap()).unwrap();
    let database = manifest["databases"].as_array().unwrap().iter().find(|item| item["name"] == host).unwrap();
    assert_eq!(database["version"], 13);
    assert_eq!(database["stores"], json!({"workbenchDesignMeta":2,"workbenchDesignObjects":1}));
    assert_eq!(std::fs::read_to_string(export.join("parts/000000.jsonl")).unwrap(), records);
    assert!(!desktop_migration::allowed_store("tarocub-hosts-v1", "workbenchDesignMeta"));
    assert!(!desktop_migration::allowed_store(host, "workbenchDesignUnknown"));
    std::fs::remove_dir_all(state).unwrap();
}

/// Writes a deterministic committed export for the Node/TS verifier when
/// TAROBOT_MIGRATION_FIXTURE_DIR (an isolated lab directory) is set.
#[test]
#[ignore = "fixture writer for the lab cross-language check; run with --ignored and TAROBOT_MIGRATION_FIXTURE_DIR"]
fn writes_cross_language_fixture_when_requested() {
    let dir = std::env::var_os("TAROBOT_MIGRATION_FIXTURE_DIR").expect("set TAROBOT_MIGRATION_FIXTURE_DIR to an isolated lab directory");
    let state = std::path::PathBuf::from(dir);
    let marker = [9u8; 32];
    std::fs::create_dir_all(&state).unwrap();
    // Same file name as device_installation.rs uses for the real marker.
    std::fs::write(state.join("tarobot-client-installation-v1"), marker).unwrap();
    let mut session = desktop_migration::ExportSession::begin(&state, &marker).unwrap();
    let records = std::fs::read_to_string(state.join("records.jsonl")).expect("records.jsonl written by the TS exporter");
    let blobs = state.join("blobs-in");
    if blobs.exists() {
        for entry in std::fs::read_dir(&blobs).unwrap() {
            let entry = entry.unwrap();
            let sha = session.write_blob(&std::fs::read(entry.path()).unwrap()).unwrap();
            assert_eq!(sha, entry.file_name().to_string_lossy(), "blob name must be its sha256");
        }
    }
    session.write_part(0, records.as_bytes()).unwrap();
    let metadata = std::fs::read(state.join("metadata.json")).expect("metadata.json written by the TS exporter");
    let summary = session.commit(&metadata, 1_793_300_000_000).unwrap();
    std::fs::write(state.join("summary.json"), serde_json::to_vec(&json!({ "exportId": summary.export_id, "records": summary.records })).unwrap()).unwrap();
}
