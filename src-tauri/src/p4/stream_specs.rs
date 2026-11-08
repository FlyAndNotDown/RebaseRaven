//! Public stream definitions retain unexposed fields and reject stale edits.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use super::client::{block, set_block, stable_spec};
use super::parse::{parse_ztag, read_description, set_description, set_spec_field, spec_field};
use super::review::run;
use super::workspace::{env_for, P4Connection};
use crate::error::{AppError, AppResult};

const STALE: &str = "The stream definition changed. Reload it before saving or deleting.";
const EXISTS: &str = "This stream already exists. Choose another path.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamOptions {
    pub locked: bool,
    pub owner_submit: bool,
    pub to_parent: bool,
    pub from_parent: bool,
    pub merge_any: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamSpecEdit {
    pub path: String,
    pub name: String,
    pub owner: String,
    pub kind: String,
    pub parent: String,
    pub parent_view: String,
    pub description: String,
    pub options: P4StreamOptions,
    pub paths: Vec<String>,
    pub remapped: Vec<String>,
    pub ignored: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamSpec {
    #[serde(flatten)]
    pub edit: P4StreamSpecEdit,
    pub fingerprint: String,
    pub opened: bool,
    pub editable_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamSetup {
    pub path: String,
    pub kind: String,
    pub parent: String,
    pub parent_view: Option<String>,
}

pub(super) fn stream_path(value: &str) -> AppResult<&str> {
    let parts: Vec<_> = value.strip_prefix("//").unwrap_or("").split('/').collect();
    if value.len() > 1024
        || parts.len() < 2
        || parts
            .iter()
            .any(|part| part.is_empty() || matches!(*part, "." | ".."))
        || value.contains(['@', '#', '*', '%', '?', '\\', '"', ','])
        || value.contains("...")
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(AppError::msg(
            "Enter one stream path without wildcards or revision suffixes.",
        ));
    }
    Ok(value)
}

fn validate_setup(setup: &P4StreamSetup) -> AppResult<()> {
    stream_path(&setup.path)?;
    if !matches!(
        setup.kind.as_str(),
        "mainline" | "development" | "release" | "virtual" | "task" | "sparsedev" | "sparserel"
    ) {
        return Err(AppError::msg("Choose a supported stream type."));
    }
    if setup.kind == "mainline" {
        if setup.parent != "none" {
            return Err(AppError::msg("A mainline stream must have no parent."));
        }
    } else {
        stream_path(&setup.parent)?;
        if setup.path == setup.parent {
            return Err(AppError::msg("Choose a different parent stream."));
        }
    }
    if setup
        .parent_view
        .as_deref()
        .is_some_and(|value| !matches!(value, "inherit" | "noinherit"))
        || (matches!(
            setup.kind.as_str(),
            "virtual" | "task" | "sparsedev" | "sparserel"
        ) && setup.parent_view.as_deref() == Some("noinherit"))
    {
        return Err(AppError::msg(
            "Choose a parent view supported by this stream type.",
        ));
    }
    Ok(())
}

pub(super) fn fingerprint(connection: &P4Connection, spec: &str) -> String {
    let mut hash = DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.charset,
        stable_spec(spec),
    )
        .hash(&mut hash);
    format!("{:016x}", hash.finish())
}

// Preserve stream mapping comments, including inherited ## source annotations.
fn mapping(spec: &str, field: &str) -> Vec<String> {
    spec.lines()
        .skip_while(|line| !line.starts_with(&format!("{field}:")))
        .skip(1)
        .take_while(|line| line.is_empty() || line.starts_with(char::is_whitespace))
        .map(str::trim_start)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect()
}

pub(super) fn parsed(connection: &P4Connection, spec: &str) -> P4StreamSpec {
    let options = spec_field(spec, "Options");
    let has = |value| options.split_whitespace().any(|word| word == value);
    P4StreamSpec {
        edit: P4StreamSpecEdit {
            path: spec_field(spec, "Stream"),
            name: spec_field(spec, "Name"),
            owner: spec_field(spec, "Owner"),
            kind: spec_field(spec, "Type"),
            parent: spec_field(spec, "Parent"),
            parent_view: spec_field(spec, "ParentView"),
            description: read_description(spec),
            options: P4StreamOptions {
                locked: has("locked"),
                owner_submit: has("ownersubmit"),
                to_parent: has("toparent"),
                from_parent: has("fromparent"),
                merge_any: has("mergeany"),
            },
            paths: mapping(spec, "Paths"),
            remapped: mapping(spec, "Remapped"),
            ignored: mapping(spec, "Ignored"),
        },
        fingerprint: fingerprint(connection, spec),
        opened: false,
        editable_fields: Vec::new(),
    }
}

