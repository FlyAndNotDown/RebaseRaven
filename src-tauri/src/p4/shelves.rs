//! Server-wide shelf discovery and previewed restoration into a workspace.

mod restore;
use super::parse::{indexed_groups, parse_ztag};
use super::review::{allow_empty, number, run};
use super::workspace::{
    annotate_pending, change_from_record, files_from_groups, P4ChangePage, P4Changelist,
    P4Connection,
};
use crate::error::{AppError, AppResult};
pub use restore::{preview_unshelve, restore_shelf, unshelve_files, P4UnshelveRequest};

pub fn list_shelves(
    connection: &P4Connection,
    user: &str,
    client: &str,
    before: Option<u64>,
) -> AppResult<P4ChangePage> {
    list_shelves_with(user, client, before, &mut |args| run(connection, args))
}

fn list_shelves_with(
    user: &str,
    client: &str,
    before: Option<u64>,
    run: &mut impl FnMut(&[&str]) -> AppResult<String>,
) -> AppResult<P4ChangePage> {
    let mut limit = 51usize;
    if [user, client]
        .iter()
        .any(|value| value.starts_with('-') || value.chars().any(char::is_whitespace))
    {
        return Err(AppError::msg("Choose a Perforce user or workspace name."));
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
        if !client.trim().is_empty() {
            args.extend(["-c", client.trim()]);
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
                AppError::msg("Too many shelves. Filter by user or workspace, or open a changelist by number.")
            })?;
    }
}

fn shelf_record(connection: &P4Connection, change: &str) -> AppResult<(String, P4Changelist)> {
    let id = number(change)?;
    let output = run(connection, &["-ztag", "describe", "-S", "-s", &id])?;
    let record = parse_ztag(&output).into_iter().next().unwrap_or_default();
    let files = files_from_groups(connection, &indexed_groups(&record), true);
    if files.is_empty() && !record.contains_key("stream") {
        return Err(AppError::msg("This changelist has no shelved files."));
    }
    Ok((output, change_from_record(&record, files, true)))
}

pub fn shelf_detail(connection: &P4Connection, change: &str) -> AppResult<P4Changelist> {
    shelf_record(connection, change).map(|(_, detail)| detail)
}

pub fn pending_shelf_detail(connection: &P4Connection, change: &str) -> AppResult<P4Changelist> {
    let mut detail = shelf_detail(connection, change)?;
    detail
        .files
        .sort_by_cached_key(|file| file.depot_path.to_lowercase());
    annotate_pending(connection, std::slice::from_mut(&mut detail));
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_shelves_by_metadata_without_submitted_file_revision_ranges() {
        let mut limits = Vec::new();
        let page = list_shelves_with("alice", "workstation", Some(60), &mut |args| {
            assert!(!args.iter().any(|arg| arg.starts_with("//")));
            assert!(args.windows(2).any(|pair| pair == ["-u", "alice"]));
            assert!(args.windows(2).any(|pair| pair == ["-c", "workstation"]));
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
    fn returns_the_last_page_and_propagates_permission_errors() {
        let page = list_shelves_with("", "", Some(3), &mut |_| {
            Ok("... change 8\n\n... change 2\n\n".into())
        })
        .unwrap();
        assert_eq!(page.changes.len(), 1);
        assert!(!page.has_more);
        assert!(list_shelves_with("", "", None, &mut |_| Err(AppError::msg(
            "Permission denied"
        )))
        .is_err());
    }

    #[test]
    fn rejects_invalid_shelf_filters_before_running_a_command() {
        for (user, client) in [
            ("-alice", ""),
            ("", "-workspace"),
            ("a b", ""),
            ("", "a\nb"),
        ] {
            assert!(list_shelves_with(user, client, None, &mut |_| {
                panic!("Invalid filters must not reach Perforce")
            })
            .is_err());
        }
    }
}
