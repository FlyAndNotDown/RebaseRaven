//! Stream switching separates read-only scope inspection from shelving and sync.
use super::client::{block, stable_spec};
use super::history::exact_depot;
use super::parse::{parse_ztag, spec_field};
use super::review::{allow_empty, hash_file, preview_reconcile, run, STALE};
use super::workspace::{
    connection_after_create, env_for, new_change, reopen, workspace_directory_path,
    workspace_file_spec, P4Connection,
};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, BTreeMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SwitchRequest {
    pub target: String,
    pub shelve: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SwitchFile {
    pub path: String,
    pub depot_path: String,
    pub action: String,
    pub change: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SwitchPreview {
    pub current: String,
    pub target: String,
    pub view: Vec<String>,
    pub limit_view: Vec<String>,
    pub changes: Vec<P4SwitchFile>,
    pub unresolved: bool,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SwitchOutcome {
    pub connection: P4Connection,
    pub source: String,
    pub target: String,
    pub stage: String,
    pub backup_shelf: Option<String>,
    pub output: String,
}

fn local_changes(connection: &P4Connection) -> AppResult<Vec<P4SwitchFile>> {
    let scope = format!("//{}/...", connection.client);
    let output = allow_empty(run(
        connection,
        &[
            "-ztag",
            "fstat",
            "-Ro",
            "-T",
            "depotFile,clientFile,action,change",
            &scope,
        ],
    ))?;
    let mut files = BTreeMap::new();
    for record in parse_ztag(&output) {
        let get = |key| record.get(key).cloned().unwrap_or_default();
        let path = get("clientFile");
        if !path.is_empty() {
            files.insert(
                path.clone(),
                P4SwitchFile {
                    path,
                    depot_path: get("depotFile"),
                    action: get("action"),
                    change: Some(get("change")),
                },
            );
        }
    }
    for file in preview_reconcile(connection)?.files {
        files.entry(file.path.clone()).or_insert(P4SwitchFile {
            path: file.path,
            depot_path: file.depot_path,
            action: file.action,
            change: None,
        });
    }
    Ok(files.into_values().collect())
}

fn target_view(connection: &P4Connection, target: &str) -> AppResult<Vec<String>> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!("rebaseraven-preview-{}-{nonce}", std::process::id());
    // -o for a new name generates a form without creating a server-side client.
    let spec = run(connection, &["client", "-S", target, "-o", &name])?;
    let from = format!("//{name}/");
    let to = format!("//{}/", connection.client);
    Ok(block(&spec, "View")
        .iter()
        .map(|line| line.replace(&from, &to))
        .collect())
}

pub fn preview_switch(
    connection: &P4Connection,
    request: &P4SwitchRequest,
) -> AppResult<P4SwitchPreview> {
    exact_depot(&request.target)?;
    let client = run(connection, &["client", "-o", &connection.client])?;
    let current = spec_field(&client, "Stream");
    if current.is_empty()
        || connection.stream.as_deref() != Some(current.as_str())
        || !spec_field(&client, "StreamAtChange").is_empty()
    {
        return Err(AppError::msg(
            "Refresh and choose a writable stream workspace.",
        ));
    }
    if current == request.target {
        return Err(AppError::msg("Choose a different stream."));
    }
    let target = run(connection, &["stream", "-o", &request.target])?;
    let view = target_view(connection, &request.target)?;
    let changes = local_changes(connection)?;
    let scope = format!("//{}/...", connection.client);
    let unresolved = !parse_ztag(&allow_empty(run(
        connection,
        &["-ztag", "fstat", "-Ru", "-T", "depotFile", &scope],
    ))?)
    .is_empty();
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.root,
        &request.target,
        request.shelve,
        stable_spec(&client),
        stable_spec(&target),
        &view,
        unresolved,
    )
        .hash(&mut hash);
    for file in &changes {
        (&file.path, &file.depot_path, &file.action, &file.change).hash(&mut hash);
        hash_file(&connection.root, Path::new(&file.path), &mut hash)?;
    }
    Ok(P4SwitchPreview {
        current,
        target: request.target.clone(),
        view,
        limit_view: block(&client, "LimitView"),
        changes,
        unresolved,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn contents(connection: &P4Connection, files: &[P4SwitchFile]) -> AppResult<u64> {
    let mut hash = DefaultHasher::new();
    for file in files {
        let path = Path::new(&file.path);
        let parent = path
            .parent()
            .and_then(|parent| parent.ancestors().find(|p| p.exists()))
            .ok_or_else(|| AppError::msg("Path is outside the workspace."))?;
        workspace_directory_path(Path::new(&connection.root), parent.to_path_buf())?;
        path.hash(&mut hash);
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => {
                let mut reader = fs::File::open(path)?;
                let mut bytes = [0u8; 65536];
                loop {
                    let count = reader.read(&mut bytes)?;
                    if count == 0 {
                        break;
                    }
                    hash.write(&bytes[..count]);
                }
            }
            Ok(_) => return Err(AppError::msg("Choose a regular workspace file.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false.hash(&mut hash),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(hash.finish())
}

fn save_changes(connection: &P4Connection, files: &[P4SwitchFile], shelf: &str) -> AppResult<()> {
    let before = contents(connection, files)?;
    let opened = files
        .iter()
        .filter(|file| file.change.is_some())
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    reopen(connection, shelf, &opened)?;
    let offline = files
        .iter()
        .filter(|file| file.change.is_none())
        .map(|file| workspace_file_spec(&connection.root, &file.path))
        .collect::<Vec<_>>();
    if !offline.is_empty() {
        let mut args = vec!["reconcile", "-e", "-a", "-d", "-c", shelf];
        args.extend(offline.iter().map(String::as_str));
        run(connection, &args)?;
    }
    run(connection, &["shelve", "-c", shelf])?;
    let saved = super::shelves::shelf_detail(connection, shelf)?;
    if saved.files.len() != files.len()
        || files.iter().any(|file| {
            !saved
                .files
                .iter()
                .any(|saved| saved.depot_path == file.depot_path)
        })
        || contents(connection, files)? != before
    {
        return Err(AppError::msg(STALE));
    }
    let paths = files
        .iter()
        .map(|file| workspace_file_spec(&connection.root, &file.path))
        .collect::<Vec<_>>();
    let mut args = vec!["revert", "-w", "-c", shelf];
    args.extend(paths.iter().map(String::as_str));
    run(connection, &args)?;
    Ok(())
}

pub fn apply_switch(
    connection: &P4Connection,
    request: &P4SwitchRequest,
    fingerprint: &str,
) -> AppResult<P4SwitchOutcome> {
    let preview = preview_switch(connection, request)?;
    if preview.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    if preview.unresolved {
        return Err(AppError::msg(
            "Resolve pending integrations before switching streams.",
        ));
    }
    if !preview.changes.is_empty() && !request.shelve {
        return Err(AppError::msg(
            "Shelve local changes or finish them before switching streams.",
        ));
    }
    let mut stage = "switch";
    let mut backup = None;
    let operation = (|| -> AppResult<String> {
        if !preview.changes.is_empty() {
            stage = "shelve";
            let mut description = format!(
                "Workspace changes before switching from {} to {}",
                preview.current, preview.target
            );
            for file in &preview.changes {
                description.push_str(&format!(
                    "\n{}: {}",
                    file.change.as_deref().unwrap_or("offline"),
                    file.depot_path
                ));
            }
            let id = new_change(connection, &description)?;
            backup = Some(id.clone());
            save_changes(connection, &preview.changes, &id)?;
        }
        if !local_changes(connection)?.is_empty() {
            return Err(AppError::msg(STALE));
        }
        stage = "switch";
        run(
            connection,
            &["client", "-s", "-S", &request.target, &connection.client],
        )?;
        stage = "sync";
        let scope = format!("//{}/...", connection.client);
        let output = allow_empty(run(connection, &["sync", "-s", "-q", &scope]))?;
        let remaining = allow_empty(run(connection, &["-ztag", "sync", "-n", &scope]))?;
        if parse_ztag(&remaining)
            .iter()
            .any(|record| record.contains_key("depotFile"))
        {
            return Err(AppError::msg(if output.trim().is_empty() {
                "The workspace is not fully synced. Use Get latest to finish.".to_string()
            } else {
                output
            }));
        }
        stage = "done";
        Ok(output)
    })();
    let stream = run(connection, &["client", "-o", &connection.client])
        .map(|spec| spec_field(&spec, "Stream"))
        .unwrap_or(preview.current.clone());
    let next = connection_after_create(&env_for(connection), Path::new(&connection.root), &stream)
        .unwrap_or_else(|_| connection.clone());
    Ok(P4SwitchOutcome {
        connection: next,
        source: preview.current,
        target: preview.target,
        stage: stage.into(),
        backup_shelf: backup,
        output: operation.unwrap_or_else(|error| error.to_string()),
    })
}
