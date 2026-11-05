use std::path::{Path, PathBuf};
use tauri_plugin_fs::FsExt;
use tauri_plugin_opener::OpenerExt;

// The filesystem scope starts empty and the native save dialog grants exactly
// the chosen file. Do not grant the opener access to the home directory or '**'.
fn saved_target(path: &Path, allowed: impl Fn(&Path) -> bool) -> Result<PathBuf, String> {
    if !path.is_absolute() || !allowed(path) { return Err("saved_file_not_granted".into()); }
    let target = path.canonicalize().map_err(|_| "saved_file_unavailable")?;
    // Recheck after resolving links: a replaced symlink cannot widen the grant.
    if !allowed(&target) { return Err("saved_file_not_granted".into()); }
    if !target.is_file() { return Err("saved_file_unavailable".into()); }
    Ok(target)
}

#[tauri::command]
pub async fn quarantine_saved_file(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" { return Err("saved_file_not_granted".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let target = saved_target(Path::new(&path), |candidate| window.fs_scope().is_allowed(candidate))?;
        super::saved_file_quarantine::mark(&target)
    }).await.map_err(|_| "saved_file_quarantine_failed".to_string())?
}

#[tauri::command]
pub async fn open_saved_file(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" { return Err("saved_file_not_granted".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let target = saved_target(Path::new(&path), |candidate| window.fs_scope().is_allowed(candidate))?;
        let target = target.to_str().ok_or("saved_file_unavailable")?;
        window.opener().open_path(target, None::<&str>).map_err(|_| "saved_file_open_failed".into())
    }).await.map_err(|_| "saved_file_open_failed".to_string())?
}

#[tauri::command]
pub async fn reveal_saved_file(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" { return Err("saved_file_not_granted".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let target = saved_target(Path::new(&path), |candidate| window.fs_scope().is_allowed(candidate))?;
        // Reveal the file itself so Finder/Explorer selects it, without granting
        // access to its parent directory or passing a path through a shell.
        window.opener().reveal_item_in_dir(target).map_err(|_| "saved_file_reveal_failed".into())
    }).await.map_err(|_| "saved_file_reveal_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_granted_existing_files_can_open_or_reveal() {
        let root = std::env::temp_dir().join(format!("tarobot-saved-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let file = root.join("用户 选择,最终稿.txt");
        std::fs::write(&file, "saved bytes").unwrap();
        assert_eq!(saved_target(&file, |p| p == file).unwrap(), file);
        assert!(saved_target(&file, |_| false).is_err());
        assert!(saved_target(Path::new("relative.txt"), |_| true).is_err());
        assert!(saved_target(Path::new("https://example.com/file"), |_| true).is_err());
        assert!(saved_target(&root, |_| true).is_err());
        assert!(saved_target(&root.join("missing.txt"), |_| true).is_err());
        #[cfg(unix)] {
            let link = root.join("changed-link.txt");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(saved_target(&link, |p| p == link).is_err());
        }
        let moved = root.join("moved.txt");
        std::fs::rename(&file, &moved).unwrap();
        assert!(saved_target(&file, |p| p == file).is_err());
        assert!(saved_target(&moved, |p| p == file).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
