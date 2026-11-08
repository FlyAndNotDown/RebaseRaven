//! Explicit workspace cleanup, bound to a reviewed set of individual files.
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::cli;
use super::client::stable_spec;
use super::parse::{parse_ztag, path_is_within};
use super::review::{hash_file, run, STALE};
use super::workspace::{env_for, workspace_directory_path, workspace_file_spec, P4Connection};
use crate::error::{AppError, AppResult};

const LIMIT: usize = 2000;

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct P4CleanRequest {
    pub scope: String,
    pub restore_modified: bool,
    pub restore_missing: bool,
    pub remove_untracked: bool,
    pub include_ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CleanFile {
    pub path: String,
    pub depot_path: String,
    pub action: String,
    pub revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CleanPreview {
    pub files: Vec<P4CleanFile>,
    pub fingerprint: String,
}

fn arguments(request: &P4CleanRequest, preview: bool) -> AppResult<Vec<String>> {
    if !request.restore_modified && !request.restore_missing && !request.remove_untracked {
        return Err(AppError::msg("Choose at least one cleanup action."));
    }
    let mut args = vec!["-ztag".into(), "clean".into()];
    if preview {
        args.push("-n".into());
    }
    if request.restore_modified {
        args.push("-e".into());
    }
    if request.restore_missing {
        args.push("-d".into());
    }
    if request.remove_untracked {
        args.push("-a".into());
    }
    if request.include_ignored {
        args.push("-I".into());
    }
    Ok(args)
}

fn local_path(value: &str) -> AppResult<&Path> {
    if value.contains("...") || value.contains('*') || value.chars().any(char::is_control) {
        return Err(AppError::msg(
            "Cleanup requires file and folder names without wildcards or control characters.",
        ));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(AppError::msg("Choose a local workspace folder."));
    }
    Ok(path)
}

fn files(scope: &Path, output: &str) -> AppResult<Vec<P4CleanFile>> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for record in parse_ztag(output) {
        let action = record.get("action").map(String::as_str).unwrap_or_default();
        let path = record.get("clientFile").cloned().unwrap_or_default();
        if path.is_empty() || !matches!(action, "refreshed" | "deleted") {
            return Err(AppError::msg(
                "P4 returned an unsupported cleanup result. No files were changed.",
            ));
        }
        let local = local_path(&path)?;
        if !path_is_within(scope, local) || !seen.insert(path.clone()) {
            return Err(AppError::msg(
                "P4 returned an unexpected cleanup path. No files were changed.",
            ));
        }
        let exists = match fs::symlink_metadata(local) {
            Ok(meta) if meta.file_type().is_file() => true,
            Ok(_) => {
                return Err(AppError::msg(
                    "Cleanup supports regular workspace files only.",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        let revision = record
            .get("rev")
            .filter(|value| value.parse::<u64>().is_ok_and(|n| n > 0))
            .cloned();
        let action = if action == "deleted" {
            if !exists || revision.is_some() {
                return Err(AppError::msg(STALE));
            }
            "removeUntracked"
        } else {
            if revision.is_none() {
                return Err(AppError::msg(
                    "P4 did not return the cleanup base revision.",
                ));
            }
            if exists {
                "restoreModified"
            } else {
                "restoreMissing"
            }
        };
        files.push(P4CleanFile {
            path,
            depot_path: record.get("depotFile").cloned().unwrap_or_default(),
            action: action.into(),
            revision,
        });
        if files.len() > LIMIT {
            return Err(AppError::msg("Cleanup preview exceeds 2000 files. Choose a smaller folder or fewer cleanup actions."));
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn run_files(connection: &P4Connection, args: &[String], paths: &[String]) -> AppResult<String> {
    let mut list = tempfile::NamedTempFile::new()?;
    for path in paths {
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

pub fn preview_clean(
    connection: &P4Connection,
    request: &P4CleanRequest,
) -> AppResult<P4CleanPreview> {
    let mut args = arguments(request, true)?;
    let scope = workspace_directory_path(
        Path::new(&connection.root),
        local_path(&request.scope)?.to_path_buf(),
    )?;
    // Wildcard folder scopes need P4 escaping; individual clean operands use local literals.
    let spec = workspace_file_spec(&connection.root, &scope.to_string_lossy());
    args.push(format!("{}/...", spec.trim_end_matches(['/', '\\'])));
    let output = run(
        connection,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    let files = files(&scope, &output)?;
    let client = run(connection, &["client", "-o", &connection.client])?;
    let mut hash = DefaultHasher::new();
    (
        &connection.root,
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.charset,
        request,
        stable_spec(&client),
        &output,
    )
        .hash(&mut hash);
    for file in &files {
        hash_file(&connection.root, Path::new(&file.path), &mut hash)?;
    }
    let tracked: Vec<_> = files
        .iter()
        .filter(|file| file.revision.is_some())
        .map(|file| workspace_file_spec(&connection.root, &file.path))
        .collect();
    if !tracked.is_empty() {
        let args = vec![
            "-ztag".to_string(),
            "fstat".into(),
            "-T".into(),
            "depotFile,clientFile,haveRev,action,change".into(),
        ];
        run_files(connection, &args, &tracked)?.hash(&mut hash);
    }
    Ok(P4CleanPreview {
        files,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn apply_clean(
    connection: &P4Connection,
    request: &P4CleanRequest,
    paths: &[String],
    fingerprint: &str,
) -> AppResult<String> {
    if paths.is_empty()
        || paths.len() > LIMIT
        || paths.iter().collect::<HashSet<_>>().len() != paths.len()
    {
        return Err(AppError::msg("Choose each cleanup file at most once."));
    }
    let preview = preview_clean(connection, request)?;
    if preview.fingerprint != fingerprint
        || paths
            .iter()
            .any(|path| !preview.files.iter().any(|file| &file.path == path))
    {
        return Err(AppError::msg(STALE));
    }
    // Never rerun a recursive scope when applying: unreviewed new files stay untouched.
    let output = run_files(connection, &arguments(request, false)?, paths)?;
    let verify = P4CleanRequest {
        restore_modified: true,
        restore_missing: true,
        remove_untracked: true,
        include_ignored: true,
        ..request.clone()
    };
    let remaining = run_files(connection, &arguments(&verify, true)?, paths)?;
    let incomplete = || {
        AppError::msg("Some selected files could not be cleaned. Preview the remaining changes.")
    };
    if !files(Path::new(&connection.root), &remaining)?.is_empty() {
        return Err(incomplete());
    }
    let mut tracked = Vec::new();
    for path in paths {
        let file = preview
            .files
            .iter()
            .find(|file| &file.path == path)
            .ok_or_else(incomplete)?;
        let metadata = fs::symlink_metadata(path);
        if file.action == "removeUntracked" {
            if !metadata.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
                return Err(incomplete());
            }
        } else {
            if !metadata.is_ok_and(|meta| meta.file_type().is_file()) {
                return Err(incomplete());
            }
            tracked.push(file);
        }
    }
    if !tracked.is_empty() {
        let specs = tracked
            .iter()
            .map(|file| workspace_file_spec(&connection.root, &file.path))
            .collect::<Vec<_>>();
        let records = parse_ztag(&run_files(
            connection,
            &[
                "-ztag".into(),
                "fstat".into(),
                "-T".into(),
                "depotFile,haveRev,action".into(),
            ],
            &specs,
        )?);
        for file in tracked {
            if !records.iter().any(|record| {
                record.get("depotFile") == Some(&file.depot_path)
                    && record.get("haveRev") == file.revision.as_ref()
                    && record.get("action").is_none_or(String::is_empty)
            }) {
                return Err(incomplete());
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(scope: &Path) -> P4CleanRequest {
        P4CleanRequest {
            scope: scope.to_string_lossy().into_owned(),
            restore_modified: true,
            restore_missing: true,
            remove_untracked: true,
            include_ignored: false,
        }
    }

    #[test]
    fn preview_uses_only_explicit_native_clean_flags_and_respects_ignores_by_default() {
        let mut request = request(Path::new("/work"));
        assert_eq!(
            arguments(&request, true).unwrap(),
            ["-ztag", "clean", "-n", "-e", "-d", "-a"]
        );
        request.include_ignored = true;
        request.restore_modified = false;
        request.remove_untracked = false;
        assert_eq!(
            arguments(&request, false).unwrap(),
            ["-ztag", "clean", "-d", "-I"]
        );
        request.restore_missing = false;
        assert!(arguments(&request, true).is_err());
        assert!(local_path("relative").is_err());
        assert!(local_path("/work/a...b").is_err());
    }

    #[test]
    fn native_clean_records_distinguish_missing_modified_and_untracked_files() {
        let root = tempfile::tempdir().unwrap();
        let modified = root.path().join("modified.txt");
        let missing = root.path().join("missing.txt");
        let untracked = root.path().join("space #@%.txt");
        fs::write(&modified, "modified").unwrap();
        fs::write(&untracked, "untracked").unwrap();
        let output=format!("... depotFile //depot/modified.txt\n... clientFile {}\n... rev 4\n... action refreshed\n\n... depotFile //depot/missing.txt\n... clientFile {}\n... rev 2\n... action refreshed\n\n... depotFile //depot/space%20%23%40%25.txt\n... clientFile {}\n... rev none\n... action deleted\n",modified.display(),missing.display(),untracked.display());
        let files = files(root.path(), &output).unwrap();
        assert_eq!(files.len(), 3);
        assert!(files
            .iter()
            .any(|file| file.action == "restoreMissing" && file.revision.as_deref() == Some("2")));
        assert!(files.iter().any(|file| file.action == "restoreModified"));
        assert!(files.iter().any(
            |file| file.action == "removeUntracked" && file.path == untracked.to_string_lossy()
        ));
        assert_eq!(fs::read_to_string(modified).unwrap(), "modified");
        assert_eq!(fs::read_to_string(untracked).unwrap(), "untracked");
        assert!(!missing.exists());
    }

    #[test]
    fn unexpected_paths_actions_and_non_regular_files_are_rejected_before_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        for output in [
            format!(
                "... clientFile {}\n... rev none\n... action deleted\n",
                outside.path().display()
            ),
            format!(
                "... clientFile {}\n... rev none\n... action deleted\n",
                root.path().display()
            ),
            "... action unknown\n".into(),
        ] {
            assert!(files(root.path(), &output).is_err());
        }
        let file = root.path().join("duplicate.txt");
        fs::write(&file, "keep").unwrap();
        let record = format!(
            "... clientFile {}\n... rev none\n... action deleted\n\n",
            file.display()
        );
        assert!(files(root.path(), &record.repeat(2)).is_err());
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            let output = format!(
                "... clientFile {}\n... rev none\n... action deleted\n",
                link.display()
            );
            assert!(files(root.path(), &output).is_err());
        }
    }
}
