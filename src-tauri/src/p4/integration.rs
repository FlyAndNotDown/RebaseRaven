//! Folder and named-branch integrations use explicit previews and local guards.
use std::collections::{hash_map::DefaultHasher, BTreeMap};
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::client::stable_spec;
use super::parse::{parse_ztag, spec_field};
use super::review::{allow_empty, hash_file, number, pending_change, run, P4ReconcileFile, STALE};
use super::specs::{read_spec, P4SpecKind};
use super::workspace::P4Connection;
use crate::error::{AppError, AppResult};

const LIMIT: usize = 1000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4IntegrationRange {
    pub kind: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4IntegrationRequest {
    pub method: String,
    pub source: String,
    pub target: String,
    pub branch: String,
    pub reverse: bool,
    pub range: Option<P4IntegrationRange>,
    pub force: bool,
    pub change_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4IntegrationPreview {
    pub files: Vec<P4ReconcileFile>,
    pub fingerprint: String,
}

fn path(value: &str) -> AppResult<&str> {
    if !value.starts_with("//")
        || value.len() < 3
        || value.len() > 4096
        || value.contains(['@', '#', '\\', '\0', '\r', '\n'])
    {
        return Err(AppError::msg(
            "Choose depot or workspace paths without revision suffixes.",
        ));
    }
    Ok(value)
}

fn revision_range(range: Option<&P4IntegrationRange>) -> AppResult<String> {
    let Some(range) = range else {
        return Ok(String::new());
    };
    let from = number(&range.from)?;
    let to = number(&range.to)?;
    if from.parse::<u64>().unwrap() > to.parse::<u64>().unwrap() {
        return Err(AppError::msg(
            "The first revision must not exceed the last revision.",
        ));
    }
    let prefix = match range.kind.as_str() {
        "revision" => '#',
        "changelist" => '@',
        _ => {
            return Err(AppError::msg(
                "Choose revisions or changelists for the integration range.",
            ))
        }
    };
    Ok(format!("{prefix}{from},{prefix}{to}"))
}

fn arguments(
    request: &P4IntegrationRequest,
    change: &str,
    preview: bool,
) -> AppResult<Vec<String>> {
    let target = path(&request.target)?;
    let range = revision_range(request.range.as_ref())?;
    let mut args = vec![
        "integrate".into(),
        "-m".into(),
        (LIMIT + 1).to_string(),
        "-c".into(),
        change.into(),
    ];
    if preview {
        args.push("-n".into());
    }
    if request.force {
        args.push("-f".into());
    }
    match request.method.as_str() {
        "paths" => {
            args.extend([format!("{}{range}", path(&request.source)?), target.into()]);
        }
        "branch" => {
            args.extend(["-b".into(), request.branch.clone()]);
            if request.reverse {
                args.push("-r".into());
            }
            // In branch mode a target suffix selects source revisions.
            args.push(format!("{target}{range}"));
        }
        _ => {
            return Err(AppError::msg(
                "Choose file paths or a named branch mapping.",
            ))
        }
    }
    Ok(args)
}

fn no_integrations(result: AppResult<String>) -> AppResult<String> {
    allow_empty(result).or_else(|error| {
        let lower = error.to_string().to_ascii_lowercase();
        if lower.contains("all revision(s) already integrated")
            || lower.contains("already integrated.")
        {
            Ok(String::new())
        } else {
            Err(error)
        }
    })
}

fn run_owned(connection: &P4Connection, args: &[String]) -> AppResult<String> {
    run(
        connection,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

fn target_facts(connection: &P4Connection, files: &[P4ReconcileFile]) -> AppResult<String> {
    let mut facts = String::new();
    for chunk in files.chunks(20) {
        let mut args = vec![
            "-ztag",
            "fstat",
            "-T",
            "depotFile,clientFile,haveRev,headRev,headAction,action,change",
        ];
        args.extend(chunk.iter().map(|file| file.depot_path.as_str()));
        facts.push_str(&allow_empty(run(connection, &args))?);
    }
    Ok(facts)
}

fn check_targets(
    connection: &P4Connection,
    files: &[P4ReconcileFile],
    facts: &str,
    change: &str,
) -> AppResult<()> {
    let indexed: BTreeMap<_, _> = parse_ztag(facts)
        .into_iter()
        .filter_map(|row| Some((row.get("depotFile")?.clone(), row)))
        .collect();
    let mut unopened = Vec::new();
    for file in files {
        let row = indexed.get(&file.depot_path);
        let get = |key: &str| {
            row.and_then(|row| row.get(key))
                .map(String::as_str)
                .unwrap_or("")
        };
        if !get("action").is_empty() {
            let opened_change = match get("change") {
                "" | "0" => "default",
                value => value,
            };
            if opened_change != change {
                return Err(AppError::msg(
                    "Move integration targets to the selected changelist first.",
                ));
            }
        } else if Path::new(&file.path).exists() {
            if get("haveRev").is_empty() || get("haveRev") == "0" {
                return Err(AppError::msg(
                    "Reconcile or preserve offline target changes before integrating.",
                ));
            }
            unopened.push(file.depot_path.as_str());
        } else if !get("haveRev").is_empty() && get("haveRev") != "0" {
            return Err(AppError::msg(
                "Reconcile or preserve offline target changes before integrating.",
            ));
        }
    }
    for chunk in unopened.chunks(20) {
        let mut args = vec!["diff", "-se"];
        args.extend(chunk);
        if !allow_empty(run(connection, &args))?.trim().is_empty() {
            return Err(AppError::msg(
                "Reconcile or preserve offline target changes before integrating.",
            ));
        }
    }
    Ok(())
}

pub fn preview_integration(
    connection: &P4Connection,
    request: &P4IntegrationRequest,
) -> AppResult<P4IntegrationPreview> {
    // Validate user input before any read that might interpret a name as flags.
    arguments(request, "default", true)?;
    let client = run(connection, &["client", "-o", &connection.client])?;
    if !spec_field(&client, "StreamAtChange").is_empty() {
        return Err(AppError::msg(
            "Choose a writable workspace for the current stream.",
        ));
    }
    let branch = if request.method == "branch" {
        Some(read_spec(connection, P4SpecKind::Branch, &request.branch)?)
    } else {
        None
    };
    let change = pending_change(connection, &request.change_id)?;
    let args = arguments(request, &change, true)?;
    let mut tagged = vec!["-ztag".into()];
    tagged.extend(args);
    let output = no_integrations(run_owned(connection, &tagged))?;
    let mut indexed = BTreeMap::new();
    for row in parse_ztag(&output) {
        let Some(path) = row.get("clientFile").filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(depot) = row.get("depotFile").filter(|value| value.starts_with("//")) else {
            continue;
        };
        indexed.insert(
            path.clone(),
            P4ReconcileFile {
                path: path.clone(),
                depot_path: depot.clone(),
                action: row.get("action").cloned().unwrap_or_default(),
            },
        );
    }
    let files: Vec<_> = indexed.into_values().collect();
    if files.len() > LIMIT {
        return Err(AppError::msg(
            "Too many integration targets. Choose a narrower path.",
        ));
    }
    let facts = target_facts(connection, &files)?;
    check_targets(connection, &files, &facts, &change)?;
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.root,
        stable_spec(&client),
        branch.map(|branch| branch.fingerprint),
        &tagged,
        &output,
        &facts,
    )
        .hash(&mut hash);
    for file in &files {
        hash_file(&connection.root, Path::new(&file.path), &mut hash)?;
    }
    Ok(P4IntegrationPreview {
        files,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn apply_integration(
    connection: &P4Connection,
    request: &P4IntegrationRequest,
    fingerprint: &str,
) -> AppResult<String> {
    let preview = preview_integration(connection, request)?;
    if preview.files.is_empty() || preview.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let change = pending_change(connection, &request.change_id)?;
    let output = run_owned(connection, &arguments(request, &change, false)?)?;
    // P4 can return success while reporting individual failures. Never infer a
    // complete integration from the process exit code alone.
    let facts = target_facts(connection, &preview.files)?;
    let opened: BTreeMap<_, _> = parse_ztag(&facts)
        .into_iter()
        .filter_map(|row| {
            if row.get("action").is_none_or(String::is_empty) {
                return None;
            }
            let change = match row.get("change").map(String::as_str) {
                None | Some("0" | "") => "default",
                Some(value) => value,
            }
            .to_string();
            Some((row.get("depotFile")?.clone(), change))
        })
        .collect();
    if preview
        .files
        .iter()
        .any(|file| opened.get(&file.depot_path) != Some(&change))
    {
        return Err(AppError::msg("Some integrations were not opened in the selected changelist. Review pending files before retrying."));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> P4IntegrationRequest {
        P4IntegrationRequest {
            method: "paths".into(),
            source: "//depot/main/...".into(),
            target: "//client/...".into(),
            branch: String::new(),
            reverse: false,
            range: None,
            force: false,
            change_id: "default".into(),
        }
    }

    #[test]
    fn ranges_select_source_revisions_in_both_mapping_modes() {
        let mut request = request();
        request.range = Some(P4IntegrationRange {
            kind: "changelist".into(),
            from: "10".into(),
            to: "42".into(),
        });
        let args = arguments(&request, "default", true).unwrap();
        assert_eq!(
            &args[args.len() - 2..],
            ["//depot/main/...@10,@42", "//client/..."]
        );
        request.method = "branch".into();
        request.branch = "release-map".into();
        request.reverse = true;
        let args = arguments(&request, "default", false).unwrap();
        assert!(args.contains(&"-r".to_string()));
        assert_eq!(args.last().unwrap(), "//client/...@10,@42");
    }

    #[test]
    fn invalid_ranges_and_revision_suffixes_are_rejected() {
        let mut request = request();
        request.source = "//depot/main/...@other".into();
        assert!(arguments(&request, "default", true).is_err());
        request.source = "//depot/main/...".into();
        request.target = "--force".into();
        assert!(arguments(&request, "default", true).is_err());
        request.target = "//client/...".into();
        request.range = Some(P4IntegrationRange {
            kind: "revision".into(),
            from: "42".into(),
            to: "1".into(),
        });
        assert!(arguments(&request, "default", true).is_err());
    }
}
