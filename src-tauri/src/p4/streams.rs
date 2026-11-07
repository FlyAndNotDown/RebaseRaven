//! Previewed stream file integration into the current workspace.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::parse::{parse_ztag, spec_field, valid_depot_path};
use super::review::{allow_empty, hash_file, pending_change, run, P4ReconcileFile, STALE};
use super::workspace::P4Connection;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamRequest {
    pub mode: String,
    pub source: String,
    pub change_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamPreview {
    pub files: Vec<P4ReconcileFile>,
    pub fingerprint: String,
}

fn stable_spec(spec: &str) -> String {
    spec.lines()
        .filter(|line| !line.trim_start().starts_with("Access:"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn stream_args(
    connection: &P4Connection,
    request: &P4StreamRequest,
) -> AppResult<(Vec<String>, String)> {
    let target = connection
        .stream
        .as_deref()
        .ok_or_else(|| AppError::msg("Choose a stream workspace."))?;
    let source = &request.source;
    if source == target
        || !valid_depot_path(source)
        || !source.starts_with("//")
        || source.contains(['#', '@', '*'])
        || source.contains("...")
    {
        return Err(AppError::msg("Choose a related source stream."));
    }
    let client = run(connection, &["client", "-o", &connection.client])?;
    if spec_field(&client, "Stream") != target || !spec_field(&client, "StreamAtChange").is_empty()
    {
        return Err(AppError::msg(
            "Choose a writable workspace for the current stream.",
        ));
    }
    let target_spec = run(connection, &["stream", "-o", target])?;
    let source_spec = run(connection, &["stream", "-o", source])?;
    let change = pending_change(connection, &request.change_id)?;
    let mut args = match request.mode.as_str() {
        "merge" if spec_field(&target_spec, "Parent") == *source => {
            vec!["merge", "-Af", "-S", target, "-r"]
        }
        "copy" if spec_field(&source_spec, "Parent") == target => vec!["copy", "-Af", "-S", source],
        _ => {
            return Err(AppError::msg(
                "Merge from the parent stream or copy from a child stream.",
            ))
        }
    }
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    args.extend(["-c".into(), change]);
    Ok((
        args,
        format!(
            "{}\n{}\n{}",
            stable_spec(&client),
            stable_spec(&source_spec),
            stable_spec(&target_spec)
        ),
    ))
}

pub fn preview_stream(
    connection: &P4Connection,
    request: &P4StreamRequest,
) -> AppResult<P4StreamPreview> {
    let (args, specs) = stream_args(connection, request)?;
    let refs = std::iter::once("-ztag")
        .chain(args.iter().map(String::as_str))
        .chain(std::iter::once("-n"))
        .collect::<Vec<_>>();
    let output = allow_empty(run(connection, &refs))?;
    let scope = format!("//{}/...", connection.client);
    let opened = allow_empty(run(connection, &["-ztag", "opened", &scope]))?;
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.root,
        &args,
        &specs,
        &output,
        &opened,
    )
        .hash(&mut hash);
    let mut files = Vec::new();
    for record in parse_ztag(&output) {
        let get = |key: &str| record.get(key).cloned().unwrap_or_default();
        let path = get("clientFile");
        if path.is_empty() {
            continue;
        }
        hash_file(&connection.root, Path::new(&path), &mut hash)?;
        files.push(P4ReconcileFile {
            path,
            depot_path: get("depotFile"),
            action: get("action"),
        });
    }
    Ok(P4StreamPreview {
        files,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn apply_stream(
    connection: &P4Connection,
    request: &P4StreamRequest,
    fingerprint: &str,
) -> AppResult<String> {
    let preview = preview_stream(connection, request)?;
    if preview.fingerprint != fingerprint || preview.files.is_empty() {
        return Err(AppError::msg(STALE));
    }
    let (args, _) = stream_args(connection, request)?;
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run(connection, &refs)
}

#[cfg(test)]
mod tests {
    use super::stable_spec;

    #[test]
    fn access_times_do_not_invalidate_an_otherwise_identical_preview() {
        assert_eq!(
            stable_spec("Stream: //depot/dev\nAccess: yesterday\nParent: //depot/main\n"),
            stable_spec("Stream: //depot/dev\nAccess: today\nParent: //depot/main\n")
        );
        assert_ne!(
            stable_spec("Stream: //depot/dev\nParent: //depot/main\n"),
            stable_spec("Stream: //depot/dev\nParent: //depot/release\n")
        );
    }
}
