//! Explicit file versions shared by text, image and workspace comparisons.

use super::cli;
use super::parse::{file_type_is_binary, parse_single_diff, parse_ztag, valid_depot_path};
use super::review::run;
use super::workspace::{
    content_file_diff, env_for, workspace_directory_path, workspace_file_spec, P4Connection,
};
use crate::error::{AppError, AppResult};
use crate::git::FileDiff;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const TEXT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum P4FileVersion {
    Revision {
        depot_path: String,
        revision: String,
    },
    Workspace,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CompareRequest {
    pub path: String,
    pub base: P4FileVersion,
    pub head: P4FileVersion,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum P4Comparison {
    Diff {
        diff: FileDiff,
    },
    Text {
        path: String,
        before: String,
        after: String,
    },
}

pub(super) struct Version {
    pub depot: String,
    pub spec: Option<String>,
    pub local: Option<PathBuf>,
    pub absent: bool,
    pub binary: bool,
    pub size: Option<u64>,
}

pub(super) fn exact_depot(path: &str) -> AppResult<()> {
    if !path.starts_with("//")
        || !valid_depot_path(path)
        || path.contains(['*', '#', '@'])
        || path.contains("...")
    {
        return Err(AppError::msg(
            "Choose one depot file without wildcards or revision suffixes.",
        ));
    }
    Ok(())
}

pub(super) fn revision_number(value: &str) -> AppResult<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::msg("Enter a non-negative file revision."));
    }
    value
        .parse()
        .map_err(|_| AppError::msg("Enter a non-negative file revision."))
}

fn field(record: &super::parse::ZtagRecord, key: &str) -> String {
    record.get(key).cloned().unwrap_or_default()
}

pub(super) fn mapped_local(connection: &P4Connection, path: &str) -> AppResult<(String, PathBuf)> {
    let input = workspace_file_spec(&connection.root, path);
    let output = run(connection, &["-ztag", "where", &input])?;
    let records = parse_ztag(&output)
        .into_iter()
        .filter(|record| !record.contains_key("unmap"))
        .collect::<Vec<_>>();
    if records.len() != 1 {
        return Err(AppError::msg(
            "Choose a file mapped once by this workspace view.",
        ));
    }
    let depot = field(&records[0], "depotFile");
    exact_depot(&depot)?;
    let local = PathBuf::from(field(&records[0], "path"));
    if !local.is_absolute() {
        return Err(AppError::msg("That path is not in this workspace."));
    }
    let parent = local
        .parent()
        .and_then(|parent| parent.ancestors().find(|path| path.exists()))
        .ok_or_else(|| AppError::msg("That path is not in this workspace."))?;
    workspace_directory_path(Path::new(&connection.root), parent.to_path_buf())?;
    Ok((depot, local))
}

pub(super) fn version(
    connection: &P4Connection,
    path: &str,
    version: &P4FileVersion,
) -> AppResult<Version> {
    match version {
        P4FileVersion::Revision {
            depot_path,
            revision,
        } => {
            exact_depot(depot_path)?;
            let number = revision_number(revision)?;
            if number == 0 {
                return Ok(Version {
                    depot: depot_path.clone(),
                    spec: None,
                    local: None,
                    absent: true,
                    binary: false,
                    size: Some(0),
                });
            }
            let spec = format!("{depot_path}#{number}");
            let output = run(connection, &["-ztag", "files", &spec])?;
            let record = parse_ztag(&output)
                .into_iter()
                .next()
                .ok_or_else(|| AppError::msg("The selected file revision is unavailable."))?;
            Ok(Version {
                depot: depot_path.clone(),
                spec: Some(spec),
                local: None,
                absent: matches!(
                    field(&record, "action").as_str(),
                    "delete" | "move/delete" | "purge"
                ),
                binary: file_type_is_binary(&field(&record, "type")),
                size: None,
            })
        }
        P4FileVersion::Workspace => {
            let (depot, local) = mapped_local(connection, path)?;
            match fs::symlink_metadata(&local) {
                Ok(metadata) if metadata.is_file() => Ok(Version {
                    depot,
                    local: Some(local),
                    spec: None,
                    absent: false,
                    binary: false,
                    size: Some(metadata.len()),
                }),
                Ok(_) => Err(AppError::msg("Choose a regular workspace file.")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Version {
                    depot,
                    local: Some(local),
                    spec: None,
                    absent: true,
                    binary: false,
                    size: Some(0),
                }),
                Err(error) => Err(error.into()),
            }
        }
    }
}

