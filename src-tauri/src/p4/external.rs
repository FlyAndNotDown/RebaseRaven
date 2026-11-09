use super::history::read_version;
use super::images::{file_versions, P4FileSource};
use super::workspace::P4Connection;
use crate::error::{AppError, AppResult};
use crate::file_tools::FilePair;

pub fn external_file_pair(
    connection: &P4Connection,
    source: &P4FileSource,
    limit: usize,
) -> AppResult<FilePair> {
    if let P4FileSource::Stream { request } = source {
        let (before, after) = super::stream_work::stream_change_text(connection, request)?;
        if before.len().max(after.len()) > limit {
            return Err(AppError::msg(
                "The selected stream definition is too large to preview.",
            ));
        }
        return Ok(FilePair {
            path: format!("{}/stream.txt", request.path),
            before: Some(before.into_bytes()),
            after: Some(after.into_bytes()),
            working_path: None,
        });
    }
    let (base, head) = file_versions(connection, source)?;
    let read = |version: &super::history::Version| -> AppResult<Option<Vec<u8>>> {
        if version.absent {
            return Ok(None);
        }
        let (bytes, truncated) = read_version(connection, version, limit)?;
        if truncated {
            return Err(AppError::msg("The selected file is too large to preview."));
        }
        Ok(Some(bytes))
    };
    let working_path = head.local.clone();
    Ok(FilePair {
        path: head.depot.clone(),
        before: read(&base)?,
        after: read(&head)?,
        working_path,
    })
}