fn exists(connection: &P4Connection, path: &str) -> AppResult<bool> {
    stream_path(path)?;
    let output = run(connection, &["-ztag", "streams", "-m", "1", path])?;
    Ok(parse_ztag(&output)
        .iter()
        .any(|row| row.contains_key("Stream")))
}

fn existing(connection: &P4Connection, path: &str) -> AppResult<String> {
    if !exists(connection, path)? {
        return Err(AppError::msg(
            "The selected Perforce object no longer exists.",
        ));
    }
    run(connection, &["stream", "-o", path])
}

fn template(connection: &P4Connection, setup: &P4StreamSetup) -> AppResult<String> {
    validate_setup(setup)?;
    let mut args = vec!["stream", "-o", "-t", &setup.kind];
    if setup.kind != "mainline" {
        args.extend(["-P", &setup.parent]);
    }
    if let Some(view) = &setup.parent_view {
        args.extend(["--parentview", view]);
    }
    args.push(&setup.path);
    run(connection, &args)
}

pub fn new_stream_spec(
    connection: &P4Connection,
    setup: &P4StreamSetup,
) -> AppResult<P4StreamSpec> {
    validate_setup(setup)?;
    if exists(connection, &setup.path)? {
        return Err(AppError::msg(EXISTS));
    }
    Ok(parsed(connection, &template(connection, setup)?))
}

pub(super) fn loaded(connection: &P4Connection, path: &str) -> AppResult<(String, P4StreamSpec)> {
    let spec = existing(connection, path)?;
    let mut result = parsed(connection, &spec);
    if connection.stream.as_deref() == Some(path) {
        let opened = run(connection, &["-ztag", "opened", "-So"])?;
        if parse_ztag(&opened)
            .iter()
            .any(|row| row.get("stream").is_some_and(|value| value == path))
        {
            let schema = run(connection, &["spec", "-o", "stream"])?;
            result.opened = true;
            result.editable_fields = block(&schema, "Openable")
                .iter()
                .filter_map(|line| {
                    let (field, mode) = line.split_once(char::is_whitespace)?;
                    matches!(mode.trim(), "isolate" | "propagate").then(|| field.to_string())
                })
                .collect();
            result.fingerprint = fingerprint(connection, &format!("{spec}\n{opened}\n{schema}"));
        }
    }
    Ok((spec, result))
}

pub fn read_stream_spec(connection: &P4Connection, path: &str) -> AppResult<P4StreamSpec> {
    loaded(connection, path).map(|(_, spec)| spec)
}

