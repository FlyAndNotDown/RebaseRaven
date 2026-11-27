use std::collections::{hash_map::DefaultHasher, BTreeSet};
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::Deserialize;

use super::shelf_record;
use crate::error::{AppError, AppResult};
use crate::p4::history::exact_depot;
use crate::p4::operations::P4OperationPreview;
use crate::p4::parse::{parse_ztag, spec_field, ZtagRecord};
use crate::p4::review::{
    hash_file, number, pending_change, run, run_files, workspace_file_metadata, STALE,
};
use crate::p4::workspace::P4Connection;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4UnshelveRequest {
    pub change_id: String,
    pub target: String,
    pub files: Vec<String>,
    /// Optional explicit child-to-parent mapping for a whole shelf.
    pub stream: String,
}

const MIXED: &str = "Select files from one source stream at a time.";
const NOT_MAPPED: &str = "No files can be restored into this workspace.";

struct RestorePlan {
    options: Vec<String>,
    files: Vec<String>,
    selected_count: usize,
}

impl RestorePlan {
    fn command(&self, preview: bool) -> Vec<String> {
        let mut args = vec!["-s".to_owned(), "unshelve".to_owned()];
        if preview {
            args.push("-n".into());
        }
        args.extend_from_slice(&self.options);
        args
    }

    fn execute(
        &self,
        connection: &P4Connection,
        preview: bool,
    ) -> AppResult<(String, BTreeSet<String>)> {
        let args = self.command(preview);
        let output = if self.files.is_empty() {
            let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
            run(connection, &refs)?
        } else {
            run_files(connection, &args, &self.files)?
        };
        let (output, paths) = restore_output(&output, &self.files)?;
        if paths.len() != self.selected_count {
            return Err(AppError::msg(
                "The stream mapping does not cover every selected file.",
            ));
        }
        Ok((output, paths))
    }
}

fn restore_output(output: &str, expected: &[String]) -> AppResult<(String, BTreeSet<String>)> {
    // Perforce can exit successfully while warning that individual files were skipped.
    let mut messages = Vec::new();
    let mut paths = BTreeSet::new();
    for line in output.lines() {
        if let Some(warning) = line
            .strip_prefix("warning: ")
            .or_else(|| line.strip_prefix("error: "))
        {
            return Err(AppError::msg(warning));
        }
        if let Some(message) = line
            .strip_prefix("info: ")
            .or_else(|| line.strip_prefix("info1: "))
        {
            if let Some((file, _)) = message
                .split_once(" - must resolve ")
                .or_else(|| message.rsplit_once(" - "))
            {
                let file = file.split('#').next().unwrap_or(file);
                exact_depot(file)?;
                paths.insert(file.to_string());
            }
            messages.push(message);
        }
    }
    if paths.is_empty()
        || (!expected.is_empty()
            && (paths.len() != expected.len() || expected.iter().any(|file| !paths.contains(file))))
    {
        return Err(AppError::msg(NOT_MAPPED));
    }
    Ok((messages.join("\n"), paths))
}

fn where_records(connection: &P4Connection, files: &[String]) -> AppResult<Vec<ZtagRecord>> {
    let output = run_files(connection, &["-ztag".into(), "where".into()], files)?;
    Ok(parse_ztag(&output)
        .into_iter()
        .filter(|record| !record.contains_key("unmap"))
        .collect())
}

fn cross_stream_files(
    files: &[String],
    depth: usize,
    target: &str,
) -> AppResult<(String, Vec<String>)> {
    let mut source = None;
    let mut targets = Vec::with_capacity(files.len());
    for file in files {
        let (end, _) = file
            .match_indices('/')
            .skip(2)
            .nth(depth)
            .ok_or_else(|| AppError::msg(MIXED))?;
        let stream = &file[..end];
        if source.is_some_and(|previous| previous != stream) {
            return Err(AppError::msg(MIXED));
        }
        source = Some(stream);
        targets.push(format!("{target}{}", &file[end..]));
    }
    Ok((
        source.ok_or_else(|| AppError::msg(MIXED))?.to_owned(),
        targets,
    ))
}

