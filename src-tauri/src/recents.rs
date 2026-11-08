use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::git::strip_verbatim_prefix;

const MAX_RECENTS: usize = 12;

/// Opening and forgetting run on background threads; this keeps two
/// read-modify-write cycles from dropping each other's change.
fn recents_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
    /// `git` or `perforce`. Older lists omit this and are Git repositories.
    #[serde(default = "default_vcs")]
    pub vcs: String,
}

fn default_vcs() -> String {
    "git".to_string()
}

fn normalize_vcs(vcs: &str) -> String {
    if vcs == "perforce" {
        "perforce".to_string()
    } else {
        "git".to_string()
    }
}

fn recents_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|err| {
        crate::error::AppError::msg(format!("Could not resolve app data directory: {err}"))
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("recents.json"))
}

pub fn load_recents(app: &AppHandle) -> AppResult<Vec<RecentRepo>> {
    let _guard = recents_lock();
    read_recents(app)
}

fn read_recents(app: &AppHandle) -> AppResult<Vec<RecentRepo>> {
    let path = recents_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)?;
    let mut recents: Vec<RecentRepo> = serde_json::from_str(&data).unwrap_or_default();
    let mut changed = false;
    for item in &mut recents {
        let normalized = strip_verbatim_prefix(&item.path);
        if normalized != item.path {
            item.path = normalized;
            changed = true;
        }
    }
    if changed {
        let _ = save_recents(app, &recents);
    }
    Ok(recents)
}

fn save_recents(app: &AppHandle, recents: &[RecentRepo]) -> AppResult<()> {
    let path = recents_path(app)?;
    let data = serde_json::to_string_pretty(recents).unwrap_or_else(|_| "[]".into());
    crate::fsutil::write_atomic(&path, data.as_bytes())?;
    Ok(())
}

pub fn remember_repo(
    app: &AppHandle,
    path: &str,
    name: &str,
    vcs: &str,
) -> AppResult<Vec<RecentRepo>> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path = strip_verbatim_prefix(path);
    let _guard = recents_lock();
    let mut recents = read_recents(app)?;
    recents.retain(|item| item.path != path);
    recents.insert(
        0,
        RecentRepo {
            path,
            name: name.to_string(),
            last_opened: now,
            vcs: normalize_vcs(vcs),
        },
    );
    recents.truncate(MAX_RECENTS);
    save_recents(app, &recents)?;
    Ok(recents)
}

pub fn forget_repo(app: &AppHandle, path: &str) -> AppResult<Vec<RecentRepo>> {
    let path = strip_verbatim_prefix(path);
    let _guard = recents_lock();
    let mut recents = read_recents(app)?;
    recents.retain(|item| item.path != path);
    save_recents(app, &recents)?;
    Ok(recents)
}

/// Relocation preserves ordering and timestamps, and does not add unopened folders.
pub fn relocate_repo(app: &AppHandle, previous: &str, path: &str) -> AppResult<Vec<RecentRepo>> {
    let _guard = recents_lock();
    let mut recents = read_recents(app)?;
    relocate_entries(&mut recents, previous, path);
    save_recents(app, &recents)?;
    Ok(recents)
}

fn relocate_entries(recents: &mut Vec<RecentRepo>, previous: &str, path: &str) {
    let previous = strip_verbatim_prefix(previous);
    let path = strip_verbatim_prefix(path);
    let same = |left: &str, right: &str| {
        if cfg!(windows) {
            left.replace('\\', "/").to_lowercase() == right.replace('\\', "/").to_lowercase()
        } else {
            left == right
        }
    };
    if same(&previous, &path)
        || !recents
            .iter()
            .any(|entry| entry.vcs == "git" && same(&entry.path, &previous))
    {
        return;
    }
    let newest = recents
        .iter()
        .filter(|entry| {
            entry.vcs == "git" && (same(&entry.path, &previous) || same(&entry.path, &path))
        })
        .map(|entry| entry.last_opened)
        .max()
        .unwrap_or(0);
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    for entry in recents
        .iter_mut()
        .filter(|entry| entry.vcs == "git" && same(&entry.path, &previous))
    {
        entry.path = path.clone();
    }
    let mut retained = false;
    recents.retain_mut(|entry| {
        if entry.vcs != "git" || !same(&entry.path, &path) {
            return true;
        }
        if retained {
            return false;
        }
        retained = true;
        entry.name = name.clone();
        entry.last_opened = newest;
        true
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(path: &str, vcs: &str, time: i64) -> RecentRepo {
        RecentRepo {
            path: path.into(),
            name: "Original".into(),
            last_opened: time,
            vcs: vcs.into(),
        }
    }
    #[test]
    fn worktree_relocation_preserves_recent_order_times_and_dual_vcs_entries() {
        let mut recents = vec![
            entry("/work/other", "git", 9),
            entry("/work/old", "git", 7),
            entry("/work/old", "perforce", 6),
            entry("/work/new", "git", 5),
        ];
        relocate_entries(&mut recents, "/work/old", "/work/new");
        assert_eq!(recents.len(), 3);
        assert_eq!(recents[0].path, "/work/other");
        assert_eq!(recents[1].path, "/work/new");
        assert_eq!(recents[1].name, "new");
        assert_eq!(recents[1].last_opened, 7);
        assert_eq!(recents[2].path, "/work/old");
        assert_eq!(recents[2].vcs, "perforce");
    }
    #[test]
    fn relocating_an_unopened_worktree_does_not_change_recent_repositories() {
        let mut recents = vec![entry("/work/other", "git", 9)];
        relocate_entries(&mut recents, "/work/old", "/work/new");
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].path, "/work/other");
    }
    #[test]
    fn relocation_follows_platform_case_rules_for_unicode_paths() {
        let mut recents = vec![entry("/work/Üpper", "git", 4)];
        relocate_entries(&mut recents, "/work/üpper", "/work/new");
        assert_eq!(
            recents[0].path,
            if cfg!(windows) {
                "/work/new"
            } else {
                "/work/Üpper"
            }
        );
    }
    #[test]
    fn an_already_opened_destination_keeps_its_newer_recent_position() {
        let mut recents = vec![
            entry("/work/new", "git", 10),
            entry("/work/other", "git", 9),
            entry("/work/old", "git", 7),
        ];
        relocate_entries(&mut recents, "/work/old", "/work/new");
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].path, "/work/new");
        assert_eq!(recents[0].name, "new");
        assert_eq!(recents[0].last_opened, 10);
        assert_eq!(recents[1].path, "/work/other");
    }
}