fn edited_spec(spec: &str, edit: &P4StreamSpecEdit) -> AppResult<String> {
    validate_setup(&P4StreamSetup {
        path: edit.path.clone(),
        kind: edit.kind.clone(),
        parent: edit.parent.clone(),
        parent_view: (!edit.parent_view.is_empty()).then(|| edit.parent_view.clone()),
    })?;
    if edit.path != spec_field(spec, "Stream") {
        return Err(AppError::msg(STALE));
    }
    if edit.parent_view != spec_field(spec, "ParentView") {
        return Err(AppError::msg(
            "Convert the parent view before editing this stream definition.",
        ));
    }
    if edit.owner.is_empty()
        || edit.owner.len() > 1024
        || edit.owner.starts_with('-')
        || edit
            .owner
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || edit.name.trim().is_empty()
        || edit.name.len() > 1024
        || edit.name.chars().any(char::is_control)
        || edit.description.len() > 65_536
        || edit.description.contains('\0')
    {
        return Err(AppError::msg(
            "Enter a stream name, owner and description smaller than 64 KiB.",
        ));
    }
    for lines in [&edit.paths, &edit.remapped, &edit.ignored] {
        if lines.len() > 5000
            || lines.iter().any(|line| {
                line.len() > 8192
                    || line.chars().any(|ch| ch.is_control() && ch != '\t')
                    || line.trim().is_empty()
            })
        {
            return Err(AppError::msg(
                "Enter one stream mapping per line, up to 5000 lines.",
            ));
        }
    }
    if !edit
        .paths
        .iter()
        .any(|line| !line.trim_start().starts_with('#'))
    {
        return Err(AppError::msg(
            "Enter one stream mapping per line, up to 5000 lines.",
        ));
    }
    if edit.kind == "virtual" && (edit.options.to_parent || edit.options.from_parent) {
        return Err(AppError::msg(
            "Virtual streams must disable integration to and from their parent.",
        ));
    }
    let mut updated = spec.to_string();
    for (field, value) in [
        ("Name", &edit.name),
        ("Owner", &edit.owner),
        ("Type", &edit.kind),
        ("Parent", &edit.parent),
    ] {
        updated = set_spec_field(&updated, field, value);
    }
    updated = if edit.description.trim().is_empty() {
        set_block(&updated, "Description", &[])
    } else {
        set_description(&updated, &edit.description)
    };
    let pairs = [
        ("locked", "unlocked", edit.options.locked),
        ("ownersubmit", "allsubmit", edit.options.owner_submit),
        ("toparent", "notoparent", edit.options.to_parent),
        ("fromparent", "nofromparent", edit.options.from_parent),
        ("mergeany", "mergedown", edit.options.merge_any),
    ];
    let old_options = spec_field(spec, "Options");
    let mut options: Vec<_> = old_options
        .split_whitespace()
        .filter(|word| !pairs.iter().any(|(yes, no, _)| word == yes || word == no))
        .collect();
    options.extend(
        pairs
            .iter()
            .map(|(yes, no, enabled)| if *enabled { *yes } else { *no }),
    );
    updated = set_spec_field(&updated, "Options", &options.join(" "));
    for (field, lines) in [
        ("Paths", &edit.paths),
        ("Remapped", &edit.remapped),
        ("Ignored", &edit.ignored),
    ] {
        updated = set_block(&updated, field, lines);
    }
    Ok(updated)
}

pub fn save_stream_spec(
    connection: &P4Connection,
    edit: &P4StreamSpecEdit,
    expected: Option<&str>,
) -> AppResult<P4StreamSpec> {
    stream_path(&edit.path)?;
    if exists(connection, &edit.path)? != expected.is_some() {
        return Err(AppError::msg(if expected.is_some() {
            STALE
        } else {
            EXISTS
        }));
    }
    let original = if let Some(expected) = expected {
        let (original, current) = loaded(connection, &edit.path)?;
        if current.fingerprint != expected {
            return Err(AppError::msg(STALE));
        }
        if current.opened {
            let updated = edited_spec(&original, edit)?;
            validate_private_fields(&original, &updated, &current.editable_fields)?;
        }
        original
    } else {
        template(
            connection,
            &P4StreamSetup {
                path: edit.path.clone(),
                kind: edit.kind.clone(),
                parent: edit.parent.clone(),
                parent_view: (!edit.parent_view.is_empty()).then(|| edit.parent_view.clone()),
            },
        )?
    };
    let updated = edited_spec(&original, edit)?;
    super::cli::run_p4_ok(&env_for(connection), &["stream", "-i"], Some(&updated))?;
    read_stream_spec(connection, &edit.path)
}

pub fn delete_stream_spec(connection: &P4Connection, path: &str, expected: &str) -> AppResult<()> {
    let current = read_stream_spec(connection, path)?;
    if current.fingerprint != expected {
        return Err(AppError::msg(STALE));
    }
    if current.opened {
        return Err(AppError::msg(
            "Revert or submit the private stream definition before deleting the stream.",
        ));
    }
    // Keep server protections for populated streams, child streams and clients.
    run(connection, &["stream", "-d", path])?;
    Ok(())
}

