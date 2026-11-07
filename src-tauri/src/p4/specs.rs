//! Label and classic branch forms share browsing and optimistic edit protection.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use super::cli;
use super::client::{block, set_block, stable_spec};
use super::parse::{parse_ztag, read_description, set_description, set_spec_field, spec_field};
use super::review::{allow_empty, number, run, STALE};
use super::workspace::{env_for, P4Connection};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Hash, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum P4SpecKind {
    Label,
    Branch,
}

impl P4SpecKind {
    fn command(self) -> &'static str {
        match self {
            Self::Label => "label",
            Self::Branch => "branch",
        }
    }
    fn field(self) -> &'static str {
        match self {
            Self::Label => "Label",
            Self::Branch => "Branch",
        }
    }
    fn list(self) -> &'static str {
        match self {
            Self::Label => "labels",
            Self::Branch => "branches",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SpecEdit {
    pub kind: P4SpecKind,
    pub name: String,
    pub owner: String,
    pub description: String,
    pub view: Vec<String>,
    pub locked: bool,
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Spec {
    #[serde(flatten)]
    pub edit: P4SpecEdit,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SpecSummary {
    pub name: String,
    pub owner: String,
    pub description: String,
    pub updated: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4SpecPage {
    pub items: Vec<P4SpecSummary>,
    pub truncated: bool,
}

fn name(value: &str) -> AppResult<&str> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('-')
        || value.contains(['@', '#', '*', '%', ',', '\\', '"'])
        || value.contains("...")
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(AppError::msg(
            "Enter one Perforce object name without wildcards.",
        ));
    }
    Ok(value)
}

fn hash(connection: &P4Connection, kind: P4SpecKind, spec: &str) -> String {
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        kind,
        stable_spec(spec),
    )
        .hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn exists(connection: &P4Connection, kind: P4SpecKind, value: &str) -> AppResult<bool> {
    name(value)?;
    let text = run(connection, &["-ztag", kind.list(), "-e", value, "-m", "1"])?;
    Ok(parse_ztag(&text)
        .iter()
        .any(|row| row.contains_key(kind.command())))
}

fn existing(connection: &P4Connection, kind: P4SpecKind, value: &str) -> AppResult<String> {
    if !exists(connection, kind, value)? {
        return Err(AppError::msg(
            "The selected Perforce object no longer exists.",
        ));
    }
    run(connection, &[kind.command(), "-o", value])
}

fn search_filter(query: &str) -> String {
    let mut filter = String::new();
    for ch in format!("*{}*", query.trim()).chars() {
        if ch != '*' || !filter.ends_with('*') {
            filter.push(ch);
        }
    }
    filter
}

pub fn list_specs(
    connection: &P4Connection,
    kind: P4SpecKind,
    query: &str,
    owner: &str,
) -> AppResult<P4SpecPage> {
    if query.len() > 1024
        || query.chars().any(char::is_control)
        || owner.chars().any(char::is_control)
    {
        return Err(AppError::msg("Enter a single-line search filter."));
    }
    let filter = search_filter(query);
    let mut args = vec!["-ztag", kind.list(), "-m", "201", "-E", &filter];
    if !owner.trim().is_empty() {
        args.extend(["-u", owner.trim()]);
    }
    let text = run(connection, &args)?;
    let mut items: Vec<_> = parse_ztag(&text)
        .iter()
        .filter_map(|row| {
            Some(P4SpecSummary {
                name: row.get(kind.command())?.clone(),
                owner: row
                    .get("Owner")
                    .or_else(|| row.get("owner"))
                    .cloned()
                    .unwrap_or_default(),
                description: row
                    .get("Description")
                    .or_else(|| row.get("description"))
                    .cloned()
                    .unwrap_or_default(),
                updated: row
                    .get("Update")
                    .or_else(|| row.get("update"))
                    .cloned()
                    .unwrap_or_default(),
            })
        })
        .collect();
    let truncated = items.len() > 200;
    items.truncate(200);
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(P4SpecPage { items, truncated })
}

fn label_revision(spec: &str) -> String {
    let inline = spec_field(spec, "Revision");
    if !inline.is_empty() {
        return inline.trim_matches('"').to_string();
    }
    // A revision such as #1 is a value, whereas View treats # as a comment.
    spec.lines()
        .skip_while(|line| !line.starts_with("Revision:"))
        .skip(1)
        .take_while(|line| line.is_empty() || line.starts_with(char::is_whitespace))
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_matches('"')
        .to_string()
}

pub fn read_spec(connection: &P4Connection, kind: P4SpecKind, value: &str) -> AppResult<P4Spec> {
    let spec = existing(connection, kind, value)?;
    Ok(P4Spec {
        edit: P4SpecEdit {
            kind,
            name: spec_field(&spec, kind.field()),
            owner: spec_field(&spec, "Owner"),
            description: read_description(&spec),
            view: block(&spec, "View"),
            locked: spec_field(&spec, "Options")
                .split_whitespace()
                .any(|flag| flag == "locked"),
            revision: label_revision(&spec),
        },
        fingerprint: hash(connection, kind, &spec),
    })
}

fn edited_spec(spec: &str, edit: &P4SpecEdit) -> AppResult<String> {
    name(&edit.name)?;
    name(&edit.owner)?;
    if edit.description.trim().is_empty()
        || edit.description.len() > 65_536
        || edit.description.contains('\0')
    {
        return Err(AppError::msg("Enter a description smaller than 64 KiB."));
    }
    if edit.view.is_empty()
        || edit.view.len() > 5000
        || edit.view.iter().any(|line| {
            let line = line.trim();
            line.is_empty()
                || line.contains(['\0', '\r', '\n'])
                || !line
                    .trim_start_matches(['-', '+', '&', '"'])
                    .starts_with("//")
        })
    {
        return Err(AppError::msg("Enter one depot mapping per line."));
    }
    if edit.revision.len() > 1024
        || edit.revision.contains(['\0', '\r', '\n', '"', '\\'])
        || (!edit.revision.is_empty() && !edit.revision.starts_with(['@', '#']))
        || (edit.kind == P4SpecKind::Branch && !edit.revision.is_empty())
    {
        return Err(AppError::msg(
            "Enter a label revision beginning with @ or #, or leave it empty.",
        ));
    }
    let mut spec = set_spec_field(spec, edit.kind.field(), &edit.name);
    spec = set_spec_field(&spec, "Owner", &edit.owner);
    spec = set_description(&spec, &edit.description);
    let options = spec_field(&spec, "Options");
    let mut flags: Vec<_> = options
        .split_whitespace()
        .filter(|flag| !matches!(*flag, "locked" | "unlocked"))
        .collect();
    flags.insert(0, if edit.locked { "locked" } else { "unlocked" });
    spec = set_spec_field(&spec, "Options", &flags.join(" "));
    spec = set_block(&spec, "View", &edit.view);
    if edit.kind == P4SpecKind::Label {
        // P4 form parsing treats an unquoted #revision as a comment.
        spec = set_block(&spec, "Revision", &[]);
        spec = set_spec_field(&spec, "Revision", &format!("\"{}\"", edit.revision));
    }
    Ok(spec)
}

pub fn save_spec(
    connection: &P4Connection,
    edit: &P4SpecEdit,
    fingerprint: Option<&str>,
) -> AppResult<P4Spec> {
    name(&edit.name)?;
    let present = exists(connection, edit.kind, &edit.name)?;
    if present != fingerprint.is_some() {
        return Err(AppError::msg(STALE));
    }
    let original = run(connection, &[edit.kind.command(), "-o", &edit.name])?;
    if fingerprint.is_some_and(|value| value != hash(connection, edit.kind, &original)) {
        return Err(AppError::msg(STALE));
    }
    let spec = edited_spec(&original, edit)?;
    cli::run_p4_ok(
        &env_for(connection),
        &[edit.kind.command(), "-i"],
        Some(&spec),
    )?;
    read_spec(connection, edit.kind, &edit.name)
}

pub fn delete_spec(
    connection: &P4Connection,
    kind: P4SpecKind,
    value: &str,
    fingerprint: &str,
) -> AppResult<()> {
    let spec = existing(connection, kind, value)?;
    if hash(connection, kind, &spec) != fingerprint {
        return Err(AppError::msg(STALE));
    }
    run(connection, &[kind.command(), "-d", value])?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4LabelFile {
    pub depot_path: String,
    pub revision: String,
    pub action: String,
    pub file_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4LabelFiles {
    pub files: Vec<P4LabelFile>,
    pub truncated: bool,
}

pub fn label_files(connection: &P4Connection, value: &str) -> AppResult<P4LabelFiles> {
    existing(connection, P4SpecKind::Label, value)?;
    let text = allow_empty(run(
        connection,
        &["-ztag", "files", "-m", "501", &format!("//...@{value}")],
    ))?;
    let mut files: Vec<_> = parse_ztag(&text)
        .iter()
        .filter_map(|row| {
            Some(P4LabelFile {
                depot_path: row.get("depotFile")?.clone(),
                revision: row.get("rev").cloned().unwrap_or_default(),
                action: row.get("action").cloned().unwrap_or_default(),
                file_type: row.get("type").cloned().unwrap_or_default(),
            })
        })
        .collect();
    let truncated = files.len() > 500;
    files.truncate(500);
    Ok(P4LabelFiles { files, truncated })
}

#[derive(Debug, Deserialize, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct P4LabelTagRequest {
    pub name: String,
    pub paths: Vec<String>,
    pub mode: String,
    pub value: String,
    pub remove: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4LabelTagPreview {
    pub output: String,
    pub fingerprint: String,
}

fn tag_args(request: &P4LabelTagRequest, preview: bool) -> AppResult<Vec<String>> {
    name(&request.name)?;
    if request.paths.is_empty()
        || request.paths.len() > 500
        || request.paths.iter().any(|path| {
            !path.starts_with("//")
                || path.len() <= 2
                || path.contains(['@', '#', '\0', '\r', '\n', '\\'])
        })
    {
        return Err(AppError::msg(
            "Choose depot or workspace paths without revision suffixes.",
        ));
    }
    let suffix = if request.remove {
        String::new()
    } else {
        match request.mode.as_str() {
            "workspace" => String::new(),
            "latest" => "#head".into(),
            "changelist" => format!("@{}", number(&request.value)?),
            "revision" => format!("#{}", number(&request.value)?),
            _ => return Err(AppError::msg("Choose a supported label source.")),
        }
    };
    let mut args = vec!["labelsync".into()];
    if preview {
        args.push("-n".into());
    }
    if request.remove {
        args.push("-d".into());
    } else {
        args.push("-a".into());
    }
    args.extend(["-l".into(), request.name.clone()]);
    args.extend(request.paths.iter().map(|path| format!("{path}{suffix}")));
    Ok(args)
}

pub fn preview_label_tag(
    connection: &P4Connection,
    request: &P4LabelTagRequest,
) -> AppResult<P4LabelTagPreview> {
    let spec = existing(connection, P4SpecKind::Label, &request.name)?;
    let label = read_spec(connection, P4SpecKind::Label, &request.name)?;
    if label.edit.locked || !label.edit.revision.is_empty() {
        return Err(AppError::msg(
            "Unlock this static label before changing its tagged files.",
        ));
    }
    let args = tag_args(request, true)?;
    let output = allow_empty(cli::run_label_preview(
        &env_for(connection),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    ))?;
    if output.len() > 524_288 || output.lines().count() > 5000 {
        return Err(AppError::msg(
            "Too many label changes. Choose a narrower path.",
        ));
    }
    let mut h = DefaultHasher::new();
    hash(connection, P4SpecKind::Label, &spec).hash(&mut h);
    request.hash(&mut h);
    let mut lines: Vec<_> = output.lines().collect();
    lines.sort_unstable();
    lines.hash(&mut h);
    Ok(P4LabelTagPreview {
        output,
        fingerprint: format!("{:016x}", h.finish()),
    })
}

pub fn apply_label_tag(
    connection: &P4Connection,
    request: &P4LabelTagRequest,
    fingerprint: &str,
) -> AppResult<String> {
    let preview = preview_label_tag(connection, request)?;
    if preview.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let args = tag_args(request, false)?;
    allow_empty(run(
        connection,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_wildcard_searches_do_not_generate_adjacent_wildcards() {
        assert_eq!(search_filter(""), "*");
        assert_eq!(search_filter("*release*"), "*release*");
        assert_eq!(search_filter("foo**bar"), "*foo*bar*");
    }

    #[test]
    fn automatic_label_revision_is_not_a_view_comment() {
        assert_eq!(
            label_revision("Revision:\n\t#1\nView:\n\t//depot/...\n"),
            "#1"
        );
        assert_eq!(
            label_revision("Revision:\t@42\nView:\n\t//depot/...\n"),
            "@42"
        );
        assert_eq!(
            label_revision("Revision:\t\"#1\"\nView:\n\t//depot/...\n"),
            "#1"
        );
        assert_eq!(label_revision("Revision:\n\nView:\n\t//depot/...\n"), "");
    }

    #[test]
    fn form_edits_preserve_unexposed_options_and_fields() {
        let spec = "Label: release\nOwner: alice\nDescription:\n\tOld description\nOptions: unlocked autoreload\nServerID: edge\nRevision: @42\nView:\n\t//depot/...\n";
        let edit = P4SpecEdit {
            kind: P4SpecKind::Label,
            name: "release".into(),
            owner: "bob".into(),
            description: "New\nSecond line".into(),
            view: vec!["//depot/main/...".into()],
            locked: true,
            revision: String::new(),
        };
        let output = edited_spec(spec, &edit).unwrap();
        assert_eq!(spec_field(&output, "Options"), "locked autoreload");
        assert_eq!(spec_field(&output, "ServerID"), "edge");
        assert_eq!(read_description(&output), "New\nSecond line");
        assert!(label_revision(&output).is_empty());
        assert_eq!(block(&output, "View"), edit.view);
    }

    #[test]
    fn tag_sources_are_explicit_and_cannot_inject_revision_or_option_arguments() {
        let mut request = P4LabelTagRequest {
            name: "release".into(),
            paths: vec!["//depot/main/...".into()],
            mode: "changelist".into(),
            value: "42".into(),
            remove: false,
        };
        assert_eq!(
            tag_args(&request, true).unwrap(),
            [
                "labelsync",
                "-n",
                "-a",
                "-l",
                "release",
                "//depot/main/...@42"
            ]
        );
        request.paths[0] = "//depot/...@other".into();
        assert!(tag_args(&request, false).is_err());
        request.paths[0] = "--force".into();
        assert!(tag_args(&request, false).is_err());
        request.paths[0] = "//depot/...".into();
        request.name = "*".into();
        assert!(tag_args(&request, false).is_err());
        request.name = "release".into();
        request.value = "-1".into();
        assert!(tag_args(&request, false).is_err());
    }
}