fn plan(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
) -> AppResult<(RestorePlan, String)> {
    let (shelf, detail) = shelf_record(connection, &request.change_id)?;
    let available: BTreeSet<_> = detail.files.iter().map(|file| &file.depot_path).collect();
    let selected: BTreeSet<_> = request.files.iter().collect();
    if selected.is_empty()
        || selected.len() != request.files.len()
        || !selected.is_subset(&available)
    {
        return Err(AppError::msg("Choose files from this shelf."));
    }
    let mut options = vec![
        "-Af".into(),
        "-s".into(),
        number(&request.change_id)?,
        "-c".into(),
        pending_change(connection, &request.target)?,
    ];
    let client = run(connection, &["client", "-o", &connection.client])?;
    let target = spec_field(&client, "Stream");
    if connection.stream.as_deref().unwrap_or_default() != target
        || !spec_field(&client, "StreamAtChange").is_empty()
    {
        return Err(AppError::msg(
            "Refresh and choose a writable stream workspace.",
        ));
    }
    let prefix = format!("{target}/");
    let mut files = request.files.clone();
    if !request.stream.is_empty() {
        exact_depot(&request.stream)?;
        if selected != available {
            return Err(AppError::msg(
                "Stream mapping restores the entire shelf. Select all files.",
            ));
        }
        options.extend(["-S".into(), request.stream.clone()]);
        files.clear();
    } else if !target.is_empty() && files.iter().any(|file| !file.starts_with(&prefix)) {
        // Imported files and virtual streams can already be in the current client view.
        let mapped: BTreeSet<_> = where_records(connection, &files)?
            .into_iter()
            .filter_map(|mut record| record.remove("depotFile"))
            .collect();
        if !files.iter().all(|file| mapped.contains(file)) {
            if files.iter().any(|file| mapped.contains(file)) {
                return Err(AppError::msg(MIXED));
            }
            let depot = files[0]
                .trim_start_matches('/')
                .split('/')
                .next()
                .unwrap_or_default();
            let output = run(
                connection,
                &["-ztag", "depots", "-t", "stream", "-e", depot],
            )?;
            let depth = parse_ztag(&output)
                .into_iter()
                .find(|r| r.get("name").is_some_and(|name| name == depot))
                .and_then(|r| r.get("depth")?.parse::<usize>().ok())
                .ok_or_else(|| AppError::msg(NOT_MAPPED))?;
            let (source, targets) = cross_stream_files(&files, depth, &target)?;
            options.extend(["-S".into(), source, "-P".into(), target]);
            // With the entire shelf selected, Perforce can apply its full generated
            // branch view, including paths remapped between the streams.
            files = if selected == available {
                Vec::new()
            } else {
                targets
            };
        }
    }
    Ok((
        RestorePlan {
            options,
            files,
            selected_count: selected.len(),
        },
        shelf,
    ))
}

fn prepare_restore(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
    mut fingerprint: Option<&mut DefaultHasher>,
) -> AppResult<(RestorePlan, String)> {
    let (mut plan, shelf) = plan(connection, request)?;
    let (output, targets) = plan.execute(connection, true)?;
    let targets = Vec::from_iter(targets);
    if let Some(hash) = fingerprint.as_deref_mut() {
        (
            &connection.root,
            &connection.port,
            &connection.user,
            &connection.client,
            &plan.options,
            &plan.files,
            &shelf,
            &output,
        )
            .hash(hash);
        run_files(connection, &["-ztag".into(), "opened".into()], &targets)?.hash(hash);
    }
    let mut seen = BTreeSet::new();
    for record in where_records(connection, &targets)? {
        let (Some(path), Some(local)) = (record.get("depotFile"), record.get("path")) else {
            continue;
        };
        if !seen.insert(path.clone()) {
            return Err(AppError::msg(
                "Choose a file mapped once by this workspace view.",
            ));
        }
        if let Some(hash) = fingerprint.as_deref_mut() {
            record.hash(hash);
            hash_file(&connection.root, Path::new(local), hash)?;
        } else {
            workspace_file_metadata(&connection.root, Path::new(local))?;
        }
    }
    if seen.iter().ne(targets.iter()) {
        return Err(AppError::msg(NOT_MAPPED));
    }
    // Restrict apply to the exact destinations reported by the dry run, even
    // when Perforce expanded the whole-shelf mapping itself.
    plan.files = targets;
    Ok((plan, output))
}

