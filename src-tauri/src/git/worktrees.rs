//! Worktree administration keeps native Git ownership and filesystem semantics.
use super::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;

const STALE: &str = "Worktrees changed. Reload before continuing.";

#[derive(Clone, Copy, Debug, serde::Deserialize, Serialize, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeAction {
    Lock,
    Unlock,
    Move,
    Repair,
    RepairAll,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRequest {
    pub kind: WorktreeAction,
    pub path: String,
    pub destination: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePreview {
    pub tree: Option<WorktreeInfo>,
    pub destination: String,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChange {
    pub previous_path: Option<String>,
    pub path: Option<String>,
    pub snapshot: WorkspaceSnapshot,
}

pub(super) struct WorktreeLock(fs::File);
impl WorktreeLock {
    pub(super) fn acquire(repo: &Repository) -> AppResult<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(repo.commondir().join("rebaseraven-worktrees.lock"))?;
        file.try_lock()
            .map_err(|_| AppError::msg("Another worktree change is still running."))?;
        Ok(Self(file))
    }
}
impl Drop for WorktreeLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn hash_path(path: &Path, hash: &mut DefaultHasher, contents: bool) -> AppResult<()> {
    path.hash(hash);
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if contents && meta.is_dir() {
                "directory".hash(hash);
                return Ok(());
            }
            (
                meta.len(),
                meta.modified().ok(),
                meta.created().ok(),
                meta.file_type().is_symlink(),
            )
                .hash(hash);
            if contents && meta.is_file() {
                if meta.len() > 64 * 1024 {
                    return Err(AppError::msg("Worktree metadata is too large to inspect."));
                }
                let mut bytes = Vec::new();
                fs::File::open(path)?
                    .take(64 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 64 * 1024 {
                    return Err(AppError::msg("Worktree metadata changed while reading."));
                }
                bytes.hash(hash);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing".hash(hash),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn hash_directory(path: &Path, hash: &mut DefaultHasher) -> AppResult<()> {
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Err(AppError::msg("The worktree folder is missing."));
    }
    path.hash(hash);
    meta.created().ok().hash(hash);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino()).hash(hash);
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        };
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // The directory handle and output structure remain valid throughout the call.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        (
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        )
            .hash(hash);
    }
    Ok(())
}

pub(super) fn catalog_fingerprint(
    repo: &Repository,
    output: &[u8],
    trees: &[WorktreeInfo],
) -> AppResult<String> {
    let mut hash = DefaultHasher::new();
    repo.commondir().hash(&mut hash);
    repo.workdir().hash(&mut hash);
    output.hash(&mut hash);
    for tree in trees {
        hash_path(&Path::new(&tree.path).join(".git"), &mut hash, true)?;
    }
    let directory = repo.commondir().join("worktrees");
    if directory.is_dir() {
        let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_type()?.is_dir() {
                continue;
            }
            for name in ["gitdir", "commondir", "HEAD", "locked", "config.worktree"] {
                hash_path(&entry.path().join(name), &mut hash, true)?;
            }
        }
    }
    Ok(format!("{:016x}", hash.finish()))
}

fn absolute_path(root: &Path, value: &str) -> AppResult<PathBuf> {
    if value.is_empty() || value.len() > 8192 || value.contains('\0') {
        return Err(AppError::msg("Choose a worktree folder."));
    }
    let path = PathBuf::from(strip_verbatim_prefix(value));
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn read_link(file: &Path, prefix: &str) -> AppResult<PathBuf> {
    let meta = fs::symlink_metadata(file)?;
    if !meta.is_file() || meta.len() > 8192 {
        return Err(AppError::msg(
            "Choose a linked worktree with a Git connection file.",
        ));
    }
    let mut text = String::new();
    fs::File::open(file)?.take(8193).read_to_string(&mut text)?;
    if text.len() > 8192 {
        return Err(AppError::msg("The Git connection file is too large."));
    }
    let text = text.strip_suffix('\n').unwrap_or(&text);
    #[cfg(windows)]
    let text = text.strip_suffix('\r').unwrap_or(text);
    let value = text
        .strip_prefix(prefix)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| AppError::msg("The worktree Git connection is invalid."))?;
    let path = Path::new(value);
    if path.is_absolute() {
        return absolute_path(file.parent().unwrap(), value);
    }
    let mut resolved = file.parent().unwrap().canonicalize()?;
    for part in path.components() {
        match part {
            std::path::Component::Normal(name) => resolved.push(name),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved = resolved.canonicalize()?;
                resolved.pop();
            }
            _ => return Err(AppError::msg("The Git connection path is invalid.")),
        }
    }
    Ok(resolved)
}

