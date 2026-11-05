//! Desktop data migration writer for the Tauri transition build.
//!
//! The old WebView exports its own IndexedDB/localStorage logically (no engine
//! files are copied). This module only persists what that page sends: bounded,
//! allowlisted JSONL parts and content-addressed blobs in a private staging
//! directory, then commits by renaming the whole directory after fsync. Record
//! counts, hashes, sizes and the installation binding are computed here; the
//! page can add metadata but cannot assert them. Nothing here reads or deletes
//! the source databases, and nothing depends on Tauri, so the Electron side and
//! tests can verify the same format. The Tauri command wrappers live in main.rs.
use ring::hmac;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const FORMAT: &str = "tarobot-desktop-migration";
pub const VERSION: u64 = 1;
pub const MAX_PART_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_PARTS: usize = 4096;
pub const MAX_BLOBS: usize = 65_536;
pub const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
pub const MAX_SKIPPED: usize = 10_000;
const MAC_DOMAIN: &[u8] = b"tarobot/desktop-migration/v1";
const BINDING_DOMAIN: &[u8] = b"tarobot/desktop-migration/installation/v1\0";
const DIRECTORY: &str = "desktop-migration";

const REGISTRY: &str = "tarocub-hosts-v1";
const REGISTRY_STORES: [&str; 3] = ["hosts", "meta", "networkCandidates"];
// Uncommitted snapshot staging (syncState/syncMessages) is never exported.
const HOST_STORES: &[&str] = &["settings", "conversations", "messages", "activity", "cursors", "outbox",
    "conversationDrafts", "attachmentData", "attachmentMeta", "downloadMeta", "downloadChunks", "workbenchLayouts", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"];
const LOCAL_STORAGE: &str = "localStorage";

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn is_hex(value: &str, len: usize) -> bool { value.len() == len && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }

pub fn host_database(name: &str) -> bool {
    if name == "tarocub-v1" { return true; }
    let Some(rest) = name.strip_prefix("tarocub-host-hub_") else { return false; };
    let (hub, registration) = rest.split_at(rest.len().min(64));
    is_hex(hub, 64) && registration.strip_prefix('-').is_some_and(|r| !r.is_empty() && r.len() <= 64
        && r.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
}
pub fn allowed_store(database: &str, store: &str) -> bool {
    if database == REGISTRY { return REGISTRY_STORES.contains(&store); }
    if database == LOCAL_STORAGE { return store == "items"; }
    host_database(database) && HOST_STORES.contains(&store)
}
pub fn export_id_valid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) })
}

/// Key derived from the 32-byte installation marker (device_installation.rs).
pub fn mac_key(marker: &[u8; 32]) -> [u8; 32] {
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, marker), MAC_DOMAIN);
    tag.as_ref().try_into().expect("HMAC-SHA256 is 32 bytes")
}
pub fn installation_binding(marker: &[u8; 32]) -> String {
    let mut hash = Sha256::new(); hash.update(BINDING_DOMAIN); hash.update(marker); hex(&hash.finalize())
}
pub fn manifest_mac(key: &[u8; 32], manifest: &[u8]) -> String {
    hex(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), manifest).as_ref())
}

/// Collect content-addressed references (`{"$t": .., "ref": "<sha256>"}`).
fn references(value: &Value, out: &mut BTreeSet<String>, depth: usize) -> Result<(), String> {
    if depth > 64 { return Err("migration_record_too_deep".into()); }
    match value {
        Value::Array(items) => for item in items { references(item, out, depth + 1)?; },
        Value::Object(map) => {
            if map.contains_key("$t") {
                if let Some(reference) = map.get("ref") {
                    let reference = reference.as_str().filter(|r| is_hex(r, 64)).ok_or("migration_record_invalid")?;
                    out.insert(reference.to_owned());
                }
            }
            for item in map.values() { references(item, out, depth + 1)?; }
        }
        _ => {}
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|_| "migration_storage_failed")?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "migration_storage_failed".into())
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)] { fs::File::open(path).and_then(|d| d.sync_all()).map_err(|_| "migration_storage_failed")?; }
    #[cfg(not(unix))] { let _ = path; }
    Ok(())
}
fn private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err("migration_storage_invalid".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg_attr(not(unix), allow(unused_mut))]
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
            builder.create(path).map_err(|_| "migration_storage_failed".into())
        }
        Err(_) => Err("migration_storage_failed".into()),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PartInfo { pub file: String, pub bytes: u64, pub sha256: String, pub records: u64 }

