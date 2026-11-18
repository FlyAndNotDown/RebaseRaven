//! Read-only previews and explicit selection for workspace reconciliation.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::Hash;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cli;
use super::parse::{parse_ztag, path_is_within, spec_field};
use super::scan_review::{
    review_file, selected_paths, verify_selection, workspace_fingerprint, FileApproval, Reviewed,
};
use super::workspace::{
    env_for, revision_file_spec, workspace_directory_path, workspace_file_spec, P4Connection,
};
use crate::error::{AppError, AppResult};

pub(super) const STALE: &str =
    "The operation or workspace changed. Preview it again before applying.";

pub(super) fn run(connection: &P4Connection, args: &[&str]) -> AppResult<String> {
    cli::run_p4_ok(&env_for(connection), args, None)
}

pub(super) fn allow_empty(result: AppResult<String>) -> AppResult<String> {
    result.or_else(|error| {
        let message = error.to_string().to_lowercase();
        if message.contains("no file(s)")
            || message.contains("no such file(s)")
            || message.contains("no files to reconcile")
        {
            Ok(String::new())
        } else {
            Err(error)
        }
    })
}

pub(super) fn pending_change(connection: &P4Connection, change: &str) -> AppResult<String> {
    if change == "default" {
        return Ok(change.to_string());
    }
    let id = number(change)?;
    let spec = run(connection, &["change", "-o", &id])?;
    if spec_field(&spec, "Status") != "pending"
        || spec_field(&spec, "User") != connection.user
        || spec_field(&spec, "Client") != connection.client
    {
        return Err(AppError::msg(
            "Choose your own pending changelist in this workspace.",
        ));
    }
    Ok(id)
}

pub(super) fn number(value: &str) -> AppResult<String> {
    value
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .ok_or_else(|| AppError::msg("Choose a numbered changelist."))
}