fn administrative_path(repo: &Repository, tree: &WorktreeInfo) -> AppResult<PathBuf> {
    let directory = repo.commondir().join("worktrees");
    let mut found = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Ok(link) = read_link(&entry.path().join("gitdir"), "") else {
            continue;
        };
        if same_folder(&tree.path, link.parent().unwrap_or(&link)) {
            if found.is_some() {
                return Err(AppError::msg(
                    "Worktree records are ambiguous. Repair the repository first.",
                ));
            }
            found = Some(entry.path());
        }
    }
    found.ok_or_else(|| AppError::msg("The worktree record is missing. Reload before continuing."))
}

fn repair_target(repo: &Repository, tree: &WorktreeInfo, destination: &Path) -> AppResult<()> {
    let administrative = administrative_path(repo, tree)?;
    let pointer = read_link(&destination.join(".git"), "gitdir: ")?;
    if pointer.exists() {
        if !same_folder(&pointer.to_string_lossy(), &administrative) {
            return Err(AppError::msg(
                "That folder belongs to another worktree or repository.",
            ));
        }
    } else {
        // When both directories moved, Git identifies the retained administrative
        // record by its worktrees/<id> suffix. Never adopt an existing foreign store.
        if pointer.file_name() != administrative.file_name()
            || pointer.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("worktrees"))
            || pointer
                .parent()
                .and_then(Path::parent)
                .is_some_and(Path::exists)
        {
            return Err(AppError::msg(
                "The folder does not match this worktree's retained Git record.",
            ));
        }
    }
    if !same_folder(
        &read_link(&administrative.join("commondir"), "")?.to_string_lossy(),
        repo.commondir(),
    ) {
        return Err(AppError::msg(
            "The administrative record belongs to another repository.",
        ));
    }
    Ok(())
}

