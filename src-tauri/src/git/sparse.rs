//! Sparse checkout previews use Git's rule matcher and preserve native warnings.
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};
use std::io::Write;

use serde::{Deserialize, Serialize};

use super::*;

const STALE: &str = "Sparse checkout changed. Reload its settings and preview again.";
const LIMIT: usize = 128 * 1024 * 1024;
const SAMPLE: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutState {
    pub enabled: bool,
    pub cone: bool,
    pub sparse_index: bool,
    pub rules: Vec<String>,
    pub patterns: Vec<String>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SparseCheckoutRequest {
    Set {
        cone: bool,
        #[serde(rename = "sparseIndex")]
        sparse_index: bool,
        rules: Vec<String>,
    },
    Reapply,
    Disable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutPreview {
    pub fingerprint: String,
    pub selected: usize,
    pub outside: usize,
    pub selected_paths: Vec<String>,
    pub ignored_count: usize,
    pub ignored_paths: Vec<String>,
    pub dirty_count: usize,
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutUpdate {
    pub state: SparseCheckoutState,
    pub report: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutOutcome {
    #[serde(flatten)]
    pub update: SparseCheckoutUpdate,
    pub snapshot: WorkspaceSnapshot,
}

fn config_bool(repo: &Repository, key: &str) -> AppResult<Option<bool>> {
    let output = run_git(repo.workdir(), &["config", "--type=bool", "--get", key])?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(git_output_error(output));
    }
    Ok(Some(output.stdout.starts_with(b"true")))
}

fn utf8(bytes: Vec<u8>) -> AppResult<String> {
    String::from_utf8(bytes)
        .map_err(|_| AppError::msg("Sparse checkout requires UTF-8 paths and rules."))
}

fn bounded_list(repo: &Repository, args: &[&str]) -> AppResult<Vec<u8>> {
    let mut child = spawn_git_stdout(repo.workdir(), args)?;
    let output = (|| {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::msg("Could not read the sparse checkout file list."))?;
        let mut bytes = Vec::new();
        stdout.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > LIMIT {
            return Err(AppError::msg(
                "The sparse checkout preview exceeds 128 MiB of paths.",
            ));
        }
        if !child.wait()?.success() {
            return Err(AppError::msg(
                "Could not read the sparse checkout file list.",
            ));
        }
        Ok(bytes)
    })();
    if output.is_err() {
        stop_child(&mut child);
    }
    output
}

pub fn sparse_checkout_state(repo: &Repository) -> AppResult<SparseCheckoutState> {
    let enabled = config_bool(repo, "core.sparseCheckout")?.unwrap_or(false);
    let configured_cone = config_bool(repo, "core.sparseCheckoutCone")?;
    let sparse_index = config_bool(repo, "index.sparse")?.unwrap_or(false);
    let pattern_path = repo.path().join("info/sparse-checkout");
    let bytes = match fs::File::open(pattern_path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(1_048_577).read_to_end(&mut bytes)?;
            if bytes.len() > 1_048_576 {
                return Err(AppError::msg(
                    "Sparse checkout rules must be smaller than 1 MiB.",
                ));
            }
            bytes
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let raw = utf8(bytes)?;
    let cone = if enabled {
        configured_cone.unwrap_or(false)
    } else {
        true
    };
    let patterns: Vec<String> = if enabled {
        raw.lines().map(String::from).collect()
    } else {
        Vec::new()
    };
    let rules = if enabled && cone {
        utf8(run_git_stdout(
            repo.workdir(),
            &["sparse-checkout", "list"],
        )?)?
        .lines()
        .map(String::from)
        .collect()
    } else {
        patterns.clone()
    };
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        repo.workdir(),
        repo.path(),
        head_oid(repo),
        symbolic_branch(repo),
        enabled,
        configured_cone,
        sparse_index,
        &raw,
    )
        .hash(&mut hash);
    Ok(SparseCheckoutState {
        enabled,
        cone,
        sparse_index,
        rules,
        patterns,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn target(
    state: &SparseCheckoutState,
    request: &SparseCheckoutRequest,
) -> AppResult<(bool, bool, Vec<String>)> {
    let (cone, sparse_index, rules) = match request {
        SparseCheckoutRequest::Set {
            cone,
            sparse_index,
            rules,
        } => (*cone, *sparse_index, rules.clone()),
        SparseCheckoutRequest::Reapply if state.enabled => {
            (state.cone, state.sparse_index, state.rules.clone())
        }
        SparseCheckoutRequest::Reapply => {
            return Err(AppError::msg(
                "Enable sparse checkout before reapplying its rules.",
            ))
        }
        SparseCheckoutRequest::Disable => (false, false, vec!["/*".into()]),
    };
    if !cone && sparse_index {
        return Err(AppError::msg("Sparse indexes require directory mode."));
    }
    if rules.len() > 10_000
        || rules.iter().map(|line| line.len() + 1).sum::<usize>() > 1_048_576
        || rules.iter().any(|line| line.contains(['\0', '\r', '\n']))
    {
        return Err(AppError::msg(
            "Enter at most 10000 sparse checkout rules on separate lines, smaller than 1 MiB.",
        ));
    }
    Ok((cone, sparse_index, rules))
}

fn rule_file(rules: &[String]) -> AppResult<tempfile::NamedTempFile> {
    let mut file = tempfile::NamedTempFile::new()?;
    for line in rules {
        writeln!(file, "{line}")?;
    }
    file.flush()?;
    Ok(file)
}

fn matching(
    repo: &Repository,
    cone: bool,
    rules: &tempfile::NamedTempFile,
    paths: &BTreeSet<String>,
) -> AppResult<BTreeSet<String>> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let file_path = rules
        .path()
        .to_str()
        .ok_or_else(|| AppError::msg("Sparse checkout requires UTF-8 paths and rules."))?;
    let output = run_git_input_output(
        repo.workdir(),
        &[
            "sparse-checkout",
            "check-rules",
            "-z",
            if cone { "--cone" } else { "--no-cone" },
            "--rules-file",
            file_path,
        ],
        &input,
    )?;
    if !output.status.success() {
        return Err(AppError::msg(format!(
            "Could not check sparse checkout rules. Git 2.42 or newer is required.\n{}",
            git_output_error(output)
        )));
    }
    Ok(utf8(output.stdout)?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect())
}

fn preview(repo: &Repository, request: &SparseCheckoutRequest) -> AppResult<SparseCheckoutPreview> {
    let state = sparse_checkout_state(repo)?;
    let (cone, _, rules) = target(&state, request)?;
    let dirty = status_snapshot(repo)?;
    let tagged = utf8(bounded_list(repo, &["ls-files", "-t", "-z"])?)?;
    let tracked: BTreeMap<String, String> = tagged
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let (tag, path) = entry
                .split_once(' ')
                .ok_or_else(|| AppError::msg("Could not read the sparse checkout file list."))?;
            Ok((path.to_string(), tag.to_string()))
        })
        .collect::<AppResult<_>>()?;
    let ignored: BTreeSet<String> = if cone {
        utf8(bounded_list(
            repo,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
        )?)?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect()
    } else {
        BTreeSet::new()
    };
    let local: BTreeSet<String> = dirty
        .staged
        .iter()
        .chain(&dirty.unstaged)
        .flat_map(|file| std::iter::once(file.path.clone()).chain(file.old_path.clone()))
        .collect();
    let paths = tracked
        .keys()
        .cloned()
        .chain(ignored.iter().cloned())
        .chain(local.iter().cloned())
        .collect();
    let file = rule_file(&rules)?;
    let matches = if matches!(request, SparseCheckoutRequest::Disable) {
        paths
    } else {
        matching(repo, cone, &file, &paths)?
    };
    let selected: Vec<_> = tracked
        .keys()
        .filter(|path| matches.contains(*path))
        .cloned()
        .collect();
    let ignored: Vec<_> = ignored
        .into_iter()
        .filter(|path| !matches.contains(path))
        .collect();
    let local: Vec<_> = local
        .into_iter()
        .filter(|path| !matches.contains(path))
        .collect();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        &state.fingerprint,
        request,
        &tracked,
        &selected,
        dirty
            .staged
            .iter()
            .chain(&dirty.unstaged)
            .map(|file| (&file.path, &file.old_path, &file.kind, file.staged))
            .collect::<Vec<_>>(),
        &local,
    )
        .hash(&mut hash);
    for path in &ignored {
        path.hash(&mut hash);
        match fs::symlink_metadata(repo.workdir().join(path)) {
            Ok(metadata) => {
                metadata.len().hash(&mut hash);
                metadata.modified().ok().hash(&mut hash);
                metadata.file_type().is_dir().hash(&mut hash);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::msg(STALE))
            }
            Err(error) => return Err(error.into()),
        }
    }
    if sparse_checkout_state(repo)?.fingerprint != state.fingerprint {
        return Err(AppError::msg(STALE));
    }
    Ok(SparseCheckoutPreview {
        fingerprint: format!("{:016x}", hash.finish()),
        selected: selected.len(),
        outside: tracked.len() - selected.len(),
        selected_paths: selected.into_iter().take(SAMPLE).collect(),
        ignored_count: ignored.len(),
        ignored_paths: ignored.into_iter().take(SAMPLE).collect(),
        dirty_count: local.len(),
        dirty_paths: local.into_iter().take(SAMPLE).collect(),
    })
}