pub(super) fn hash_file(root: &str, path: &Path, hash: &mut DefaultHasher) -> AppResult<()> {
    crate::activity::check_cancelled()?;
    if !path.is_absolute() {
        return Err(AppError::msg("Choose a local workspace file."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::msg("Choose a local workspace file."))?;
    // Deleted files may have deleted parent directories. Check their nearest existing ancestor.
    let ancestor = parent
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| AppError::msg("Path is outside the workspace."))?;
    workspace_directory_path(Path::new(root), ancestor.to_path_buf())?;
    path.hash(hash);
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => {
            meta.len().hash(hash);
            meta.modified()?.hash(hash);
            meta.permissions().readonly().hash(hash);
            let mut file = fs::File::open(path)?;
            let mut buffer = [0u8; 65_536];
            loop {
                crate::activity::check_cancelled()?;
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                buffer[..count].hash(hash);
            }
        }
        Ok(_) => return Err(AppError::msg("Choose a regular workspace file.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false.hash(hash),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ReconcileFile {
    pub path: String,
    pub depot_path: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ReconcilePreview {
    pub files: Vec<Reviewed<P4ReconcileFile>>,
    pub fingerprint: String,
}

/// Validate every folder before starting a scan. A parent already covers its descendants.
pub(super) fn scan_folders(
    connection: &P4Connection,
    scopes: &[String],
) -> AppResult<Vec<PathBuf>> {
    if scopes.is_empty() {
        return Err(AppError::msg("Choose at least one workspace folder."));
    }
    let mut folders: Vec<PathBuf> = Vec::new();
    for scope in scopes {
        crate::activity::check_cancelled()?;
        let directory = PathBuf::from(scope);
        if !directory.is_absolute()
            || scope.contains("...")
            || scope.chars().any(char::is_control)
            || directory
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            return Err(AppError::msg(
                "Choose a local workspace folder without wildcards or control characters.",
            ));
        }
        let dir = workspace_directory_path(Path::new(&connection.root), directory)?;
        if !folders.iter().any(|parent| path_is_within(parent, &dir)) {
            folders.retain(|child| !path_is_within(&dir, child));
            folders.push(dir);
        }
    }
    folders.sort();
    Ok(folders)
}

pub(super) fn scan_folder(
    connection: &P4Connection,
    folder: &Path,
    args: &[&str],
) -> AppResult<String> {
    crate::activity::check_cancelled()?;
    let spec = revision_file_spec(&connection.root, &folder.to_string_lossy(), true, "")?;
    let mut args = args.to_vec();
    args.push(&spec);
    let mut env = env_for(connection);
    env.cwd = folder.to_owned();
    cli::run_p4_ok(&env, &args, None)
}

pub fn preview_reconcile(
    connection: &P4Connection,
    scopes: &[String],
    mut on_folder: impl FnMut(&Path),
) -> AppResult<P4ReconcilePreview> {
    let folders = scan_folders(connection, scopes)?;
    let mut files = Vec::new();
    for dir in &folders {
        on_folder(dir);
        let output = allow_empty(scan_folder(connection, dir, &RECONCILE_PREVIEW))?;
        files.extend(review_reconcile_output(connection, dir, &output)?);
    }
    let fingerprint = if files.is_empty() {
        String::new()
    } else {
        workspace_fingerprint(connection, ("reconcile", &folders))?
    };
    Ok(P4ReconcilePreview { files, fingerprint })
}

const RECONCILE_PREVIEW: [&str; 6] = ["-ztag", "reconcile", "-n", "-e", "-a", "-d"];

fn review_reconcile_output(
    connection: &P4Connection,
    scope: &Path,
    output: &str,
) -> AppResult<Vec<Reviewed<P4ReconcileFile>>> {
    let mut files = Vec::new();
    for record in parse_ztag(output) {
        let get = |name: &str| record.get(name).cloned().unwrap_or_default();
        let action = get("action");
        if !matches!(action.as_str(), "add" | "edit" | "delete") {
            continue;
        }
        let path = get("clientFile");
        if !path_is_within(scope, Path::new(&path)) {
            return Err(AppError::msg(
                "P4 returned a file outside the selected workspace folder.",
            ));
        }
        let file = P4ReconcileFile {
            path: path.clone(),
            depot_path: get("depotFile"),
            action,
        };
        files.push(review_file(connection, &path, file, &record)?);
    }
    Ok(files)
}

pub fn apply_reconcile(
    connection: &P4Connection,
    files: &[FileApproval],
    change: &str,
    fingerprint: &str,
    scopes: &[String],
) -> AppResult<String> {
    let folders = scan_folders(connection, scopes)?;
    let paths = selected_paths(files, &folders)?;
    let change = pending_change(connection, change)?;
    if workspace_fingerprint(connection, ("reconcile", &folders))? != fingerprint {
        return Err(AppError::StaleReview(STALE));
    }
    let specs: Vec<_> = paths
        .iter()
        .map(|path| workspace_file_spec(&connection.root, path))
        .collect();
    let preview = RECONCILE_PREVIEW.map(str::to_owned);
    let output = allow_empty(run_files(connection, &preview, &specs))?;
    let reviewed = review_reconcile_output(connection, Path::new(&connection.root), &output)?;
    verify_selection(
        files,
        reviewed
            .iter()
            .map(|item| (&item.file.path, &item.fingerprint)),
    )?;
    let args = vec![
        "reconcile".to_string(),
        "-e".into(),
        "-a".into(),
        "-d".into(),
        "-c".into(),
        change,
    ];
    run_files(connection, &args, &specs)
}

pub(super) fn run_files(
    connection: &P4Connection,
    args: &[String],
    paths: &[String],
) -> AppResult<String> {
    let mut list = tempfile::NamedTempFile::new()?;
    for path in paths {
        if path.contains("...") || path.chars().any(char::is_control) {
            return Err(AppError::msg(
                "Choose a workspace file without wildcards or control characters.",
            ));
        }
        writeln!(list, "{path}")?;
    }
    list.flush()?;
    let list = list.into_temp_path();
    let file = list
        .to_str()
        .ok_or_else(|| AppError::msg("Cleanup requires a UTF-8 temporary file path."))?;
    let mut refs = vec!["-x", file];
    refs.extend(args.iter().map(String::as_str));
    cli::run_p4_ok(&env_for(connection), &refs, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(root: &Path) -> P4Connection {
        P4Connection {
            root: root.to_string_lossy().into_owned(),
            port: String::new(),
            user: String::new(),
            client: "example".into(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        }
    }

    #[test]
    fn directory_reconcile_limits_the_recursive_spec_and_escapes_local_names() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("folder #@% name");
        fs::create_dir(&directory).unwrap();
        let connection = connection(root.path());
        let nested = directory.join("nested");
        fs::create_dir(&nested).unwrap();
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        let paths =
            [&nested, &other, &directory, &other].map(|path| path.to_string_lossy().into_owned());
        let folders = scan_folders(&connection, &paths).unwrap();
        assert_eq!(folders, [directory.clone(), other]);
        let spec =
            revision_file_spec(&connection.root, directory.to_str().unwrap(), true, "").unwrap();
        assert!(spec.ends_with(if cfg!(windows) {
            r"folder %23%40%25 name\..."
        } else {
            "folder %23%40%25 name/..."
        }));
        assert!(scan_folders(&connection, &[]).is_err());
    }

    #[test]
    fn cancelling_a_folder_scan_stops_before_starting_another_command() {
        let root = tempfile::tempdir().unwrap();
        let conn = connection(root.path());
        let scopes = ["first", "second"].map(|name| {
            let path = root.path().join(name);
            fs::create_dir(&path).unwrap();
            path.to_string_lossy().into_owned()
        });
        for clean in [false, true] {
            let mut visited = 0;
            let id = "review-cancellation-test";
            let result = crate::activity::with_cancel(Some(id), || {
                let mut stop = |_: &Path| {
                    visited += 1;
                    assert!(crate::activity::cancel_activity(id));
                };
                if clean {
                    let request = super::super::clean::P4CleanRequest {
                        scopes: scopes.to_vec(),
                        restore_modified: true,
                        restore_missing: true,
                        remove_untracked: true,
                        include_ignored: false,
                    };
                    super::super::clean::preview_clean(&conn, &request, &mut stop).map(|_| ())
                } else {
                    preview_reconcile(&conn, &scopes, &mut stop).map(|_| ())
                }
            });
            assert!(result.unwrap_err().is_cancelled());
            assert_eq!(visited, 1);
        }
    }

    #[test]
    fn directory_reconcile_rejects_nonlocal_missing_and_escaping_scopes() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let connection = connection(root.path());
        for scope in [
            "relative",
            "//example/...",
            outside.path().to_str().unwrap(),
            root.path().join("missing").to_str().unwrap(),
            root.path().join("a...b").to_str().unwrap(),
        ] {
            assert!(scan_folders(&connection, &[scope.to_owned()]).is_err());
        }
        #[cfg(unix)]
        {
            let link = root.path().join("outside");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert!(scan_folders(&connection, &[link.to_string_lossy().into_owned()]).is_err());
        }
    }
}
