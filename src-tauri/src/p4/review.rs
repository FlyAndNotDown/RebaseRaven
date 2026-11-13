//! Read-only previews and explicit selection for workspace reconciliation.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cli;
use super::parse::{parse_ztag, path_is_within, spec_field};
use super::workspace::{env_for, workspace_directory_path, workspace_file_spec, P4Connection};
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
    pub files: Vec<P4ReconcileFile>,
    pub fingerprint: String,
}

fn reconcile_scope(connection: &P4Connection, scope: Option<&str>) -> AppResult<String> {
    let Some(scope) = scope else {
        return Ok(format!("//{}/...", connection.client));
    };
    let directory = PathBuf::from(scope);
    if !directory.is_absolute() || scope.contains("...") || scope.chars().any(char::is_control) {
        return Err(AppError::msg(
            "Choose a local workspace folder without wildcards or control characters.",
        ));
    }
    let directory = workspace_directory_path(Path::new(&connection.root), directory)?;
    let spec = workspace_file_spec(&connection.root, &directory.to_string_lossy());
    Ok(format!("{}/...", spec.trim_end_matches(['/', '\\'])))
}

pub fn preview_reconcile(
    connection: &P4Connection,
    scope: Option<&str>,
) -> AppResult<P4ReconcilePreview> {
    let spec = reconcile_scope(connection, scope)?;
    let output = allow_empty(run(
        connection,
        &["-ztag", "reconcile", "-n", "-e", "-a", "-d", &spec],
    ))?;
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.root,
        &connection.charset,
        &spec,
        &output,
    )
        .hash(&mut hash);
    let mut files = Vec::new();
    for record in parse_ztag(&output) {
        let get = |name: &str| record.get(name).cloned().unwrap_or_default();
        let action = get("action");
        if !matches!(action.as_str(), "add" | "edit" | "delete") {
            continue;
        }
        let path = get("clientFile");
        if !path_is_within(
            Path::new(scope.unwrap_or(&connection.root)),
            Path::new(&path),
        ) {
            return Err(AppError::msg(
                "P4 returned a file outside the selected workspace folder.",
            ));
        }
        hash_file(&connection.root, &PathBuf::from(&path), &mut hash)?;
        files.push(P4ReconcileFile {
            path,
            depot_path: get("depotFile"),
            action,
        });
    }
    Ok(P4ReconcilePreview {
        files,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn apply_reconcile(
    connection: &P4Connection,
    paths: &[String],
    change: &str,
    fingerprint: &str,
    scope: Option<&str>,
) -> AppResult<String> {
    if paths.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let change = pending_change(connection, change)?;
    let preview = preview_reconcile(connection, scope)?;
    if preview.fingerprint != fingerprint
        || paths
            .iter()
            .any(|path| !preview.files.iter().any(|file| &file.path == path))
    {
        return Err(AppError::msg(STALE));
    }
    let mut args = vec![
        "reconcile".to_string(),
        "-e".into(),
        "-a".into(),
        "-d".into(),
        "-c".into(),
        change,
    ];
    args.extend(
        paths
            .iter()
            .map(|path| workspace_file_spec(&connection.root, path)),
    );
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    run(connection, &refs)
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
        assert_eq!(reconcile_scope(&connection, None).unwrap(), "//example/...");
        assert_eq!(
            reconcile_scope(&connection, directory.to_str()).unwrap(),
            format!(
                "{}/...",
                root.path().join("folder %23%40%25 name").display()
            )
        );
        let nested = root.path().join("folder #@% name").join("nested");
        fs::create_dir(&nested).unwrap();
        assert_eq!(
            reconcile_scope(&connection, nested.to_str()).unwrap(),
            format!(
                "{}/...",
                root.path()
                    .join("folder %23%40%25 name")
                    .join("nested")
                    .display()
            )
        );
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
            assert!(reconcile_scope(&connection, Some(scope)).is_err());
        }
        #[cfg(unix)]
        {
            let link = root.path().join("outside");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert!(reconcile_scope(&connection, link.to_str()).is_err());
        }
    }
}
