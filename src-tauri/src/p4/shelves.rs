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
    list_shelves_with(user, before, &mut |args| run(connection, args))
}

fn list_shelves_with(
    user: &str,
    before: Option<u64>,
    run: &mut impl FnMut(&[&str]) -> AppResult<String>,
) -> AppResult<P4ChangePage> {
    let mut limit = 51usize;
    if user.starts_with('-') || user.chars().any(char::is_whitespace) {
        return Err(AppError::msg("Choose a Perforce user name."));
    }
    if before.is_some_and(|id| id <= 1) {
        return Ok(P4ChangePage {
            changes: Vec::new(),
            has_more: false,
            scanned_through: None,
        });
    }
    loop {
        let count = limit.to_string();
        let mut args = vec!["-ztag", "changes", "-s", "shelved", "-L", "-m", &count];
        if !user.trim().is_empty() {
            args.extend(["-u", user.trim()]);
        }
        // File revision ranges only select submitted changes. Shelf pagination
        // scans metadata and filters by the changelist id instead.
        let output = allow_empty(run(&args))?;
        let records = parse_ztag(&output);
        let rows = records
            .iter()
            .filter(|record| record.contains_key("change"))
            .collect::<Vec<_>>();
        let mut changes = rows
            .iter()
            .map(|record| change_from_record(record, Vec::new(), true))
            .filter(|change| {
                before.is_none_or(|id| change.id.parse::<u64>().is_ok_and(|change| change < id))
            })
            .collect::<Vec<_>>();
        if changes.len() > 50 || rows.len() < limit {
            let has_more = changes.len() > 50;
            changes.truncate(50);
            let scanned_through = changes.last().and_then(|change| change.id.parse().ok());
            return Ok(P4ChangePage {
                changes,
                has_more,
                scanned_through,
            });
        }
        limit = limit
            .checked_mul(2)
            .filter(|limit| *limit <= 100_000)
            .ok_or_else(|| {
                AppError::msg("Too many shelves. Filter by user or open a changelist by number.")
            })?;
    }
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

fn preview_target_paths(output: &str) -> std::collections::BTreeSet<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim().strip_prefix("... ").unwrap_or(line.trim());
            let (path, _) = line.split_once(" - ")?;
            let path = path.split('#').next().unwrap_or(path);
            (path.starts_with("//") && valid_depot_path(path)).then(|| path.to_string())
        })
        .collect()
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
    targets.extend(preview_target_paths(&output));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_shelves_by_metadata_without_submitted_file_revision_ranges() {
        let mut limits = Vec::new();
        let page = list_shelves_with("alice", Some(60), &mut |args| {
            assert!(!args.iter().any(|arg| arg.starts_with("//")));
            assert!(args.windows(2).any(|pair| pair == ["-u", "alice"]));
            let limit = args[args.iter().position(|arg| *arg == "-m").unwrap() + 1].parse::<usize>().unwrap();
            limits.push(limit);
            Ok((1..=120).rev().take(limit).map(|id| format!("... change {id}\n... user alice\n... client dev-pc\n... status pending\n\n")).collect())
        }).unwrap();
        assert_eq!(limits, [51, 102, 204]);
        assert_eq!(page.changes.len(), 50);
        assert_eq!(page.changes.first().unwrap().id, "59");
        assert_eq!(page.scanned_through, Some(10));
        assert!(page.has_more);
    }

    #[test]
    fn extracts_cross_stream_targets_from_perforce_resolve_messages() {
        let output = "... //depot/main/settings.txt - must resolve //depot/dev/settings.txt@=42 before submitting\n//depot/main/space name%23.txt#2 - unshelved, opened for edit\n";
        assert_eq!(
            preview_target_paths(output),
            [
                "//depot/main/settings.txt".to_string(),
                "//depot/main/space name%23.txt".to_string()
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn returns_the_last_page_and_propagates_permission_errors() {
        let page = list_shelves_with("", Some(3), &mut |_| {
            Ok("... change 8\n\n... change 2\n\n".into())
        })
        .unwrap();
        assert_eq!(page.changes.len(), 1);
        assert!(!page.has_more);
        assert!(
            list_shelves_with("", None, &mut |_| Err(AppError::msg("Permission denied"))).is_err()
        );
    }
}