fn validate_private_fields(before: &str, after: &str, editable: &[String]) -> AppResult<()> {
    for field in [
        "Owner",
        "Name",
        "Parent",
        "Type",
        "Description",
        "Options",
        "Paths",
        "Remapped",
        "Ignored",
    ] {
        let get = |spec: &str| match field {
            "Description" => read_description(spec),
            "Paths" | "Remapped" | "Ignored" => mapping(spec, field).join("\n"),
            "Options" => {
                let value = spec_field(spec, field);
                let mut values: Vec<_> = value.split_whitespace().collect();
                values.sort_unstable();
                values.join(" ")
            }
            _ => spec_field(spec, field),
        };
        if get(before) != get(after) && !editable.iter().any(|value| value == field) {
            return Err(AppError::msg("This field is not isolated by the server's stream definition. Submit or revert the private edit first."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SPEC: &str = "Stream: //project/dev\nName: Development\nOwner: alice\nParent: //project/main\nType: development\nParentView: inherit\nOptions: allsubmit unlocked toparent fromparent mergedown futureoption\nDescription:\n\tDevelopment work\nPaths:\n\tshare ...\n\t## keep source annotation\nRemapped:\n\told/... new/...\nIgnored:\n\t.cache\nComponents:\n\treadonly lib //library/main\nCustom: preserved\n";
    fn connection() -> P4Connection {
        P4Connection {
            root: String::new(),
            port: "example:1666".into(),
            user: "alice".into(),
            client: "workspace".into(),
            charset: String::new(),
            stream: Some("//project/dev".into()),
            server: String::new(),
        }
    }
    #[test]
    fn edits_preserve_components_custom_fields_comments_and_unknown_options() {
        let mut edit = parsed(&connection(), SPEC).edit;
        edit.name = "Feature work".into();
        edit.options.owner_submit = true;
        edit.options.locked = true;
        edit.paths.push("exclude build/...".into());
        let saved = edited_spec(SPEC, &edit).unwrap();
        assert!(saved.contains("readonly lib //library/main\n"));
        assert!(saved.contains("Custom: preserved\n"));
        assert!(saved.contains("## keep source annotation\n"));
        let reread = parsed(&connection(), &saved);
        assert_eq!(reread.edit.name, "Feature work");
        assert_eq!(reread.edit.paths, edit.paths);
        let options = spec_field(&saved, "Options");
        assert!(options.contains("futureoption"));
        assert!(options.contains("ownersubmit"));
        assert!(!options
            .split_whitespace()
            .any(|word| word == "allsubmit" || word == "unlocked"));
    }
    #[test]
    fn rejects_form_injection_invalid_lineage_and_parent_view_conversion() {
        for value in [
            "project/dev",
            "//project/dev@2",
            "//project/...",
            "//project/dev\nType: task",
            "//project//dev",
            "//project/dev/",
        ] {
            assert!(stream_path(value).is_err());
        }
        let original = parsed(&connection(), SPEC).edit;
        let mut edit = original.clone();
        edit.parent = edit.path.clone();
        assert!(edited_spec(SPEC, &edit).is_err());
        let mut edit = original.clone();
        edit.parent_view = "noinherit".into();
        assert!(edited_spec(SPEC, &edit).is_err());
        let mut edit = original.clone();
        edit.paths = vec!["share ...\nOwner: bob".into()];
        assert!(edited_spec(SPEC, &edit).is_err());
        let mut edit = original.clone();
        edit.kind = "virtual".into();
        assert!(edited_spec(SPEC, &edit).is_err());
        edit.options.to_parent = false;
        edit.options.from_parent = false;
        assert!(edited_spec(SPEC, &edit).is_ok());
        let mut edit = original;
        edit.kind = "mainline".into();
        assert!(edited_spec(SPEC, &edit).is_err());
        edit.parent = "none".into();
        assert!(edited_spec(SPEC, &edit).is_ok());
    }
    #[test]
    fn fingerprints_ignore_access_time_but_include_server_user_and_fields() {
        let connection = connection();
        assert_eq!(
            fingerprint(&connection, SPEC),
            fingerprint(&connection, &format!("Access: today\n{SPEC}"))
        );
        assert_ne!(
            fingerprint(&connection, SPEC),
            fingerprint(&connection, &SPEC.replace("Development", "Changed"))
        );
        let mut other = connection.clone();
        other.port = "other:1666".into();
        assert_ne!(fingerprint(&connection, SPEC), fingerprint(&other, SPEC));
    }
    #[test]
    fn private_edits_cannot_change_fields_excluded_from_server_isolation() {
        let mut edit = parsed(&connection(), SPEC).edit;
        edit.paths.push("exclude generated/...".into());
        let updated = edited_spec(SPEC, &edit).unwrap();
        assert!(validate_private_fields(SPEC, &updated, &["Paths".into()]).is_ok());
        edit.name = "Would publish immediately".into();
        let updated = edited_spec(SPEC, &edit).unwrap();
        assert!(validate_private_fields(SPEC, &updated, &["Paths".into()]).is_err());
        assert!(validate_private_fields(SPEC, &updated, &["Paths".into(), "Name".into()]).is_ok());
        assert!(updated.contains("Custom: preserved"));
    }
}