/// One in-progress export. It owns exactly its own `.partial` directory and
/// removes it on abort, failed commit or drop. Partials left by another
/// process or a crash are never touched here; `status()` lists them.
pub struct ExportSession {
    exports: PathBuf,
    id: String,
    partial: PathBuf,
    parts: Vec<PartInfo>,
    blobs: BTreeMap<String, u64>,
    referenced: BTreeSet<String>,
    counts: BTreeMap<String, BTreeMap<String, u64>>,
    total: u64,
    key: [u8; 32],
    binding: String,
    committed: bool,
}

/// A real directory, not a symlink; checked again just before commit.
fn real_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        _ => Err("migration_storage_invalid".into()),
    }
}

impl ExportSession {
    /// `state_dir` is the App-local data directory that also holds the
    /// installation marker. Paths never come from the page.
    pub fn begin(state_dir: &Path, marker: &[u8; 32]) -> Result<Self, String> {
        let root = state_dir.join(DIRECTORY);
        private_directory(state_dir)?; private_directory(&root)?;
        let exports = root.join("exports");
        private_directory(&exports)?;
        let id = uuid::Uuid::new_v4().to_string();
        let partial = exports.join(format!("{id}.partial"));
        // A fresh random name: never adopt an existing directory.
        if fs::symlink_metadata(&partial).is_ok() { return Err("migration_storage_invalid".into()); }
        private_directory(&partial)?;
        private_directory(&partial.join("parts"))?;
        private_directory(&partial.join("blobs"))?;
        Ok(Self { exports, id, partial, parts: Vec::new(), blobs: BTreeMap::new(), referenced: BTreeSet::new(), counts: BTreeMap::new(),
            total: 0, key: mac_key(marker), binding: installation_binding(marker), committed: false })
    }
    pub fn id(&self) -> &str { &self.id }
    /// For command wrappers: every request names the export it belongs to.
    pub fn owns(&self, export_id: &str) -> bool { export_id == self.id }
    fn account(&mut self, bytes: usize) -> Result<(), String> {
        self.total = self.total.checked_add(bytes as u64).filter(|t| *t <= MAX_TOTAL_BYTES).ok_or("migration_too_large")?;
        Ok(())
    }