pub(super) fn read_version(
    connection: &P4Connection,
    version: &Version,
    limit: usize,
) -> AppResult<(Vec<u8>, bool)> {
    if version.absent {
        return Ok((Vec::new(), false));
    }
    if let Some(local) = &version.local {
        let mut bytes = Vec::new();
        fs::File::open(local)?
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)?;
        let truncated = bytes.len() > limit;
        bytes.truncate(limit);
        return Ok((bytes, truncated));
    }
    cli::read_file_prefix(
        &env_for(connection),
        version
            .spec
            .as_deref()
            .ok_or_else(|| AppError::msg("The selected file revision is unavailable."))?,
        limit,
    )
}

fn empty_diff(path: &str, binary: bool) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary,
        truncated: false,
        lines: Vec::new(),
    }
}

pub fn compare_files(
    connection: &P4Connection,
    request: &P4CompareRequest,
) -> AppResult<P4Comparison> {
    let base = version(connection, &request.path, &request.base)?;
    let head = version(connection, &request.path, &request.head)?;
    let path = if head.depot.is_empty() {
        &base.depot
    } else {
        &head.depot
    };
    if base.binary || head.binary {
        return Ok(P4Comparison::Diff {
            diff: empty_diff(path, true),
        });
    }
    if base.absent && head.absent {
        return Ok(P4Comparison::Diff {
            diff: empty_diff(path, false),
        });
    }
    if base.absent || head.absent {
        let side = if base.absent { &head } else { &base };
        let (bytes, truncated) = read_version(connection, side, TEXT_LIMIT)?;
        return Ok(P4Comparison::Diff {
            diff: content_file_diff(path, &bytes, truncated, false, head.absent),
        });
    }
    if let (Some(before), Some(after)) = (&base.spec, &head.spec) {
        let text = cli::run_p4_diff(&env_for(connection), &["diff2", "-du", before, after])?;
        return Ok(P4Comparison::Diff {
            diff: parse_single_diff(&text, path),
        });
    }
    if base.size.is_some_and(|size| size > TEXT_LIMIT as u64)
        || head.size.is_some_and(|size| size > TEXT_LIMIT as u64)
    {
        return Err(AppError::msg(
            "Workspace text comparison is limited to 2 MiB per file.",
        ));
    }
    let (before, before_truncated) = read_version(connection, &base, TEXT_LIMIT)?;
    let (after, after_truncated) = read_version(connection, &head, TEXT_LIMIT)?;
    if before.contains(&0) || after.contains(&0) {
        return Ok(P4Comparison::Diff {
            diff: empty_diff(path, true),
        });
    }
    if before_truncated || after_truncated {
        return Err(AppError::msg(
            "Workspace text comparison is limited to 2 MiB per file.",
        ));
    }
    let before = String::from_utf8(before)
        .map_err(|_| AppError::msg("Workspace text comparison requires UTF-8 files."))?;
    let after = String::from_utf8(after)
        .map_err(|_| AppError::msg("Workspace text comparison requires UTF-8 files."))?;
    Ok(P4Comparison::Text {
        path: path.clone(),
        before,
        after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_selectors_are_explicit_and_reject_command_or_revision_injection() {
        assert_eq!(revision_number("0").unwrap(), 0);
        assert_eq!(revision_number("42").unwrap(), 42);
        for value in ["-1", "head", "1,9", "1@42", "", " 2"] {
            assert!(revision_number(value).is_err());
        }
        assert!(exact_depot("//depot/file%23%40.txt").is_ok());
        for path in [
            "//depot/...",
            "//depot/*.txt",
            "//depot/file#1",
            "//depot/file@42",
            "relative.txt",
        ] {
            assert!(exact_depot(path).is_err());
        }
    }
}
