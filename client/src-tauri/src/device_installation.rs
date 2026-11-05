//! The OS vault can survive uninstall. Keys also require an app-data marker.
//! Removing only an executable while retaining app data is not a full uninstall.
use std::{fs, io::{Read, Write}, path::Path};
use zeroize::Zeroizing;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
const MAGIC: &[u8; 8] = b"TBKEY2\0\0";
const CONTEXT: &[u8] = b"tarobot/device-installation/v2";

const MARKER: &str = "tarobot-client-installation-v1";

pub fn identifier(root: &Path) -> Result<[u8; 32], String> {
    marker(root, |file, id| file.write_all(id).and_then(|_| file.sync_all()))
}

fn marker(root: &Path, write: impl FnOnce(&mut fs::File, &[u8; 32]) -> std::io::Result<()>) -> Result<[u8; 32], String> {
    fs::create_dir_all(root).map_err(|_| "device_storage_failed")?;
    let path = root.join(MARKER);
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != 32 => return Err("device_storage_invalid".into()),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => publish(root, &path, write)?,
        Err(_) => return Err("device_storage_failed".into()),
    }
    let mut data = Vec::new();
    fs::File::open(&path).map_err(|_| "device_storage_failed")?.take(33).read_to_end(&mut data).map_err(|_| "device_storage_failed")?;
    data.try_into().map_err(|_| "device_storage_invalid".into())
}

fn private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(path)
}

/// The marker only ever appears complete. Its 32 bytes are written and synced
/// to a private temporary file and then hard-linked into place: a link never
/// replaces an existing marker, so concurrent first launches all read the
/// winner's value, and an interrupted write (disk full, crash) leaves no
/// marker — only a stray temporary file, swept later — instead of a marker
/// that is invalid for good. Filesystems without hard links keep the previous
/// exclusive-create path.
fn publish(root: &Path, path: &Path, write: impl FnOnce(&mut fs::File, &[u8; 32]) -> std::io::Result<()>) -> Result<(), String> {
    sweep(root);
    let (mut id, mut name) = ([0u8; 32], [0u8; 8]);
    getrandom::fill(&mut id).and_then(|_| getrandom::fill(&mut name)).map_err(|_| "secure_random_unavailable")?;
    let temporary = root.join(format!(".{MARKER}.{}.tmp", name.iter().map(|byte| format!("{byte:02x}")).collect::<String>()));
    let mut file = private_file(&temporary).map_err(|_| "device_storage_failed")?;
    let written = write(&mut file, &id);
    drop(file);
    let result = match written.map(|_| fs::hard_link(&temporary, path)) {
        Err(_) => Err("device_storage_failed".to_owned()),
        Ok(Ok(())) => {
            #[cfg(unix)] { let _ = fs::File::open(root).and_then(|directory| directory.sync_all()); }
            Ok(())
        }
        // Another process published first; everyone reads its marker.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Ok(Err(_)) => match private_file(path) {
            Ok(mut file) => file.write_all(&id).and_then(|_| file.sync_all()).map_err(|_| "device_storage_failed".to_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err("device_storage_failed".to_owned()),
        },
    };
    let _ = fs::remove_file(&temporary);
    result
}

/// Temporary files of writers that died. A live writer's file is seconds old.
fn sweep(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&format!(".{MARKER}.")) || !name.ends_with(".tmp") { continue; }
        let old = entry.metadata().ok().filter(|meta| meta.is_file()).and_then(|meta| meta.modified().ok())
            .and_then(|time| time.elapsed().ok()).is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if old { let _ = fs::remove_file(entry.path()); }
    }
}