    /// Parts arrive in order. Each line is `{"d","s","k","v"}` for an
    /// allowlisted database/store; nothing else is accepted.
    pub fn write_part(&mut self, index: usize, bytes: &[u8]) -> Result<PartInfo, String> {
        if index != self.parts.len() || index >= MAX_PARTS { return Err("migration_part_out_of_order".into()); }
        if bytes.is_empty() || bytes.len() > MAX_PART_BYTES || bytes.last() != Some(&b'\n') { return Err("migration_part_invalid".into()); }
        let text = std::str::from_utf8(bytes).map_err(|_| "migration_part_invalid")?;
        let mut tally: Vec<(String, String)> = Vec::new();
        let mut referenced = BTreeSet::new();
        for line in text[..text.len() - 1].split('\n') {
            if line.is_empty() || line.len() > MAX_LINE_BYTES { return Err("migration_record_invalid".into()); }
            let Value::Object(record) = serde_json::from_str::<Value>(line).map_err(|_| "migration_record_invalid")? else {
                return Err("migration_record_invalid".into());
            };
            if record.len() != 4 || !["d", "s", "k", "v"].iter().all(|key| record.contains_key(*key)) { return Err("migration_record_invalid".into()); }
            let database = record["d"].as_str().ok_or("migration_record_invalid")?;
            let store = record["s"].as_str().ok_or("migration_record_invalid")?;
            if !allowed_store(database, store) { return Err("migration_store_not_allowed".into()); }
            references(&record["k"], &mut referenced, 0)?;
            references(&record["v"], &mut referenced, 0)?;
            tally.push((database.to_owned(), store.to_owned()));
        }
        self.account(bytes.len())?;
        let file = format!("{index:06}.jsonl");
        write_new(&self.partial.join("parts").join(&file), bytes)?;
        for (database, store) in tally { *self.counts.entry(database).or_default().entry(store).or_default() += 1; }
        self.referenced.extend(referenced);
        let info = PartInfo { file, bytes: bytes.len() as u64, sha256: hex(&Sha256::digest(bytes)), records: text.matches('\n').count() as u64 };
        self.parts.push(info.clone());
        Ok(info)
    }

    /// Content-addressed binary value; repeating identical bytes is a no-op.
    pub fn write_blob(&mut self, bytes: &[u8]) -> Result<String, String> {
        if bytes.len() > MAX_BLOB_BYTES { return Err("migration_blob_too_large".into()); }
        let sha = hex(&Sha256::digest(bytes));
        if self.blobs.contains_key(&sha) { return Ok(sha); }
        if self.blobs.len() >= MAX_BLOBS { return Err("migration_too_large".into()); }
        self.account(bytes.len())?;
        write_new(&self.partial.join("blobs").join(&sha), bytes)?;
        self.blobs.insert(sha.clone(), bytes.len() as u64);
        Ok(sha)
    }

