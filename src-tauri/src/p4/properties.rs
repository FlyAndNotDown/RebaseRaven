//! File metadata and explicitly selected pending file-type changes.
use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::client::stable_spec;
use super::parse::{parse_ztag, spec_field, valid_depot_path, ZtagRecord};
use super::review::{run, STALE};
use super::workspace::{workspace_directory_path, workspace_file_spec, P4Connection};
use crate::error::{AppError, AppResult};

const LIMIT: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4OtherOpen {
    pub owner: String,
    pub action: String,
    pub change: String,
    pub locked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FileProperties {
    pub depot_path: String,
    pub local_path: String,
    pub head_type: String,
    pub open_type: String,
    pub have_rev: String,
    pub head_rev: String,
    pub head_change: String,
    pub head_time: i64,
    pub head_mod_time: i64,
    pub size: Option<u64>,
    pub digest: String,
    pub action: String,
    pub change_id: String,
    pub owner: String,
    pub locked: bool,
    pub other_open: Vec<P4OtherOpen>,
    pub blocked: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FilePropertiesView {
    pub files: Vec<P4FileProperties>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FileTypeRequest {
    pub paths: Vec<String>,
    pub selected: Vec<String>,
    pub file_type: String,
    pub change_id: String,
}

type Runner<'a> = dyn FnMut(&[&str]) -> AppResult<String> + 'a;

fn exact_depot(value: &str) -> bool {
    valid_depot_path(value)
        && !value.contains("...")
        && value
            .split('/')
            .skip(2)
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn file_argument(connection: &P4Connection, path: &str) -> AppResult<String> {
    if path.is_empty()
        || path.len() > 8192
        || path.chars().any(char::is_control)
        || path.contains("...")
    {
        return Err(AppError::msg(
            "Choose exact file paths without wildcards or revisions.",
        ));
    }
    let spec = workspace_file_spec(&connection.root, path);
    if spec.starts_with("//") {
        if !exact_depot(&spec) {
            return Err(AppError::msg(
                "Choose one depot file without revision suffixes.",
            ));
        }
    } else {
        let local = Path::new(path);
        if !local.is_absolute()
            || local
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(AppError::msg("Choose an absolute workspace file."));
        }
        let parent = local
            .parent()
            .ok_or_else(|| AppError::msg("Choose a workspace file."))?;
        let ancestor = parent
            .ancestors()
            .find(|path| path.exists())
            .ok_or_else(|| AppError::msg("The workspace folder is missing."))?;
        workspace_directory_path(Path::new(&connection.root), ancestor.to_path_buf())?;
        if fs::symlink_metadata(local).is_ok_and(|meta| meta.is_dir()) {
            return Err(AppError::msg("Choose files, not a folder."));
        }
    }
    Ok(spec)
}

fn value(row: &ZtagRecord, key: &str) -> String {
    row.get(key).cloned().unwrap_or_default()
}

fn local_facts(connection: &P4Connection, path: &str, hash: &mut DefaultHasher) -> bool {
    let path = Path::new(path);
    if !path.is_absolute() {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(ancestor) = parent.ancestors().find(|path| path.exists()) else {
        return false;
    };
    if workspace_directory_path(Path::new(&connection.root), ancestor.to_path_buf()).is_err() {
        return false;
    }
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            (
                meta.len(),
                meta.modified().ok(),
                meta.permissions().readonly(),
                meta.is_dir(),
                meta.file_type().is_symlink(),
            )
                .hash(hash);
            meta.is_file() || meta.file_type().is_symlink()
        }
        Err(_) => {
            "missing".hash(hash);
            false
        }
    }
}

fn properties_with(
    connection: &P4Connection,
    paths: &[String],
    run: &mut Runner<'_>,
) -> AppResult<P4FilePropertiesView> {
    if paths.is_empty() || paths.len() > LIMIT {
        return Err(AppError::msg("Choose between one and 200 files."));
    }
    let specs = paths
        .iter()
        .map(|path| file_argument(connection, path))
        .collect::<AppResult<Vec<_>>>()?;
    let mut hash = DefaultHasher::new();
    (
        &connection.root,
        &connection.port,
        &connection.user,
        &connection.client,
        &connection.charset,
        &connection.stream,
        &connection.server,
    )
        .hash(&mut hash);
    let client = run(&["client", "-o", &connection.client])?;
    stable_spec(&client).hash(&mut hash);
    let mut seen = BTreeSet::new();
    let mut files = Vec::new();
    for spec in specs {
        let output = run(&["-ztag", "fstat", "-Ol", "-m", "2", &spec])?;
        let rows: Vec<_> = parse_ztag(&output)
            .into_iter()
            .filter(|row| row.contains_key("depotFile"))
            .collect();
        if rows.len() != 1 {
            return Err(AppError::msg("Choose exactly one versioned file per path."));
        }
        let row = &rows[0];
        let depot_path = value(row, "depotFile");
        if !exact_depot(&depot_path) {
            return Err(AppError::msg(
                "Perforce returned an invalid depot file path.",
            ));
        }
        if !seen.insert(depot_path.clone()) {
            continue;
        }
        row.hash(&mut hash);
        let local_path = value(row, "clientFile");
        let present = local_facts(connection, &local_path, &mut hash);
        let action = value(row, "action");
        let owner = value(row, "actionOwner");
        let blocked = if !row.contains_key("isMapped") {
            "unmapped"
        } else if !present {
            "missing"
        } else if !action.is_empty() && !owner.is_empty() && owner != connection.user {
            "owner"
        } else if row
            .get("unresolved")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            > 0
        {
            "unresolved"
        } else if matches!(action.as_str(), "delete" | "move/delete")
            || (action.is_empty()
                && matches!(
                    value(row, "headAction").as_str(),
                    "delete" | "move/delete" | "purge" | "archive"
                ))
        {
            "deleted"
        } else if action.is_empty()
            && row
                .get("haveRev")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0)
                == 0
        {
            "unsynced"
        } else if !action.is_empty()
            && !matches!(
                action.as_str(),
                "add" | "edit" | "branch" | "integrate" | "move/add"
            )
        {
            "action"
        } else {
            ""
        };
        let others = row
            .get("otherOpen")
            .and_then(|count| count.parse::<usize>().ok())
            .unwrap_or(0);
        if others > 1000 {
            return Err(AppError::msg("Too many open-file records to inspect here."));
        }
        let other_open = (0..others)
            .map(|index| P4OtherOpen {
                owner: value(row, &format!("otherOpen{index}")),
                action: value(row, &format!("otherAction{index}")),
                change: value(row, &format!("otherChange{index}")),
                locked: row.contains_key(&format!("otherLock{index}"))
                    || row.contains_key(&format!("otherLockGlobal{index}")),
            })
            .collect();
        files.push(P4FileProperties {
            depot_path,
            local_path,
            head_type: value(row, "headType"),
            open_type: value(row, "type"),
            have_rev: value(row, "haveRev"),
            head_rev: value(row, "headRev"),
            head_change: value(row, "headChange"),
            head_time: value(row, "headTime").parse().unwrap_or(0),
            head_mod_time: value(row, "headModTime").parse().unwrap_or(0),
            size: row.get("fileSize").and_then(|value| value.parse().ok()),
            digest: value(row, "digest"),
            change_id: value(row, "change"),
            action,
            owner,
            locked: row.contains_key("ourLock"),
            other_open,
            blocked: blocked.into(),
        });
    }
    Ok(P4FilePropertiesView {
        files,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn file_properties(
    connection: &P4Connection,
    paths: &[String],
) -> AppResult<P4FilePropertiesView> {
    properties_with(connection, paths, &mut |args| run(connection, args))
}

fn file_type(value: &str) -> AppResult<&str> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+')
    {
        return Err(AppError::msg(
            "Enter a Perforce file type, such as text+x or binary+l.",
        ));
    }
    let (base, modifiers) = value.split_once('+').unwrap_or((value, ""));
    if !matches!(
        base,
        "" | "text"
            | "binary"
            | "symlink"
            | "unicode"
            | "utf8"
            | "utf16"
            | "apple"
            | "resource"
            | "ctext"
            | "ktext"
            | "kxtext"
            | "ltext"
            | "xtext"
            | "xbinary"
            | "xltext"
            | "ubinary"
            | "tempobj"
            | "xtempobj"
            | "uresource"
    ) || (base.is_empty() && modifiers.is_empty())
        || (value.contains('+') && modifiers.is_empty())
    {
        return Err(AppError::msg("Choose a supported Perforce base file type."));
    }
    let mut rest = modifiers;
    let mut groups = BTreeSet::new();
    while !rest.is_empty() {
        let character = rest.as_bytes()[0] as char;
        rest = &rest[1..];
        let group = match character {
            'w' | 'x' | 'l' | 'm' | 'X' => character,
            'C' | 'D' | 'F' => 'C',
            'k' => {
                if let Some(tail) = rest.strip_prefix('o') {
                    rest = tail;
                }
                'k'
            }
            'S' => {
                let end = rest.bytes().take_while(u8::is_ascii_digit).count();
                let count = &rest[..end];
                if !count.is_empty()
                    && !matches!(
                        count,
                        "1" | "2"
                            | "3"
                            | "4"
                            | "5"
                            | "6"
                            | "7"
                            | "8"
                            | "9"
                            | "10"
                            | "16"
                            | "32"
                            | "64"
                            | "128"
                            | "256"
                            | "512"
                    )
                {
                    return Err(AppError::msg("Choose a supported retained-revision count."));
                }
                rest = &rest[end..];
                'S'
            }
            _ => return Err(AppError::msg("Choose valid Perforce file type modifiers.")),
        };
        if !groups.insert(group) {
            return Err(AppError::msg(
                "File type modifiers cannot repeat or conflict.",
            ));
        }
    }
    Ok(value)
}

// Tagged edit/reopen results can include a default storage modifier omitted by fstat.
fn same_native_type(acknowledged: &str, actual: &str) -> bool {
    fn parts(value: &str) -> (&str, Vec<char>, Option<char>) {
        let (base, modifiers) = value.split_once('+').unwrap_or((value, ""));
        let mut flags: Vec<_> = modifiers
            .chars()
            .filter(|ch| !matches!(ch, 'C' | 'D' | 'F'))
            .collect();
        flags.sort_unstable();
        let storage = modifiers.chars().find(|ch| matches!(ch, 'C' | 'D' | 'F'));
        (base, flags, storage)
    }
    let (left, left_flags, left_storage) = parts(acknowledged);
    let (right, right_flags, right_storage) = parts(actual);
    !left.is_empty()
        && left == right
        && left_flags == right_flags
        && (left_storage.is_none() || right_storage.is_none() || left_storage == right_storage)
}

pub fn change_file_types(
    connection: &P4Connection,
    request: &P4FileTypeRequest,
    fingerprint: &str,
) -> AppResult<()> {
    change_with(connection, request, fingerprint, &mut |args| {
        run(connection, args)
    })
}

fn change_with(
    connection: &P4Connection,
    request: &P4FileTypeRequest,
    fingerprint: &str,
    run: &mut Runner<'_>,
) -> AppResult<()> {
    let kind = file_type(&request.file_type)?;
    let view = properties_with(connection, &request.paths, run)?;
    if view.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let selection: BTreeSet<_> = request.selected.iter().collect();
    if selection.is_empty()
        || selection.len() != request.selected.len()
        || selection
            .iter()
            .any(|path| !view.files.iter().any(|file| &file.depot_path == *path))
    {
        return Err(AppError::msg(
            "Select files from the current property view.",
        ));
    }
    let files: Vec<_> = view
        .files
        .iter()
        .filter(|file| selection.contains(&file.depot_path))
        .collect();
    if files.iter().any(|file| !file.blocked.is_empty()) {
        return Err(AppError::msg(
            "Some selected files cannot change type. Reload their properties.",
        ));
    }
    let closed: Vec<_> = files
        .iter()
        .filter(|file| file.action.is_empty())
        .map(|file| file.depot_path.as_str())
        .collect();
    let opened: Vec<_> = files
        .iter()
        .filter(|file| !file.action.is_empty())
        .map(|file| file.depot_path.as_str())
        .collect();
    let change = if closed.is_empty() {
        String::new()
    } else if request.change_id == "default" {
        "default".into()
    } else {
        let id = super::review::number(&request.change_id)?;
        let spec = run(&["change", "-o", &id])?;
        if spec_field(&spec, "Status") != "pending"
            || spec_field(&spec, "User") != connection.user
            || spec_field(&spec, "Client") != connection.client
        {
            return Err(AppError::msg(
                "Choose your own pending changelist in this workspace.",
            ));
        }
        id
    };
    let mut acknowledged = BTreeMap::new();
    for (paths, verb) in [(&closed, "edit"), (&opened, "reopen")] {
        if paths.is_empty() {
            continue;
        }
        let mut args = vec!["-ztag", verb, "-t", kind];
        if verb == "edit" {
            args.extend(["-c", &change]);
        }
        args.extend(paths.iter().copied());
        for row in parse_ztag(&run(&args)?) {
            if let (Some(path), Some(kind)) = (row.get("depotFile"), row.get("type")) {
                if !paths.contains(&path.as_str()) {
                    return Err(AppError::msg(
                        "Perforce changed a file outside the selected set. Refresh the workspace.",
                    ));
                }
                acknowledged.insert(path.clone(), kind.clone());
            }
        }
    }
    let after = properties_with(connection, &request.paths, run)?;
    for before in files {
        let next = after
            .files
            .iter()
            .find(|file| file.depot_path == before.depot_path)
            .ok_or_else(|| AppError::msg("A changed file is missing. Refresh the workspace."))?;
        let expected_change = if before.action.is_empty() {
            &change
        } else {
            &before.change_id
        };
        if !acknowledged
            .get(&before.depot_path)
            .is_some_and(|kind| same_native_type(kind, &next.open_type))
            || next.open_type.is_empty()
            || &next.change_id != expected_change
            || next.owner != connection.user
            || next.action
                != if before.action.is_empty() {
                    "edit"
                } else {
                    &before.action
                }
        {
            return Err(AppError::msg("Not all selected file types were changed as requested. Refresh the workspace to review the result."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