pub fn bind(installation: &[u8; 32], seed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if seed.len() != 32 { return Err("device_key_invalid".into()); }
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, installation).map_err(|_| "device_key_invalid")?);
    let mut nonce = [0u8; 12]; getrandom::fill(&mut nonce).map_err(|_| "secure_random_unavailable")?;
    let mut encrypted = Zeroizing::new(seed.to_vec());
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(CONTEXT), &mut *encrypted).map_err(|_| "device_key_write_failed")?;
    let mut value = Zeroizing::new(Vec::with_capacity(68)); value.extend_from_slice(MAGIC); value.extend_from_slice(&nonce); value.extend_from_slice(&encrypted); Ok(value)
}
pub fn seed(installation: &[u8; 32], value: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if value.len() != 68 || !value.starts_with(MAGIC) { return Err("device_pairing_required".into()); }
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, installation).map_err(|_| "device_key_invalid")?);
    let nonce = Nonce::try_assume_unique_for_key(&value[8..20]).map_err(|_| "device_key_invalid")?;
    let mut encrypted = Zeroizing::new(value[20..].to_vec());
    let plain = key.open_in_place(nonce, Aad::from(CONTEXT), &mut encrypted).map_err(|_| "device_pairing_required")?;
    if plain.len() != 32 { return Err("device_key_invalid".into()); }
    Ok(Zeroizing::new(plain.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_keeps_keys_but_full_data_removal_rejects_old_vault_and_legacy_keys() {
        let root = std::env::temp_dir().join(format!("tarobot-installation-{}", uuid::Uuid::new_v4()));
        let first = identifier(&root).unwrap(); let secret = [7u8; 32];
        let saved = bind(&first, &secret).unwrap();
        assert_eq!(identifier(&root).unwrap(), first);
        assert_eq!(seed(&first, &saved).unwrap().as_slice(), &secret);
        fs::remove_dir_all(&root).unwrap();
        let next = identifier(&root).unwrap(); assert_ne!(next, first);
        assert_eq!(seed(&next, &saved).unwrap_err(), "device_pairing_required");
        assert_eq!(seed(&next, &secret).unwrap_err(), "device_pairing_required");
        let fresh = bind(&next, &[9u8; 32]).unwrap(); assert!(seed(&next, &fresh).is_ok());
        fs::write(root.join("tarobot-client-installation-v1"), b"invalid").unwrap();
        assert_eq!(identifier(&root).unwrap_err(), "device_storage_invalid");
        fs::remove_dir_all(root).unwrap();
    }
    fn lab() -> std::path::PathBuf { std::env::temp_dir().join(format!("tarobot-installation-{}", uuid::Uuid::new_v4())) }
    fn temporaries(root: &Path) -> Vec<String> {
        fs::read_dir(root).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.ends_with(".tmp")).collect()
    }
    #[test]
    fn concurrent_first_launches_agree_on_one_complete_marker() {
        for _ in 0..20 {
            let root = lab();
            let start = std::sync::Arc::new(std::sync::Barrier::new(16));
            let ids: Vec<_> = (0..16).map(|_| { let (root, start) = (root.clone(), start.clone()); std::thread::spawn(move || { start.wait(); identifier(&root) }) })
                .collect::<Vec<_>>().into_iter().map(|thread| thread.join().unwrap().unwrap()).collect();
            assert!(ids.iter().all(|id| *id == ids[0]), "every launcher reads the winner's marker, never a partial one");
            assert_eq!(fs::read(root.join(MARKER)).unwrap(), ids[0]);
            assert!(temporaries(&root).is_empty());
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(root.join(MARKER)).unwrap().permissions().mode() & 0o777, 0o600); }
            fs::remove_dir_all(&root).unwrap();
        }
    }
    #[test]
    fn an_interrupted_write_leaves_no_marker_and_the_next_launch_succeeds() {
        let root = lab();
        // Disk full after a partial write: the old code left this as the marker.
        let failed = marker(&root, |file, id| { file.write_all(&id[..7])?; Err(std::io::Error::other("disk full")) });
        assert_eq!(failed.unwrap_err(), "device_storage_failed");
        assert!(!root.join(MARKER).exists(), "no partial marker is published");
        assert!(temporaries(&root).is_empty());
        let id = identifier(&root).unwrap();
        assert_eq!(identifier(&root).unwrap(), id);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_writer_that_died_is_never_adopted_and_only_old_leftovers_are_swept() {
        let root = lab(); fs::create_dir_all(&root).unwrap();
        let (stale, live) = (root.join(format!(".{MARKER}.dead.tmp")), root.join(format!(".{MARKER}.live.tmp")));
        fs::write(&stale, [5u8; 32]).unwrap(); fs::write(&live, [6u8; 32]).unwrap();
        fs::File::options().write(true).open(&stale).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(7200)).unwrap();
        let id = identifier(&root).unwrap();
        assert!(id != [5u8; 32] && id != [6u8; 32], "unpublished bytes are never the installation");
        assert!(!stale.exists(), "a dead writer's file is swept");
        assert!(live.exists(), "a possibly live writer's file is left alone");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_vault_values_and_wrong_installations_are_rejected() {
        for len in [0, 31, 32, 33, 63, 65, 67, 68, 69] { assert!(seed(&[1; 32], &vec![1; len]).is_err()); }
        assert!(bind(&[1; 32], &[1; 31]).is_err());
        assert!(seed(&[2; 32], &bind(&[1; 32], &[7; 32]).unwrap()).is_err());
        let original = bind(&[1; 32], &[7; 32]).unwrap();
        for index in [0, 8, 19, 20, 40, 67] { let mut tampered = original.to_vec(); tampered[index] ^= 1; assert!(seed(&[1; 32], &tampered).is_err()); }
    }
}