pub fn preview_sparse_checkout(
    repo: &Repository,
    request: &SparseCheckoutRequest,
    expected: &str,
) -> AppResult<SparseCheckoutPreview> {
    if sparse_checkout_state(repo)?.fingerprint != expected {
        return Err(AppError::msg(STALE));
    }
    preview(repo, request)
}

pub fn apply_sparse_checkout(
    repo: &mut Repository,
    request: &SparseCheckoutRequest,
    expected: &str,
    allow_ignored_removal: bool,
    mut on_progress: impl FnMut(&str) + Send,
) -> AppResult<SparseCheckoutOutcome> {
    let checked = preview(repo, request)?;
    if checked.fingerprint != expected {
        return Err(AppError::msg(STALE));
    }
    if checked.ignored_count > 0 && !allow_ignored_removal {
        return Err(AppError::msg("Review and confirm ignored files outside the selection before applying sparse checkout."));
    }
    let state = sparse_checkout_state(repo)?;
    let (cone, sparse_index, rules) = target(&state, request)?;
    let file = rule_file(&rules)?;
    let mut args = vec!["sparse-checkout"];
    match request {
        SparseCheckoutRequest::Set { .. } => args.extend([
            "set",
            if cone { "--cone" } else { "--no-cone" },
            if sparse_index {
                "--sparse-index"
            } else {
                "--no-sparse-index"
            },
            "--stdin",
        ]),
        SparseCheckoutRequest::Reapply => args.push("reapply"),
        SparseCheckoutRequest::Disable => args.push("disable"),
    }
    let mut report = String::new();
    run_git_file_progress(repo.workdir(), &args, file.reopen()?, |line| {
        on_progress(line);
        if report.len() + line.len() < 65_536 {
            report.push_str(line);
            report.push('\n');
        }
    })?;
    Ok(SparseCheckoutOutcome {
        update: SparseCheckoutUpdate {
            state: sparse_checkout_state(repo)?,
            report,
        },
        snapshot: snapshot(repo)?,
    })
}

#[cfg(test)]
mod tests;