pub fn preview_worktree_change(
    repo: &Repository,
    request: &WorktreeRequest,
) -> AppResult<WorktreePreview> {
    let trees = list_worktrees(repo)?;
    let mut hash = DefaultHasher::new();
    repo.workdir().hash(&mut hash);
    request.hash(&mut hash);
    trees.first().map(|tree| &tree.fingerprint).hash(&mut hash);
    let tree = if request.kind == WorktreeAction::RepairAll {
        None
    } else {
        let path = absolute_path(repo.workdir(), &request.path)?;
        Some(
            trees
                .iter()
                .find(|tree| same_folder(&tree.path, &path))
                .ok_or_else(|| AppError::msg("Choose a worktree from this repository."))?
                .clone(),
        )
    };
    let mut destination = String::new();
    match request.kind {
        WorktreeAction::Lock | WorktreeAction::Unlock => {
            let tree = tree.as_ref().unwrap();
            if tree.main {
                return Err(AppError::msg("The main worktree cannot be locked."));
            }
            if tree.locked == (request.kind == WorktreeAction::Lock) {
                return Err(AppError::msg(STALE));
            }
            if request.reason.len() > 4096 || request.reason.chars().any(char::is_control) {
                return Err(AppError::msg(
                    "Use a lock reason of at most 4096 bytes on one line.",
                ));
            }
        }
        WorktreeAction::Move => {
            let tree = tree.as_ref().unwrap();
            if tree.main || tree.current || tree.locked || tree.missing {
                return Err(AppError::msg(
                    "Choose an unlocked linked worktree outside the current tab.",
                ));
            }
            let source = Path::new(&tree.path);
            if fs::symlink_metadata(source)?.file_type().is_symlink() {
                return Err(AppError::msg(
                    "Move the worktree folder, not a symbolic link.",
                ));
            }
            let linked = open_at(source)?;
            if !same_folder(&linked.commondir().to_string_lossy(), repo.commondir()) {
                return Err(AppError::msg(
                    "The worktree folder now belongs to another repository.",
                ));
            }
            if !list_submodules(&linked)?.is_empty() {
                return Err(AppError::msg("Git cannot move a worktree containing submodules. Move it manually and repair its connection."));
            }
            let proposed = absolute_path(repo.workdir(), &request.destination)?;
            if fs::symlink_metadata(&proposed).is_ok()
                || trees.iter().any(|item| same_folder(&item.path, &proposed))
            {
                return Err(AppError::msg(
                    "Choose a new folder that does not already exist or belong to a worktree.",
                ));
            }
            let parent = proposed
                .parent()
                .filter(|parent| parent.is_dir())
                .ok_or_else(|| AppError::msg("The destination's parent folder must exist."))?
                .canonicalize()?;
            let name = proposed
                .file_name()
                .ok_or_else(|| AppError::msg("Choose a new folder name."))?;
            let target = parent.join(name);
            if target.starts_with(source.canonicalize()?)
                || target.starts_with(repo.commondir().canonicalize()?)
            {
                return Err(AppError::msg(
                    "Choose a destination outside the worktree and Git metadata.",
                ));
            }
            hash_directory(source, &mut hash)?;
            hash_directory(&parent, &mut hash)?;
            destination = strip_verbatim_prefix(&target.to_string_lossy());
        }
        WorktreeAction::Repair => {
            let tree = tree.as_ref().unwrap();
            if tree.main {
                return Err(AppError::msg(
                    "Use repair connections for the main worktree.",
                ));
            }
            let target = absolute_path(repo.workdir(), &request.destination)?.canonicalize()?;
            if tree.current && !same_folder(&tree.path, &target) {
                return Err(AppError::msg(
                    "Reconnect a copied worktree from another worktree tab.",
                ));
            }
            if !target.is_dir() {
                return Err(AppError::msg("Choose the relocated worktree folder."));
            }
            if trees.iter().any(|other| {
                !same_folder(&other.path, Path::new(&tree.path))
                    && same_folder(&other.path, &target)
            }) {
                return Err(AppError::msg(
                    "That folder is assigned to another worktree.",
                ));
            }
            repair_target(repo, tree, &target)?;
            hash_path(&target.join(".git"), &mut hash, true)?;
            hash_directory(&target, &mut hash)?;
            destination = strip_verbatim_prefix(&target.to_string_lossy());
        }
        WorktreeAction::RepairAll => {
            for tree in trees.iter().filter(|tree| !tree.main && !tree.missing) {
                repair_target(repo, tree, Path::new(&tree.path))?;
            }
        }
    }
    Ok(WorktreePreview {
        tree,
        destination,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn change_worktree(
    repo: &mut Repository,
    request: &WorktreeRequest,
    fingerprint: &str,
) -> AppResult<WorktreeChange> {
    let _lock = WorktreeLock::acquire(repo)?;
    let preview = preview_worktree_change(repo, request)?;
    if preview.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let path = preview
        .tree
        .as_ref()
        .map(|tree| tree.path.as_str())
        .unwrap_or("");
    let args = match request.kind {
        WorktreeAction::Lock => vec![
            "worktree",
            "lock",
            "--reason",
            request.reason.trim(),
            "--",
            path,
        ],
        WorktreeAction::Unlock => vec!["worktree", "unlock", "--", path],
        WorktreeAction::Move => vec!["worktree", "move", "--", path, &preview.destination],
        WorktreeAction::Repair => vec!["worktree", "repair", "--", &preview.destination],
        WorktreeAction::RepairAll => vec!["worktree", "repair"],
    };
    run_git_stdout(repo.workdir(), &args)?;
    let trees = list_worktrees(repo)?;
    let relocated = matches!(request.kind, WorktreeAction::Move | WorktreeAction::Repair);
    let target = if relocated {
        preview.destination.as_str()
    } else {
        path
    };
    match request.kind {
        WorktreeAction::Lock | WorktreeAction::Unlock => {
            let tree = trees
                .iter()
                .find(|tree| same_folder(&tree.path, Path::new(path)))
                .ok_or_else(|| {
                    AppError::msg("The worktree record disappeared. Reload the repository.")
                })?;
            if tree.locked != (request.kind == WorktreeAction::Lock)
                || (tree.locked
                    && tree.lock_reason.as_deref().unwrap_or("") != request.reason.trim())
            {
                return Err(AppError::msg(
                    "Git did not confirm the worktree lock change.",
                ));
            }
        }
        WorktreeAction::Move | WorktreeAction::Repair => {
            verify_connection(repo, target)?;
            if !trees
                .iter()
                .any(|tree| same_folder(&tree.path, Path::new(target)))
            {
                return Err(AppError::msg(
                    "Git did not reconnect the chosen worktree. Reload the repository.",
                ));
            }
        }
        WorktreeAction::RepairAll => {
            for tree in trees.iter().filter(|tree| !tree.main && !tree.missing) {
                verify_connection(repo, &tree.path)?;
            }
        }
    }
    Ok(WorktreeChange {
        previous_path: relocated.then(|| path.to_string()),
        path: relocated.then(|| target.to_string()),
        snapshot: snapshot(repo)?,
    })
}

fn verify_connection(repo: &Repository, target: &str) -> AppResult<()> {
    let linked = open_at(Path::new(target))?;
    if !same_folder(&linked.commondir().to_string_lossy(), repo.commondir())
        || !same_folder(target, linked.workdir())
    {
        return Err(AppError::msg(
            "The repaired worktree points to another repository.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