    /// `metadata`: `{"appVersion", "databases":[{"name","version"}], "skipped":[..], "requiresRepair":[..]}`.
    /// On any error the session's own partial directory is removed (Drop).
    pub fn commit(mut self, metadata: &[u8], now_ms: u64) -> Result<Summary, String> {
        let summary = self.commit_inner(metadata, now_ms)?;
        self.committed = true;
        Ok(summary)
    }
    fn commit_inner(&mut self, metadata: &[u8], now_ms: u64) -> Result<Summary, String> {
        if metadata.len() > MAX_METADATA_BYTES { return Err("migration_metadata_invalid".into()); }
        let Value::Object(metadata) = serde_json::from_slice::<Value>(metadata).map_err(|_| "migration_metadata_invalid")? else {
            return Err("migration_metadata_invalid".into());
        };
        if metadata.keys().any(|key| !["appVersion", "databases", "skipped", "requiresRepair"].contains(&key.as_str())) {
            return Err("migration_metadata_invalid".into());
        }
        let app_version = metadata.get("appVersion").and_then(Value::as_str)
            .filter(|v| !v.is_empty() && v.len() <= 64 && v.bytes().all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c)))
            .ok_or("migration_metadata_invalid")?;
        let mut versions = BTreeMap::new();
        for entry in metadata.get("databases").and_then(Value::as_array).ok_or("migration_metadata_invalid")? {
            let name = entry.get("name").and_then(Value::as_str).ok_or("migration_metadata_invalid")?;
            let version = entry.get("version").and_then(Value::as_u64).filter(|v| (1..=1000).contains(v)).ok_or("migration_metadata_invalid")?;
            if entry.as_object().is_none_or(|o| o.len() != 2) || !(name == REGISTRY || host_database(name)) || versions.insert(name.to_owned(), version).is_some() {
                return Err("migration_metadata_invalid".into());
            }
        }
        // Every exported database must declare its schema version, and no
        // version may describe a database with no records.
        let exported: BTreeSet<_> = self.counts.keys().filter(|d| d.as_str() != LOCAL_STORAGE).cloned().collect();
        if exported != versions.keys().cloned().collect() || !versions.contains_key(REGISTRY) { return Err("migration_metadata_mismatch".into()); }
        let skipped = metadata.get("skipped").cloned().unwrap_or(Value::Array(Vec::new()));
        if skipped.as_array().is_none_or(|s| s.len() > MAX_SKIPPED) { return Err("migration_metadata_invalid".into()); }
        let repair = metadata.get("requiresRepair").cloned().unwrap_or(Value::Array(Vec::new()));
        if repair.as_array().is_none_or(|r| r.len() > 1024 || r.iter().any(|h| !h.as_str().is_some_and(|h| h.strip_prefix("hub_").is_some_and(|x| is_hex(x, 64))))) {
            return Err("migration_metadata_invalid".into());
        }
        if let Some(missing) = self.referenced.iter().find(|r| !self.blobs.contains_key(*r)) {
            let _ = missing; return Err("migration_blob_missing".into());
        }
        let records: u64 = self.parts.iter().map(|p| p.records).sum();
        let databases: Vec<Value> = versions.iter().map(|(name, version)| json!({ "name": name, "version": version, "stores": self.counts[name] })).collect();
        let mut body = Map::new();
        body.insert("format".into(), json!(FORMAT));
        body.insert("version".into(), json!(VERSION));
        body.insert("exportId".into(), json!(self.id));
        body.insert("createdAt".into(), json!(now_ms));
        body.insert("installation".into(), json!(self.binding));
        body.insert("source".into(), json!({ "app": "tauri", "appVersion": app_version }));
        body.insert("databases".into(), Value::Array(databases));
        body.insert("localStorage".into(), json!(self.counts.get(LOCAL_STORAGE).and_then(|s| s.get("items")).copied().unwrap_or(0)));
        body.insert("parts".into(), serde_json::to_value(&self.parts).map_err(|_| "migration_storage_failed")?);
        body.insert("blobs".into(), Value::Array(self.blobs.iter().map(|(sha, bytes)| json!({ "sha256": sha, "bytes": bytes })).collect()));
        body.insert("totals".into(), json!({ "records": records, "bytes": self.total }));
        body.insert("skipped".into(), skipped);
        body.insert("requiresRepair".into(), repair);
        let manifest = serde_json::to_vec(&Value::Object(body)).map_err(|_| "migration_storage_failed")?;
        write_new(&self.partial.join("manifest.json"), &manifest)?;
        write_new(&self.partial.join("manifest.mac"), manifest_mac(&self.key, &manifest).as_bytes())?;
        for directory in [self.partial.join("parts"), self.partial.join("blobs"), self.partial.clone()] { real_directory(&directory)?; sync_directory(&directory)?; }
        real_directory(&self.exports)?;
        let committed = self.exports.join(&self.id);
        if fs::symlink_metadata(&committed).is_ok() { return Err("migration_commit_failed".into()); }
        fs::rename(&self.partial, &committed).map_err(|_| "migration_commit_failed")?;
        sync_directory(&self.exports)?;
        Ok(Summary { export_id: self.id.clone(), records, bytes: self.total })
    }

    pub fn abort(self) {}
}

impl Drop for ExportSession {
    // Removes only this session's own staging; a committed export was renamed.
    fn drop(&mut self) { if !self.committed { let _ = fs::remove_dir_all(&self.partial); } }
}

