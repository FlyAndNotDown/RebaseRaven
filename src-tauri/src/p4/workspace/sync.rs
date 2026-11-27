//! Workspace sync, revision selection, and automatic resolve.
#[cfg(any(windows, test))]
mod locked;

use super::{
    env_for, field, file_spec, revision_file_spec, run_ok, run_owned, workspace_file_spec,
    P4Connection,
};
use crate::diagnostics::{record, Code, Status};
use crate::error::{AppError, AppResult};
use crate::p4::cli::{self, P4Env};
#[cfg(not(windows))]
use crate::p4::parse::sync_estimate_files;
use crate::p4::parse::{parse_ztag, valid_client_name};
use crate::p4::sync_output::{SyncOutput, TransferProgress};
use crate::p4::SyncSummary;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4RevisionPath {
    pub path: String,
    pub recursive: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4GetRevision {
    pub paths: Vec<String>,
    pub change_id: Option<String>,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub targets: Vec<P4RevisionPath>,
    pub mode: String,
    pub value: String,
    pub force: bool,
    pub safe: bool,
    pub changelist_files_only: bool,
    pub remove_not_in_label: bool,
    pub preview: bool,
}

#[derive(Clone, Copy, Default)]
struct SyncFlags {
    force: bool,
    safe: bool,
    preview: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4AutoResolveSummary {
    pub resolved: usize,
    pub remaining: usize,
    pub failed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SyncResult {
    pub output: SyncSummary,
    pub auto_resolve: Option<P4AutoResolveSummary>,
}

fn unresolved_files(env: &P4Env, scope: &str) -> AppResult<BTreeSet<String>> {
    match run_ok(env, &["-ztag", "resolve", "-n", "-o", scope], None) {
        Ok(text) => Ok(parse_ztag(&text)
            .iter()
            .filter_map(|record| record.get("clientFile").cloned())
            .collect()),
        Err(error)
            if error
                .to_string()
                .to_lowercase()
                .contains("no file(s) to resolve") =>
        {
            Ok(BTreeSet::new())
        }
        Err(error) => Err(error),
    }
}

fn auto_resolve_files(env: &P4Env, client: &str) -> AppResult<P4AutoResolveSummary> {
    if !valid_client_name(client) {
        return Err(AppError::msg("Choose a valid workspace."));
    }
    // Client scope includes the default and every numbered opened changelist.
    let scope = format!("//{client}/...");
    let before = unresolved_files(env, &scope)?;
    if before.is_empty() {
        return Ok(P4AutoResolveSummary {
            resolved: 0,
            remaining: 0,
            failed: false,
        });
    }
    let result = cli::run_p4(env, &["resolve", "-am", &scope], None)?;
    let after = unresolved_files(env, &scope)?;
    Ok(P4AutoResolveSummary {
        resolved: before.difference(&after).count(),
        remaining: after.len(),
        failed: !result.status.success(),
    })
}

pub fn sync(
    connection: &P4Connection,
    paths: &[String],
    auto_resolve: bool,
    progress: impl FnMut(&str),
) -> AppResult<P4SyncResult> {
    let paths: Vec<_> = paths
        .iter()
        .map(|path| workspace_file_spec(&connection.root, path))
        .collect();
    let env = env_for(connection);
    let mut output = SyncOutput::default();
    let success = sync_paths(
        &env,
        &paths,
        SyncFlags::default(),
        "",
        progress,
        &mut output,
    )?;
    let auto_resolve = if success && auto_resolve {
        Some(auto_resolve_files(&env, &connection.client)?)
    } else {
        None
    };
    Ok(P4SyncResult {
        output: output.finish(success),
        auto_resolve,
    })
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum RevisionOutput {
    Preview(String),
    Summary(SyncSummary),
}

pub fn get_revision(
    connection: &P4Connection,
    request: &P4GetRevision,
    mut progress: impl FnMut(&str),
) -> AppResult<RevisionOutput> {
    if request.force && request.safe {
        return Err(AppError::msg(
            "Choose either force overwrite or safe update.",
        ));
    }
    let env = env_for(connection);
    let targets = if let Some(id) = &request.change_id {
        if !request.paths.is_empty() || request.recursive || !request.targets.is_empty() {
            return Err(AppError::msg("Choose paths or a changelist."));
        }
        let id = require_revision_number(id, "Choose a numbered changelist.")?.to_string();
        mapped_change_files(&env, &id)?
            .into_iter()
            .map(|path| P4RevisionPath {
                path,
                recursive: false,
            })
            .collect()
    } else if !request.targets.is_empty() {
        if !request.paths.is_empty() || request.recursive {
            return Err(AppError::msg("Choose one set of files or folders."));
        }
        request.targets.clone()
    } else {
        request
            .paths
            .iter()
            .map(|path| P4RevisionPath {
                path: path.clone(),
                recursive: request.recursive,
            })
            .collect::<Vec<_>>()
    };
    if targets.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let exact = match request.mode.as_str() {
        "changelist" => request.changelist_files_only,
        "label" => !request.remove_not_in_label,
        _ => false,
    };
    let suffix = revision_suffix(&request.mode, &request.value, exact)?;
    let paths = targets
        .iter()
        .map(|target| revision_file_spec(&connection.root, &target.path, target.recursive, &suffix))
        .collect::<AppResult<Vec<_>>>()?;
    let flags = SyncFlags {
        force: request.force,
        safe: request.safe,
        preview: request.preview,
    };
    let mut output = String::new();
    let mut summary = SyncOutput::default();
    let mut success = true;
    // Keep argument lists short even for large changelists on Windows.
    let mut remaining = paths.as_slice();
    while !remaining.is_empty() {
        let (chunk, rest) = next_batch(remaining);
        remaining = rest;
        if request.preview {
            progress("Previewing");
            let text = run_owned(&env, &sync_args(chunk, false, false, flags), None)?;
            output.push_str(&text);
            if output.lines().count() > REVISION_PREVIEW_LINES {
                output = output
                    .lines()
                    .take(REVISION_PREVIEW_LINES)
                    .collect::<Vec<_>>()
                    .join("\n");
                output.push_str("\nPreview truncated.");
                break;
            }
        } else if !sync_paths(&env, chunk, flags, &suffix, &mut progress, &mut summary)? {
            success = false;
            break;
        }
    }
    if !request.preview {
        return Ok(RevisionOutput::Summary(summary.finish(success)));
    }
    if output.trim().is_empty() {
        output = "Up to date.".to_string();
    }
    Ok(RevisionOutput::Preview(output))
}

pub fn revision_targets(connection: &P4Connection, id: &str) -> AppResult<Vec<String>> {
    let id = require_revision_number(id, "Choose a numbered changelist.")?;
    mapped_change_files(&env_for(connection), &id.to_string())
}

fn mapped_change_files(env: &P4Env, id: &str) -> AppResult<Vec<String>> {
    let text = run_ok(
        env,
        &[
            "-ztag",
            "fstat",
            "-Rc",
            "-e",
            id,
            "-T",
            "depotFile",
            "//...",
        ],
        None,
    )?;
    let files: Vec<_> = parse_ztag(&text)
        .into_iter()
        .map(|record| field(&record, "depotFile"))
        .filter(|path| path.starts_with("//"))
        .collect();
    if files.is_empty() {
        return Err(AppError::msg(
            "No files in that changelist are mapped to this workspace.",
        ));
    }
    Ok(files)
}

const REVISION_PREVIEW_LINES: usize = 200;

fn revision_suffix(mode: &str, value: &str, exact: bool) -> AppResult<String> {
    let value = value.trim();
    match mode {
        "latest" => Ok(String::new()),
        "revision" => {
            let rev = require_revision_number(value, "Enter a revision number.")?;
            Ok(format!("#{rev}"))
        }
        "changelist" => {
            let change = require_revision_number(value, "Enter a changelist number.")?;
            if exact {
                Ok(format!("@{change},@{change}"))
            } else {
                Ok(format!("@{change}"))
            }
        }
        "beforeChangelist" => {
            let change = require_revision_number(value, "Enter a changelist number.")?;
            Ok(format!("@{}", change - 1))
        }
        "datetime" => Ok(format!("@{}", require_p4_datetime(value)?)),
        "label" => {
            if !valid_label(value) {
                return Err(AppError::msg("Enter a label name."));
            }
            if exact {
                Ok(format!("@{value},@{value}"))
            } else {
                Ok(format!("@{value}"))
            }
        }
        "workspace" => {
            if !valid_client_name(value) {
                return Err(AppError::msg("Enter a workspace name."));
            }
            Ok(format!("@{value}"))
        }
        _ => Err(AppError::msg("Choose how to specify the revision.")),
    }
}

fn require_revision_number(value: &str, message: &str) -> AppResult<u64> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(AppError::msg(message.to_string()));
    }
    let number = value
        .parse::<u64>()
        .map_err(|_| AppError::msg(message.to_string()))?;
    if number == 0 {
        return Err(AppError::msg(message.to_string()));
    }
    Ok(number)
}

fn require_p4_datetime(value: &str) -> AppResult<String> {
    if p4_datetime_ok(value) {
        Ok(value.to_string())
    } else {
        Err(AppError::msg(
            "Enter a date as yyyy/mm/dd or yyyy/mm/dd:hh:mm:ss.",
        ))
    }
}

fn p4_datetime_ok(value: &str) -> bool {
    let (date, time) = match value.split_once(':') {
        Some((date, rest)) => (date, Some(rest)),
        None => (value, None),
    };
    let mut parts = date.split('/');
    let year = parts.next();
    let month = parts.next();
    let day = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let Ok(year) = year.parse::<u16>() else {
        return false;
    };
    let Ok(month) = month.parse::<u8>() else {
        return false;
    };
    let Ok(day) = day.parse::<u8>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    let Some(time) = time else {
        return true;
    };
    let mut clock = time.split(':');
    let hour = clock.next();
    let minute = clock.next();
    let second = clock.next();
    if clock.next().is_some() {
        return false;
    }
    let (Some(hour), Some(minute), Some(second)) = (hour, minute, second) else {
        return false;
    };
    if hour.len() != 2 || minute.len() != 2 || second.len() != 2 {
        return false;
    }
    let Ok(hour) = hour.parse::<u8>() else {
        return false;
    };
    let Ok(minute) = minute.parse::<u8>() else {
        return false;
    };
    let Ok(second) = second.parse::<u8>() else {
        return false;
    };
    hour <= 23 && minute <= 59 && second <= 59
}

fn valid_label(name: &str) -> bool {
    (1..=1024).contains(&name.len())
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

pub(super) fn file_at(path: &str, suffix: &str) -> String {
    format!("{}{suffix}", file_spec(path))
}

const SYNC_ARG_BYTES: usize = 16_384;

fn next_batch(paths: &[String]) -> (&[String], &[String]) {
    let mut arg_bytes = 0;
    let count = paths
        .iter()
        .take_while(|path| {
            arg_bytes += path.len() + 3;
            arg_bytes <= SYNC_ARG_BYTES
        })
        .count()
        .max(1);
    paths.split_at(count)
}

fn sync_paths(
    env: &P4Env,
    paths: &[String],
    flags: SyncFlags,
    _revision: &str,
    mut progress: impl FnMut(&str),
    output: &mut SyncOutput,
) -> AppResult<bool> {
    let started = Instant::now();
    progress("Counting files");
    #[cfg(windows)]
    let plan = locked::plan(env, paths, flags, _revision, output)?;
    #[cfg(windows)]
    let total = plan.total;
    #[cfg(not(windows))]
    let total = match run_owned(env, &sync_args(paths, false, true, flags), None) {
        Ok(estimate) => sync_estimate_files(&estimate),
        Err(error) if error.is_cancelled() => return Err(error),
        Err(_) => None,
    };
    record(
        Code::PerforceSyncPlan,
        Status::Success,
        Some(started.elapsed()),
    );
    if total.is_some_and(|count| count > 0) {
        progress("0% Syncing");
    }
    let mut transfer = TransferProgress::default();
    let mut emit = |line: &str, count: u64| {
        if count == 1 {
            record(
                Code::PerforceSyncFirstFile,
                Status::Success,
                Some(started.elapsed()),
            );
        }
        let line = crate::error::redact_credentials(line);
        if let Some(total) = total.filter(|n| *n > 0) {
            progress(&format!(
                "{}% {line}",
                (count.saturating_mul(100) / total).min(100)
            ));
        } else {
            progress(&line);
        }
    };
    let mut run = |targets: &[String]| {
        transfer_batch(env, targets, flags, output, |line| {
            transfer.record(line, Instant::now(), &mut emit);
        })
    };
    #[cfg(windows)]
    let success = if let Some(targets) = plan.targets {
        locked::run_batches(targets, run)?
    } else {
        run(paths)?
    };
    #[cfg(not(windows))]
    let success = run(paths)?;
    transfer.finish(&mut emit);
    Ok(success)
}

fn transfer_batch(
    env: &P4Env,
    paths: &[String],
    flags: SyncFlags,
    output: &mut SyncOutput,
    mut progress: impl FnMut(&str),
) -> AppResult<bool> {
    // P4V transfers several files at once. Four threads is its usual default.
    // Progress is counted from the file lines, because asking p4 for its own
    // progress indicator turns parallel transfer off.
    for parallel in [true, false] {
        let args = sync_args(paths, parallel, false, flags);
        let refs: Vec<_> = args.iter().map(String::as_str).collect();
        let mut batch = SyncOutput::default();
        let mut saw_file = false;
        let mut retry = false;
        let success = cli::run_p4_stream(env, &refs, |line| {
            if !batch.record(line) {
                if !saw_file && parallel {
                    retry |= parallel_rejected(line);
                }
                return false;
            }
            saw_file = true;
            progress(line);
            true
        })?;
        if !success && parallel && retry && !saw_file {
            continue;
        }
        let success = success || batch.only_skips();
        output.append(batch);
        return Ok(success);
    }
    unreachable!("the serial transfer always returns")
}

fn sync_args(paths: &[String], parallel: bool, estimate: bool, flags: SyncFlags) -> Vec<String> {
    let mut args = Vec::new();
    // A file can become busy after the sharing check. Bound the native
    // fallback too: current p4 clients clamp these settings to 10 and 50 ms.
    if cfg!(windows) && !estimate && !flags.preview {
        args.extend(["-vsys.rename.max=10".into(), "-vsys.rename.wait=50".into()]);
    }
    args.push("sync".into());
    if flags.preview {
        args.extend([
            "-n".to_string(),
            "-m".to_string(),
            (REVISION_PREVIEW_LINES + 1).to_string(),
        ]);
    } else if estimate {
        args.push("-N".to_string());
    } else if parallel {
        args.push("--parallel=threads=4".to_string());
    }
    if flags.force {
        args.push("-f".to_string());
    }
    if flags.safe {
        args.push("-s".to_string());
    }
    args.extend(paths.iter().cloned());
    args
}

fn parallel_rejected(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("parallel")
        && (lower.contains("disable")
            || lower.contains("not enabled")
            || lower.contains("maximum")
            || lower.contains("net.parallel")
            || lower.contains("ignored"))
}

#[cfg(test)]
mod tests {
    use super::super::local_unc_path;
    use super::*;
    #[test]
    fn revision_specifiers_match_the_get_revision_dialog() {
        assert_eq!(revision_suffix("latest", "", false).unwrap(), "");
        assert_eq!(revision_suffix("revision", "12", false).unwrap(), "#12");
        assert_eq!(
            revision_suffix("beforeChangelist", "1200", false).unwrap(),
            "@1199"
        );
        assert_eq!(
            revision_suffix("beforeChangelist", "1", false).unwrap(),
            "@0"
        );
        assert!(revision_suffix("beforeChangelist", "0", false).is_err());
        assert_eq!(
            revision_suffix("changelist", "1200", false).unwrap(),
            "@1200"
        );
        assert_eq!(
            revision_suffix("changelist", "1200", true).unwrap(),
            "@1200,@1200"
        );
        assert_eq!(
            revision_suffix("datetime", "2026/10/16:14:30:00", false).unwrap(),
            "@2026/10/16:14:30:00"
        );
        assert_eq!(
            revision_suffix("datetime", "2026/10/16", false).unwrap(),
            "@2026/10/16"
        );
        assert_eq!(
            revision_suffix("label", "rel-1.0", false).unwrap(),
            "@rel-1.0"
        );
        assert_eq!(
            revision_suffix("label", "rel-1.0", true).unwrap(),
            "@rel-1.0,@rel-1.0"
        );
        assert_eq!(
            revision_suffix("workspace", "dev-workspace", false).unwrap(),
            "@dev-workspace"
        );
        assert!(revision_suffix("revision", "0", false).is_err());
        assert!(revision_suffix("datetime", "2026-10-16", false).is_err());
        assert!(revision_suffix("label", "bad label", false).is_err());
        assert_eq!(file_at(r"C:\work\a#b.txt", "#3"), r"C:\work\a%23b.txt#3");
    }

    #[test]
    fn local_filespecs_escape_literal_names_and_keep_depot_encoding() {
        assert_eq!(
            file_spec("/work/client/a@b#c%d*e.txt"),
            "/work/client/a%40b%23c%25d%2Ae.txt"
        );
        assert_eq!(
            file_at("/work/client/a#b.txt", ""),
            "/work/client/a%23b.txt"
        );
        assert_eq!(file_at("//depot/a%23b.txt", "#3"), "//depot/a%23b.txt#3");
        assert_eq!(
            file_spec("/work/client/folder@name/..."),
            "/work/client/folder%40name/..."
        );
        assert_eq!(
            file_spec("/work/client/literal%23.txt"),
            "/work/client/literal%2523.txt"
        );
    }

    #[test]
    fn windows_unc_files_keep_their_prefix_and_literal_filespec_characters() {
        assert_eq!(
            file_spec(r"\\server\share\a#b%file.txt"),
            r"\\server\share\a%23b%25file.txt"
        );
        assert_eq!(
            file_spec(r"\\?\UNC\server\share\a@b.txt"),
            r"\\?\UNC\server\share\a%40b.txt"
        );
        let root = r"\\server\share\client";
        let local = local_unc_path(root, "//SERVER/share/client/a#b%file.txt").unwrap();
        assert_eq!(local, r"\\SERVER\share\client\a#b%file.txt");
        assert_eq!(file_spec(&local), r"\\SERVER\share\client\a%23b%25file.txt");
        assert_eq!(
            file_at(&local, "#3"),
            r"\\SERVER\share\client\a%23b%25file.txt#3"
        );
        assert!(local_unc_path(root, "//server/share/client-other/file.txt").is_none());
        assert!(local_unc_path(root, "//depot/main/file%23name.txt").is_none());
        assert_eq!(
            local_unc_path(
                r"\\?\UNC\server\share\client",
                "//server/share/client/a.txt"
            )
            .unwrap(),
            r"\\server\share\client\a.txt"
        );
    }
}