pub fn preview_unshelve(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
) -> AppResult<P4OperationPreview> {
    let mut hash = DefaultHasher::new();
    let (_, output) = prepare_restore(connection, request, Some(&mut hash))?;
    Ok(P4OperationPreview {
        output,
        fingerprint: format!("{:016x}", hash.finish()),
        target: connection.root.clone(),
    })
}

pub fn restore_shelf(
    connection: &P4Connection,
    request: &P4UnshelveRequest,
    fingerprint: Option<&str>,
) -> AppResult<Vec<String>> {
    let mut hash = fingerprint.map(|_| DefaultHasher::new());
    let (plan, _) = prepare_restore(connection, request, hash.as_mut())?;
    if let Some((expected, actual)) = fingerprint.zip(hash) {
        if format!("{:016x}", actual.finish()) != expected {
            return Err(AppError::StaleReview(STALE));
        }
    }
    let (_, paths) = plan.execute(connection, false)?;
    Ok(Vec::from_iter(paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_flags_precede_the_files_supplied_to_perforce() {
        let plan = RestorePlan {
            options: ["-Af", "-s", "42", "-c", "default"]
                .map(String::from)
                .to_vec(),
            files: vec!["//project/main/file.txt".into()],
            selected_count: 1,
        };
        let args: Vec<_> = plan
            .command(true)
            .into_iter()
            .chain(plan.files.clone())
            .collect();
        assert_eq!(
            args,
            [
                "-s",
                "unshelve",
                "-n",
                "-Af",
                "-s",
                "42",
                "-c",
                "default",
                "//project/main/file.txt"
            ]
        );
        assert!(!plan.command(false).iter().any(|arg| arg == "-n"));
    }

    #[test]
    fn maps_only_selected_files_between_parent_child_and_sibling_streams() {
        for (source, target) in [
            ("//project/main", "//project/dev"),
            ("//project/dev", "//project/main"),
            ("//project/release", "//project/dev"),
        ] {
            let path = "/art/scene - draft%23.usd";
            let (stream, files) =
                cross_stream_files(&[format!("{source}{path}")], 1, target).unwrap();
            assert_eq!(stream, source);
            assert_eq!(files, [format!("{target}{path}")]);
        }
        let nested = ["//project/team/dev/a", "//project/team/dev/b"].map(String::from);
        let (_, files) = cross_stream_files(&nested, 2, "//project/team/release").unwrap();
        assert_eq!(
            files,
            ["//project/team/release/a", "//project/team/release/b"]
        );
        let mixed = ["//project/dev/a", "//project/dev-next/a"].map(String::from);
        assert!(cross_stream_files(&mixed, 1, "//project/main").is_err());
    }

    #[test]
    fn verifies_reported_target_paths_and_propagates_partial_or_empty_previews() {
        let file = "//project/dev/first - second%23.txt";
        let output = format!("info: {file}#1 - unshelved, opened for edit\ninfo1: {file} - must resolve //project/main/first - second%23.txt@=42 before submitting\nexit: 0\n");
        let (display, paths) = restore_output(&output, &[file.to_owned()]).unwrap();
        assert_eq!(paths, [file.to_owned()].into());
        assert!(display.contains("must resolve"));
        assert!(restore_output(&output, &["//project/main/first - second%23.txt".into()]).is_err());
        assert!(restore_output(&format!("{output}warning: other file skipped\n"), &[]).is_err());
        assert!(restore_output("exit: 0\n", &[]).is_err());
    }
}
