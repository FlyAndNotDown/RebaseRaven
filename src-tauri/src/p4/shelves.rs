//! Server-wide shelf discovery and previewed restoration into a workspace.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::Deserialize;

use super::operations::P4OperationPreview;
use super::parse::{indexed_groups, parse_ztag, valid_depot_path};
use super::review::{allow_empty, hash_file, number, pending_change, run, STALE};
use super::workspace::{
    change_from_record, files_from_groups, P4ChangePage, P4Changelist, P4Connection,
};
use crate::error::{AppError, AppResult};

pub fn list_shelves(
    connection: &P4Connection,
    user: &str,
    before: Option<u64>,
) -> AppResult<P4ChangePage> {
    let mut args = vec![
        "-ztag".to_string(),
        "changes".into(),
        "-s".into(),
        "shelved".into(),
        "-L".into(),
        "-m".into(),
        "51".into(),
    ];
    if !user.trim().is_empty() {
        if user.starts_with('-') || user.chars().any(char::is_whitespace) {
            return Err(AppError::msg("Choose a Perforce user name."));
        }
        args.extend(["-u".into(), user.trim().to_string()]);
    }
    if let Some(before) = before {
        if before <= 1 {
            return Ok(P4ChangePage {
                changes: Vec::new(),
                has_more: false,
                scanned_through: None,
            });
        }
        args.push(format!("//...@1,{}", before - 1));
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = allow_empty(run(connection, &refs))?;
    let mut changes = parse_ztag(&output)
        .iter()
        .filter(|record| record.contains_key("change"))
        .map(|record| change_from_record(record, Vec::new(), true))
        .collect::<Vec<_>>();
    let has_more = changes.len() > 50;
    changes.truncate(50);
    let scanned_through = changes.last().and_then(|change| change.id.parse().ok());
    Ok(P4ChangePage {
        changes,
        has_more,
        scanned_through,
    })
}

fn shelf_record(connection: &P4Connection, change: &str) -> AppResult<(String, P4Changelist)> {
    let id = number(change)?;
    let output = run(connection, &["-ztag", "describe", "-S", "-s", &id])?;
    let record = parse_ztag(&output).into_iter().next().unwrap_or_default();
    let files = files_from_groups(connection, &indexed_groups(&record), true);
    if files.is_empty() {
        return Err(AppError::msg("This changelist has no shelved files."));
    }
    Ok((output, change_from_record(&record, files, true)))
}

pub fn shelf_detail(connection: &P4Connection, change: &str) -> AppResult<P4Changelist> {
    shelf_record(connection, change).map(|(_, detail)| detail)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4UnshelveRequest {
    pub change_id: String,
    pub target: String,
    pub files: Vec<String>,
    pub stream: String,
}

fn unshelve_args(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
) -> AppResult<(Vec<String>, String)> {
    let (shelf, detail) = shelf_record(connection, &request.change_id)?;
    let target = pending_change(connection, &request.target)?;
    if request.files.is_empty()
        || request
            .files
            .iter()
            .any(|path| !detail.files.iter().any(|file| &file.depot_path == path))
    {
        return Err(AppError::msg("Choose files from this shelf."));
    }
    let mut args = vec![
        "unshelve".into(),
        "-Af".into(),
        "-s".into(),
        number(&request.change_id)?,
        "-c".into(),
        target,
    ];
    if !request.stream.is_empty() {
        if !request.stream.starts_with("//")
            || !valid_depot_path(&request.stream)
            || request.stream.contains(['#', '@', '*'])
            || request.stream.contains("...")
        {
            return Err(AppError::msg("Choose a related source stream."));
        }
        if request.files.len() != detail.files.len() {
            return Err(AppError::msg(
                "Stream mapping restores the entire shelf. Select all files.",
            ));
        }
        args.extend(["-S".into(), request.stream.clone()]);
    } else {
        args.extend(request.files.clone());
    }
    Ok((args, shelf))
}

pub fn preview_unshelve(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
) -> AppResult<P4OperationPreview> {
    let (args, shelf) = unshelve_args(connection, request)?;
    let refs = args
        .iter()
        .map(String::as_str)
        .chain(std::iter::once("-n"))
        .collect::<Vec<_>>();
    let output = run(connection, &refs)?;
    let mut hash = DefaultHasher::new();
    (
        &connection.root,
        &connection.port,
        &connection.user,
        &connection.client,
        &args,
        &shelf,
        &output,
    )
        .hash(&mut hash);
    let scope = format!("//{}/...", connection.client);
    allow_empty(run(connection, &["-ztag", "opened", &scope]))?.hash(&mut hash);
    let mut targets = std::collections::BTreeSet::new();
    if request.stream.is_empty() {
        targets.extend(request.files.clone());
    }
    for line in output.lines() {
        if let Some((path, _)) = line.trim().split_once(" - ") {
            let path = path.split('#').next().unwrap_or(path);
            if path.starts_with("//") && valid_depot_path(path) {
                targets.insert(path.to_string());
            }
        }
    }
    if targets.is_empty() {
        return Err(AppError::msg(
            "No files can be restored into this workspace.",
        ));
    }
    for target in targets {
        let mapping = run(connection, &["-ztag", "where", &target])?;
        mapping.hash(&mut hash);
        let records = parse_ztag(&mapping);
        let mapped = records
            .iter()
            .filter(|record| !record.contains_key("unmap"))
            .collect::<Vec<_>>();
        if mapped.len() != 1 {
            return Err(AppError::msg(
                "Choose a file mapped once by this workspace view.",
            ));
        }
        let local = mapped[0]
            .get("path")
            .ok_or_else(|| AppError::msg("That path is not in this workspace."))?;
        hash_file(&connection.root, Path::new(local), &mut hash)?;
    }
    Ok(P4OperationPreview {
        output,
        fingerprint: format!("{:016x}", hash.finish()),
        target: connection.root.clone(),
    })
}

pub fn restore_shelf(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
    fingerprint: &str,
) -> AppResult<String> {
    if preview_unshelve(connection, request)?.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let (args, _) = unshelve_args(connection, request)?;
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run(connection, &refs)
}
