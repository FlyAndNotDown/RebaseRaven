//! Opened stream definitions follow the same preview and changelist lifecycle as files.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::cli;
use super::client::stable_spec;
use super::parse::{parse_single_diff, parse_ztag, spec_field};
use super::review::{number, pending_change, run};
use super::stream_specs::{fingerprint, loaded, stream_path, P4StreamSpec};
use super::workspace::{env_for, P4Connection};
use crate::error::{AppError, AppResult};
use crate::git::FileDiff;

const STALE: &str =
    "The stream, workspace, or changelist changed. Preview the stream operation again.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamOpen {
    pub change: String,
    pub base_change: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamWork {
    pub spec: P4StreamSpec,
    pub opened: Option<P4StreamOpen>,
    pub head_change: String,
    pub current_text: String,
    pub base_text: String,
    pub head_text: String,
    pub diff: FileDiff,
    pub unresolved: bool,
    pub resolve_output: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamWorkRequest {
    pub action: String,
    pub change: String,
    pub mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamWorkPreview {
    pub request: P4StreamWorkRequest,
    pub work: P4StreamWork,
    pub converted_text: Option<String>,
    pub output: String,
    pub fingerprint: String,
}

fn current_stream(connection: &P4Connection) -> AppResult<(String, String)> {
    let path = connection
        .stream
        .as_deref()
        .ok_or_else(|| AppError::msg("Choose a stream workspace."))?;
    stream_path(path)?;
    let client = run(connection, &["client", "-o", &connection.client])?;
    if spec_field(&client, "Stream") != path {
        return Err(AppError::msg(STALE));
    }
    Ok((path.to_string(), stable_spec(&client)))
}

pub fn stream_work(connection: &P4Connection) -> AppResult<P4StreamWork> {
    let (path, client) = current_stream(connection)?;
    let (current_text, spec) = loaded(connection, &path)?;
    let opened_text = run(connection, &["-ztag", "opened", "-So"])?;
    let opened = parse_ztag(&opened_text)
        .into_iter()
        .find(|row| row.get("stream") == Some(&path))
        .map(|row| P4StreamOpen {
            change: row
                .get("change")
                .cloned()
                .unwrap_or_else(|| "default".into()),
            base_change: row.get("haveChange").cloned().unwrap_or_default(),
        });
    let log = run(connection, &["-ztag", "streamlog", "-m", "1", &path])?;
    let head_change = parse_ztag(&log)
        .iter()
        .find_map(|row| row.get("change0").or_else(|| row.get("change")))
        .cloned()
        .ok_or_else(|| AppError::msg("The server did not return the stream revision."))?;
    number(&head_change)?;
    let head_text = run(
        connection,
        &["stream", "-o", &format!("{path}@{head_change}")],
    )?;
    let (diff, resolve_output) = if opened.is_some() {
        let text = cli::run_p4_diff(&env_for(connection), &["diff", "-As", "-du"])?;
        let mut diff = parse_single_diff(&text, &path);
        diff.path = path.clone();
        (diff, run(connection, &["stream", "resolve", "-n"])?)
    } else {
        (parse_single_diff("", &path), String::new())
    };
    let base_text = if let Some(open) = &opened {
        let base = number(&open.base_change)?;
        run(connection, &["stream", "-o", &format!("{path}@{base}")])?
    } else {
        current_text.clone()
    };
    let unresolved = !resolve_output.trim().is_empty()
        && !resolve_output.contains("No stream fields to resolve.");
    let fingerprint = fingerprint(
        connection,
        &format!(
            "{client}\n{opened_text}\n{log}\n{head_text}\n{current_text}\n{}\n{resolve_output}",
            spec.fingerprint
        ),
    );
    Ok(P4StreamWork {
        spec,
        opened,
        head_change,
        current_text: review_text(&current_text),
        base_text: review_text(&base_text),
        head_text: review_text(&head_text),
        diff,
        unresolved,
        resolve_output,
        fingerprint,
    })
}

fn validate_request(
    connection: &P4Connection,
    work: &P4StreamWork,
    request: &P4StreamWorkRequest,
) -> AppResult<()> {
    match request.action.as_str() {
        "open" | "parentview" => {
            if work.opened.is_some() {
                return Err(AppError::msg(
                    "Submit or revert the already opened stream definition first.",
                ));
            }
            pending_change(connection, &request.change)?;
            if request.action == "parentview"
                && (!matches!(
                    work.spec.edit.kind.as_str(),
                    "mainline" | "development" | "release"
                ) || !matches!(request.mode.as_str(), "inherit" | "noinherit")
                    || request.mode == work.spec.edit.parent_view)
            {
                return Err(AppError::msg(
                    "Choose a different parent view supported by this stream type.",
                ));
            }
        }
        "unshelve" | "deleteShelf" => {
            if request.action == "unshelve" {
                pending_change(connection, &request.change)?;
            }
            number(&request.mode)?;
            if request.action == "unshelve"
                && work
                    .opened
                    .as_ref()
                    .is_some_and(|opened| opened.change != request.change)
            {
                return Err(AppError::msg(
                    "Move the opened stream definition to the selected changelist first.",
                ));
            }
            let output = run(
                connection,
                &["-ztag", "describe", "-S", "-s", &request.mode],
            )?;
            if !parse_ztag(&output)
                .iter()
                .any(|row| row.get("stream") == Some(&work.spec.edit.path))
            {
                return Err(AppError::msg(
                    "This shelf has no definition for the workspace's stream.",
                ));
            }
        }
        "move" | "revert" | "resolve" => {
            let opened = work.opened.as_ref().ok_or_else(|| {
                AppError::msg("The stream definition is no longer opened in this workspace.")
            })?;
            if request.action == "move" {
                pending_change(connection, &request.change)?;
                if request.change == opened.change {
                    return Err(AppError::msg("Choose a different changelist."));
                }
            }
            if request.action == "resolve"
                && (!work.unresolved
                    || !matches!(request.mode.as_str(), "safe" | "merge" | "yours" | "theirs"))
            {
                return Err(AppError::msg(
                    "Choose a resolve method for the pending stream conflicts.",
                ));
            }
        }
        _ => return Err(AppError::msg("Choose a supported stream operation.")),
    }
    Ok(())
}

// Parent-view conversion reads ancestor mappings. Include the whole chain in approval.
fn ancestors(connection: &P4Connection, work: &P4StreamWork) -> AppResult<String> {
    let mut path = work.spec.edit.parent.clone();
    let mut seen = BTreeSet::from([work.spec.edit.path.clone()]);
    let mut result = String::new();
    while path != "none" && !path.is_empty() {
        stream_path(&path)?;
        if seen.len() >= 64 || !seen.insert(path.clone()) {
            return Err(AppError::msg(
                "The stream's parent chain is invalid or too deep.",
            ));
        }
        let spec = run(connection, &["stream", "-o", &path])?;
        result.push_str(&stable_spec(&spec));
        result.push('\n');
        path = spec_field(&spec, "Parent");
    }
    Ok(result)
}

fn parentview_args(request: &P4StreamWorkRequest, preview: bool) -> Vec<&str> {
    let mut args = vec!["stream", "parentview", "-o", "-c", &request.change];
    if preview {
        args.push("-n");
    }
    if request.mode == "inherit" {
        args.push("--inherit");
    } else {
        args.extend(["--noinherit", "--source-comments"]);
    }
    args
}

pub fn preview_stream_work(
    connection: &P4Connection,
    request: &P4StreamWorkRequest,
) -> AppResult<P4StreamWorkPreview> {
    let work = stream_work(connection)?;
    validate_request(connection, &work, request)?;
    let change_spec = if matches!(
        request.action.as_str(),
        "open" | "move" | "parentview" | "unshelve"
    ) && request.change != "default"
    {
        run(connection, &["change", "-s", "-o", &request.change])?
    } else {
        String::new()
    };
    let ancestor_text = if request.action == "parentview" {
        ancestors(connection, &work)?
    } else {
        String::new()
    };
    let converted_text = if request.action == "parentview" {
        Some(review_text(&run(
            connection,
            &parentview_args(request, true),
        )?))
    } else if matches!(request.action.as_str(), "unshelve" | "deleteShelf") {
        Some(review_text(&run(
            connection,
            &[
                "stream",
                "-o",
                &format!("{}@={}", work.spec.edit.path, request.mode),
            ],
        )?))
    } else {
        None
    };
    let shelf = if matches!(request.action.as_str(), "unshelve" | "deleteShelf") {
        run(
            connection,
            &["-ztag", "describe", "-S", "-s", &request.mode],
        )?
    } else {
        String::new()
    };
    let output = if request.action == "unshelve" {
        run(
            connection,
            &[
                "unshelve",
                "-As",
                "-n",
                "-s",
                &request.mode,
                "-c",
                &request.change,
            ],
        )?
    } else if request.action == "resolve" {
        work.resolve_output.clone()
    } else {
        String::new()
    };
    let request_key =
        serde_json::to_string(request).map_err(|error| AppError::msg(error.to_string()))?;
    let fingerprint = fingerprint(
        connection,
        &format!(
            "{}\n{change_spec}\n{ancestor_text}\n{shelf}\n{output}\n{}\n{request_key}",
            work.fingerprint,
            converted_text.as_deref().unwrap_or("")
        ),
    );
    Ok(P4StreamWorkPreview {
        request: request.clone(),
        work,
        converted_text,
        output,
        fingerprint,
    })
}

pub fn apply_stream_work(
    connection: &P4Connection,
    request: &P4StreamWorkRequest,
    expected: &str,
) -> AppResult<P4StreamWork> {
    let preview = preview_stream_work(connection, request)?;
    if preview.fingerprint != expected {
        return Err(AppError::msg(STALE));
    }
    match request.action.as_str() {
        "open" => {
            run(connection, &["edit", "-So", "-c", &request.change])?;
        }
        "move" => {
            run(connection, &["reopen", "-So", "-c", &request.change])?;
        }
        "revert" => {
            run(connection, &["stream", "revert"])?;
        }
        "unshelve" => {
            run(
                connection,
                &[
                    "unshelve",
                    "-As",
                    "-s",
                    &request.mode,
                    "-c",
                    &request.change,
                ],
            )?;
        }
        "deleteShelf" => {
            run(connection, &["shelve", "-d", "-As", "-c", &request.mode])?;
            let shelf = run(
                connection,
                &["-ztag", "describe", "-S", "-s", &request.mode],
            )?;
            if parse_ztag(&shelf)
                .iter()
                .any(|row| row.contains_key("stream"))
            {
                return Err(AppError::msg(
                    "The stream definition was not removed from the shelf.",
                ));
            }
        }
        "parentview" => {
            run(connection, &parentview_args(request, false))?;
        }
        "resolve" => {
            let mode = match request.mode.as_str() {
                "safe" => "-as",
                "merge" => "-am",
                "yours" => "-ay",
                "theirs" => "-at",
                _ => unreachable!(),
            };
            run(connection, &["stream", "resolve", mode])?;
        }
        _ => unreachable!(),
    }
    let actual = stream_work(connection)?;
    let applied = operation_applied(request, &actual);
    if !applied {
        return Err(AppError::msg(
            "The stream operation did not complete. Refresh the pending changes.",
        ));
    }
    Ok(actual)
}

fn operation_applied(request: &P4StreamWorkRequest, actual: &P4StreamWork) -> bool {
    match request.action.as_str() {
        "open" | "move" | "parentview" | "unshelve" => {
            actual
                .opened
                .as_ref()
                .is_some_and(|opened| opened.change == request.change)
                && (request.action != "parentview" || actual.spec.edit.parent_view == request.mode)
        }
        "revert" => actual.opened.is_none(),
        "resolve" | "deleteShelf" => true,
        _ => false,
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamDiffRequest {
    pub kind: String,
    pub path: String,
    pub change: String,
}

fn stream_change_range(
    connection: &P4Connection,
    request: &P4StreamDiffRequest,
) -> AppResult<(String, String, bool)> {
    stream_path(&request.path)?;
    let id = number(&request.change)?;
    if !matches!(request.kind.as_str(), "shelf" | "submitted") {
        return Err(AppError::msg(
            "Choose a shelved or submitted stream definition.",
        ));
    }
    let mut args = vec!["-ztag", "describe", "-s"];
    if request.kind == "shelf" {
        args.push("-S");
    }
    args.push(&id);
    let output = run(connection, &args)?;
    let records = parse_ztag(&output);
    let row = records
        .first()
        .ok_or_else(|| AppError::msg("The stream revision is unavailable."))?;
    if row.get("stream") != Some(&request.path)
        || request.kind == "submitted"
            && row.get("status").is_none_or(|status| status != "submitted")
    {
        return Err(AppError::msg("The stream revision is unavailable."));
    }
    let base = if request.kind == "shelf" {
        number(
            row.get("streamHaveChange")
                .map(String::as_str)
                .unwrap_or(""),
        )?
    } else {
        (id.parse::<u64>().unwrap() - 1).to_string()
    };
    let before = format!("{}@{base}", request.path);
    let after = format!(
        "{}@{}{id}",
        request.path,
        if request.kind == "shelf" { "=" } else { "" }
    );
    Ok((before, after, row.contains_key("streamDeleted")))
}

pub(super) fn stream_change_text(
    connection: &P4Connection,
    request: &P4StreamDiffRequest,
) -> AppResult<(String, String)> {
    let (before, after, deleted) = stream_change_range(connection, request)?;
    let before = match run(connection, &["stream", "-o", &before]) {
        Ok(text) => review_text(&text),
        Err(error) if missing_revision(&error.to_string()) => String::new(),
        Err(error) => return Err(error),
    };
    let after = if deleted {
        String::new()
    } else {
        review_text(&run(connection, &["stream", "-o", &after])?)
    };
    Ok((before, after))
}

pub fn stream_change_diff(
    connection: &P4Connection,
    request: &P4StreamDiffRequest,
) -> AppResult<FileDiff> {
    let (before, after, deleted) = stream_change_range(connection, request)?;
    if deleted {
        let text = run(connection, &["stream", "-o", &before])?;
        return Ok(definition_diff(&request.path, &text, true));
    }
    let text = cli::run_p4_diff(
        &env_for(connection),
        &["diff2", "-As", "-du", &before, &after],
    );
    let mut diff = match text {
        Ok(text) => parse_single_diff(&text, &request.path),
        Err(error) if request.kind == "submitted" && missing_revision(&error.to_string()) => {
            let text = run(connection, &["stream", "-o", &after])?;
            definition_diff(&request.path, &text, false)
        }
        Err(error) => return Err(error),
    };
    diff.path = request.path.clone();
    Ok(diff)
}

fn definition_diff(path: &str, text: &str, deleted: bool) -> FileDiff {
    super::workspace::content_file_diff(path, review_text(text).as_bytes(), false, false, deleted)
}

fn missing_revision(message: &str) -> bool {
    let value = message.to_lowercase();
    value.contains("no such stream")
        || value.contains("doesn't exist")
        || value.contains("not found")
        || value.starts_with("no stream ") && value.contains("existed at change")
}

fn review_text(spec: &str) -> String {
    spec.lines()
        .skip_while(|line| !line.starts_with("Stream:"))
        .filter(|line| {
            !line.starts_with("Access:") && !line.starts_with("Update:") && !line.starts_with('#')
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests;
