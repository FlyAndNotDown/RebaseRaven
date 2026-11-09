//! Image versions use the same explicit revision and workspace selectors as text.
use super::history::{
    exact_depot, read_version, revision_number, version, P4CompareRequest, P4FileVersion, Version,
};
use super::parse::parse_ztag;
use super::review::run;
use super::workspace::{workspace_file_spec, P4Connection};
use crate::error::{AppError, AppResult};
use crate::git::{image_preview, ImagePair, ImageSide};
use serde::Deserialize;

const IMAGE_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum P4FileSource {
    Opened {
        path: String,
    },
    Shelf {
        path: String,
        change_id: String,
    },
    Revision {
        path: String,
        revision: String,
    },
    Compare {
        request: P4CompareRequest,
    },
    Resolve {
        path: String,
    },
    Stream {
        request: super::stream_work::P4StreamDiffRequest,
    },
}

fn revision(connection: &P4Connection, path: &str, rev: &str) -> AppResult<Version> {
    version(
        connection,
        path,
        &P4FileVersion::Revision {
            depot_path: path.to_string(),
            revision: rev.to_string(),
        },
    )
}

fn image(connection: &P4Connection, source: &Version) -> AppResult<Option<ImageSide>> {
    if source.absent {
        return Ok(None);
    }
    let (bytes, truncated) = read_version(connection, source, IMAGE_LIMIT)?;
    let size = if truncated {
        if let Some(size) = source.size {
            size
        } else {
            let spec = source.spec.as_deref().unwrap();
            let size = if let Some((path, change)) = spec.split_once("@=") {
                let output = run(connection, &["-ztag", "describe", "-S", "-s", change])?;
                parse_ztag(&output).iter().find_map(|record| {
                    record.iter().find_map(|(key, value)| {
                        let index = key.strip_prefix("depotFile")?;
                        if value != path {
                            return None;
                        }
                        record
                            .get(&format!("fileSize{index}"))
                            .and_then(|value| value.parse().ok())
                    })
                })
            } else {
                let output = run(
                    connection,
                    &["-ztag", "fstat", "-Ol", "-T", "fileSize", spec],
                )?;
                parse_ztag(&output)
                    .first()
                    .and_then(|record| record.get("fileSize"))
                    .and_then(|value| value.parse().ok())
            };
            size.ok_or_else(|| AppError::msg("The image size is unavailable."))?
        }
    } else {
        bytes.len() as u64
    };
    image_preview(&source.depot, &bytes, size, truncated).map(Some)
}

pub(super) fn file_versions(
    connection: &P4Connection,
    source: &P4FileSource,
) -> AppResult<(Version, Version)> {
    let pair = match source {
        P4FileSource::Resolve { path } => {
            super::workspace::resolve_file_versions(connection, path)?
        }
        P4FileSource::Stream { .. } => return Err(AppError::msg("Choose an image file.")),
        P4FileSource::Compare { request } => (
            version(connection, &request.path, &request.base)?,
            version(connection, &request.path, &request.head)?,
        ),
        P4FileSource::Revision {
            path,
            revision: rev,
        } => {
            let number = revision_number(rev)?;
            if number == 0 {
                return Err(AppError::msg(
                    "Enter a positive revision or changelist number.",
                ));
            }
            (
                revision(connection, path, &(number - 1).to_string())?,
                revision(connection, path, rev)?,
            )
        }
        P4FileSource::Opened { path } => {
            let output = run(
                connection,
                &[
                    "-ztag",
                    "fstat",
                    "-T",
                    "depotFile,action,haveRev",
                    &workspace_file_spec(&connection.root, path),
                ],
            )?;
            let record = parse_ztag(&output)
                .into_iter()
                .next()
                .ok_or_else(|| AppError::msg("Choose a versioned workspace file."))?;
            let depot = record
                .get("depotFile")
                .ok_or_else(|| AppError::msg("Choose a versioned workspace file."))?;
            let action = record.get("action").map(String::as_str).unwrap_or("");
            let rev = if matches!(action, "add" | "move/add") {
                "0"
            } else {
                record.get("haveRev").map(String::as_str).unwrap_or("0")
            };
            let base = revision(connection, depot, rev)?;
            let head = if matches!(action, "delete" | "move/delete") {
                revision(connection, depot, "0")?
            } else {
                version(connection, path, &P4FileVersion::Workspace)?
            };
            (base, head)
        }
        P4FileSource::Shelf { path, change_id } => {
            exact_depot(path)?;
            let detail = super::shelves::shelf_detail(connection, change_id)?;
            let file = detail
                .files
                .iter()
                .find(|file| file.depot_path == *path)
                .ok_or_else(|| AppError::msg("Choose files from this shelf."))?;
            let base_rev = if matches!(file.action.as_str(), "add" | "move/add") {
                "0"
            } else {
                &file.rev
            };
            let base = revision(connection, path, base_rev)?;
            let head = Version {
                depot: path.clone(),
                spec: Some(format!("{path}@={}", detail.id)),
                local: None,
                absent: matches!(file.action.as_str(), "delete" | "move/delete"),
                binary: true,
                size: None,
            };
            (base, head)
        }
    };
    Ok(pair)
}

pub fn image_pair(connection: &P4Connection, source: &P4FileSource) -> AppResult<ImagePair> {
    let (base, head) = file_versions(connection, source)?;
    Ok(ImagePair {
        before: image(connection, &base)?,
        after: image(connection, &head)?,
    })
}