/// Only the holder of `desktop-migration/.export.lock` may call this: no other
/// exporter can be writing. Removes `exports/<uuid>.partial` directories left by
/// a killed or crashed exporter. Links and other names are never touched, and
/// `remove_dir_all` does not follow links inside a partial.
pub fn clean_stale_partials(state_dir: &Path) -> Result<usize, String> {
    let root = state_dir.join(DIRECTORY);
    let exports = root.join("exports");
    for directory in [&root, &exports] {
        match fs::symlink_metadata(directory) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err("migration_storage_invalid".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(_) => return Err("migration_storage_failed".into()),
        }
    }
    let mut removed = 0;
    for entry in fs::read_dir(&exports).map_err(|_| "migration_storage_failed")? {
        let entry = entry.map_err(|_| "migration_storage_failed")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.strip_suffix(".partial").is_some_and(export_id_valid) { continue; }
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() || kind.is_symlink() { continue; }
        if fs::remove_dir_all(entry.path()).is_ok() { removed += 1; }
    }
    Ok(removed)
}

/// An export its exporter committed but could not confirm leaves the importable
/// set by rename (`<id>.rejected`), never by deletion. Neither Rust `status`
/// nor the Electron store lists that name.
pub fn reject_export(state_dir: &Path, id: &str) -> Result<(), String> {
    if !export_id_valid(id) { return Err("invalid_migration_export".into()); }
    let exports = state_dir.join(DIRECTORY).join("exports");
    real_directory(&state_dir.join(DIRECTORY))?; real_directory(&exports)?;
    let committed = exports.join(id);
    real_directory(&committed)?;
    let rejected = exports.join(format!("{id}.rejected"));
    if fs::symlink_metadata(&rejected).is_ok() { return Err("migration_storage_invalid".into()); }
    fs::rename(&committed, &rejected).map_err(|_| "migration_storage_failed")?;
    sync_directory(&exports)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary { pub export_id: String, pub records: u64, pub bytes: u64 }

/// Committed exports and Electron import receipts, for the transition build's
/// "already migrated" mode. Malformed names are ignored, never followed.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub exports: Vec<String>, pub imported: Vec<String>, pub partials: Vec<String> }
pub fn status(state_dir: &Path) -> Result<Status, String> {
    let root = state_dir.join(DIRECTORY);
    let list = |directory: PathBuf, suffix: &str, want_dir: bool| -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        // A redirected directory is refused, never followed.
        for parent in [root.clone(), directory.clone()] {
            match fs::symlink_metadata(&parent) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Ok(_) => return Err("migration_storage_invalid".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(out),
                Err(_) => return Err("migration_storage_failed".into()),
            }
        }
        let entries = fs::read_dir(&directory).map_err(|_| "migration_storage_failed")?;
        for entry in entries {
            let entry = entry.map_err(|_| "migration_storage_failed")?;
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() || kind.is_dir() != want_dir { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(suffix).filter(|id| export_id_valid(id)) { out.push(id.to_owned()); }
        }
        out.sort(); Ok(out)
    };
    Ok(Status { exports: list(root.join("exports"), "", true)?, imported: list(root.join("receipts"), ".json", false)?,
        partials: list(root.join("exports"), ".partial", true)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_partials_are_removed_by_the_lock_holder_without_following_links() {
        let root = lab();
        let exports = root.join(DIRECTORY).join("exports");
        let committed_id = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(exports.join(&committed_id)).unwrap();
        fs::write(exports.join(&committed_id).join("manifest.json"), "{}").unwrap();
        let stale = exports.join(format!("{}.partial", uuid::Uuid::new_v4()));
        fs::create_dir_all(stale.join("parts")).unwrap();
        let outside = root.join("outside"); fs::create_dir_all(&outside).unwrap(); fs::write(outside.join("keep"), "x").unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&outside, stale.join("parts/link")).unwrap();
        let foreign = exports.join("not-an-export.partial"); fs::create_dir_all(&foreign).unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&outside, exports.join(format!("{}.partial", uuid::Uuid::new_v4()))).unwrap();
        assert_eq!(clean_stale_partials(&root).unwrap(), 1);
        assert!(!stale.exists() && foreign.exists() && outside.join("keep").exists());
        assert_eq!(status(&root).unwrap().exports, vec![committed_id.clone()]);
        // An unconfirmed commit leaves the importable set without being deleted.
        reject_export(&root, &committed_id).unwrap();
        assert!(status(&root).unwrap().exports.is_empty());
        assert!(exports.join(format!("{committed_id}.rejected/manifest.json")).is_file());
        assert!(reject_export(&root, &committed_id).is_err());
        assert!(clean_stale_partials(&lab()).unwrap() == 0);
        fs::remove_dir_all(root).unwrap();
    }
    fn lab() -> PathBuf {
        let path = std::env::temp_dir().join(format!("tarobot-migration-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&path).unwrap(); path
    }
    const HOST: &str = "tarocub-host-hub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0f8fad5b-d9cb-469f-a165-70867728950e";
    fn line(d: &str, s: &str, k: Value, v: Value) -> String { format!("{}\n", json!({"d": d, "s": s, "k": k, "v": v})) }
    fn meta(databases: &[(&str, u64)]) -> Vec<u8> {
        serde_json::to_vec(&json!({ "appVersion": "1.0.120", "databases": databases.iter().map(|(n, v)| json!({"name": n, "version": v})).collect::<Vec<_>>() })).unwrap()
    }

    #[test]
    fn commits_atomically_with_authoritative_counts_hashes_and_mac() {
        let root = lab(); let marker = [3u8; 32];
        let mut session = ExportSession::begin(&root, &marker).unwrap();
        let blob = session.write_blob(b"draft bytes").unwrap();
        let part = format!("{}{}{}", line(REGISTRY, "hosts", json!(null), json!({"id": "hub_x"})),
            line(HOST, "conversationDrafts", json!("c1"), json!({"files": [{"$t": "bytes", "ref": blob}]})),
            line(LOCAL_STORAGE, "items", json!("tarocub-appearance"), json!("{}")));
        let info = session.write_part(0, part.as_bytes()).unwrap();
        assert_eq!(info.records, 3);
        let id = session.id().to_owned();
        assert!(status(&root).unwrap().exports.is_empty(), "nothing is visible before commit");
        let summary = session.commit(&meta(&[(REGISTRY, 2), (HOST, 9)]), 1_793_300_000_000).unwrap();
        assert_eq!((summary.export_id.as_str(), summary.records), (id.as_str(), 3));
        let dir = root.join(DIRECTORY).join("exports").join(&id);
        let manifest = fs::read(dir.join("manifest.json")).unwrap();
        assert_eq!(fs::read_to_string(dir.join("manifest.mac")).unwrap(), manifest_mac(&mac_key(&marker), &manifest));
        let body: Value = serde_json::from_slice(&manifest).unwrap();
        assert_eq!(body["installation"], installation_binding(&marker));
        let host = body["databases"].as_array().unwrap().iter().find(|d| d["name"] == HOST).unwrap();
        assert_eq!((host["version"].clone(), host["stores"].clone()), (json!(9), json!({"conversationDrafts": 1})));
        assert_eq!(body["localStorage"], 1);
        assert_eq!(body["parts"][0]["sha256"], hex(&Sha256::digest(part.as_bytes())));
        assert_eq!(status(&root).unwrap().exports, vec![id]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unlisted_stores_missing_blobs_bad_framing_and_mismatched_metadata() {
        let root = lab(); let marker = [4u8; 32];
        let mut session = ExportSession::begin(&root, &marker).unwrap();
        for bad in [line(HOST, "syncMessages", json!(1), json!(1)), line("other-db", "settings", json!(1), json!(1)),
            line("tarocub-host-hub_zz-1", "settings", json!(1), json!(1)), "{\"d\":\"tarocub-v1\",\"s\":\"outbox\",\"k\":1}\n".into(),
            format!("{}x", line(REGISTRY, "meta", json!("a"), json!(1))), "[]\n".into(), "\n".into()] {
            assert!(session.write_part(0, bad.as_bytes()).is_err(), "{bad}");
        }
        assert_eq!(session.write_part(1, line(REGISTRY, "meta", json!("a"), json!(1)).as_bytes()).unwrap_err(), "migration_part_out_of_order");
        drop(session);
        let exports = root.join(DIRECTORY).join("exports");
        assert_eq!(fs::read_dir(&exports).unwrap().count(), 0, "a dropped session removes only its own staging");
        let mut session = ExportSession::begin(&root, &marker).unwrap();
        session.write_part(0, line(REGISTRY, "meta", json!("a"), json!({"$t": "bytes", "ref": "ab".repeat(32)})).as_bytes()).unwrap();
        assert_eq!(session.commit(&meta(&[(REGISTRY, 2)]), 1).unwrap_err(), "migration_blob_missing");
        let mut session = ExportSession::begin(&root, &marker).unwrap();
        session.write_part(0, line(HOST, "outbox", json!("m"), json!({})).as_bytes()).unwrap();
        assert_eq!(session.commit(&meta(&[(REGISTRY, 2)]), 1).unwrap_err(), "migration_metadata_mismatch");
        assert_eq!(fs::read_dir(&exports).unwrap().count(), 0, "failed commits remove their own staging");
        assert!(status(&root).unwrap().exports.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sessions_never_touch_another_partial_and_redirected_directories_are_refused() {
        let root = lab(); let marker = [6u8; 32];
        let other = ExportSession::begin(&root, &marker).unwrap();
        let mine = ExportSession::begin(&root, &marker).unwrap();
        assert!(!mine.owns(other.id()) && mine.owns(mine.id()));
        let listed = status(&root).unwrap().partials;
        assert_eq!(listed.len(), 2, "begin left the other in-progress export alone");
        let other_id = other.id().to_owned();
        mine.abort();
        assert_eq!(status(&root).unwrap().partials, vec![other_id.clone()]);
        std::mem::forget(other); // a crashed process: its partial stays, listed, untouched
        drop(ExportSession::begin(&root, &marker).unwrap());
        assert_eq!(status(&root).unwrap().partials, vec![other_id]);
        #[cfg(unix)] {
            let outside = lab();
            std::os::unix::fs::symlink(&outside, root.join(DIRECTORY).join("receipts")).unwrap();
            assert_eq!(status(&root).unwrap_err(), "migration_storage_invalid");
            fs::remove_file(root.join(DIRECTORY).join("receipts")).unwrap();
            let redirected = lab();
            std::os::unix::fs::symlink(&outside, redirected.join(DIRECTORY)).unwrap();
            assert_eq!(ExportSession::begin(&redirected, &marker).err().unwrap(), "migration_storage_invalid");
            for path in [outside, redirected] { let _ = fs::remove_dir_all(path); }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounds_and_names_are_enforced() {
        assert!(host_database(HOST) && host_database("tarocub-v1"));
        for bad in ["tarocub-host-hub_aa-1", &format!("{HOST}/../x"), "tarocub-hosts-v1", "tarocub-host-hub_"] { assert!(!host_database(bad), "{bad}"); }
        assert!(export_id_valid("0f8fad5b-d9cb-469f-a165-70867728950e") && !export_id_valid("../0f8fad5b-d9cb-469f-a165-70867728950"));
        let root = lab(); let mut session = ExportSession::begin(&root, &[5u8; 32]).unwrap();
        assert_eq!(session.write_blob(&vec![0u8; MAX_BLOB_BYTES + 1]).unwrap_err(), "migration_blob_too_large");
        let long = line(REGISTRY, "meta", json!("k"), json!("x".repeat(MAX_LINE_BYTES)));
        assert_eq!(session.write_part(0, long.as_bytes()).unwrap_err(), "migration_record_invalid");
        let first = session.write_blob(b"same").unwrap();
        assert_eq!(session.write_blob(b"same").unwrap(), first);
        session.abort();
        assert_eq!(fs::read_dir(root.join(DIRECTORY).join("exports")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
