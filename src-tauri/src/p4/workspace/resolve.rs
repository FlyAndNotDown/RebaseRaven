//! Conflict inspection, merge previews, and manual resolution.
use super::{
    empty_diff, env_for, field, run_ok, workspace_directory_path, workspace_file_spec, P4Connection,
};
use crate::error::{AppError, AppResult};
use crate::git::FileDiff;
use crate::p4::cli::{self, P4Env};
use crate::p4::parse::{file_type_is_binary, parse_single_diff, parse_ztag, valid_depot_path};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ResolveView {
    pub path: String,
    pub summary: String,
    /// A text merge can accept the merged result. Branch and delete resolves cannot.
    pub content: bool,
    pub auto_mergeable: bool,
    /// False when the two sides could not be diffed. The choices still work.
    pub comparable: bool,
    pub working_copy: bool,
    pub pending_resolves: usize,
    pub diff: FileDiff,
}

pub fn resolve_view(connection: &P4Connection, path: &str) -> AppResult<P4ResolveView> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("Choose a file to resolve."));
    }
    let env = env_for(connection);
    let spec = workspace_file_spec(&connection.root, path);
    // Unlike fstat -Or, this lists only resolves that still need a decision.
    let preview = run_ok(&env, &["-ztag", "resolve", "-n", "-o", &spec], None)?;
    let (facts, pending_resolves) = pending_resolve_facts(&preview, &spec)
        .ok_or_else(|| AppError::msg("This file does not need resolve."))?;
    let (diff, comparable, working_copy) = resolve_diff(&env, &facts);
    Ok(P4ResolveView {
        path: facts.depot.clone(),
        summary: resolve_summary(&facts),
        content: resolve_can_merge(&facts.action, &facts.kind),
        auto_mergeable: pending_resolves == 1
            && resolve_can_merge(&facts.action, &facts.kind)
            && auto_merge_available(&env, &spec),
        comparable,
        working_copy,
        pending_resolves,
        diff,
    })
}

pub(in crate::p4) fn resolve_file_versions(
    connection: &P4Connection,
    path: &str,
) -> AppResult<(crate::p4::history::Version, crate::p4::history::Version)> {
    use crate::p4::history::{version, P4FileVersion, Version};
    let env = env_for(connection);
    let spec = workspace_file_spec(&connection.root, path);
    let preview = run_ok(&env, &["-ztag", "resolve", "-n", "-o", &spec], None)?;
    let (facts, _) = pending_resolve_facts(&preview, &spec)
        .ok_or_else(|| AppError::msg("This file does not need resolve."))?;
    let incoming = Version {
        depot: facts.from_file.clone(),
        spec: Some(incoming_resolve_spec(&facts)),
        local: None,
        absent: false,
        binary: false,
        size: None,
    };
    let view = resolve_view(connection, path)?;
    if !view.comparable {
        return Err(AppError::msg("The two sides cannot be compared."));
    }
    if view.working_copy {
        Ok((
            incoming,
            version(connection, path, &P4FileVersion::Workspace)?,
        ))
    } else {
        Ok((
            Version {
                depot: facts.depot.clone(),
                spec: Some(format!("{}#have", facts.depot)),
                local: None,
                absent: false,
                binary: false,
                size: None,
            },
            incoming,
        ))
    }
}

pub fn resolve_accept(connection: &P4Connection, path: &str, mode: &str) -> AppResult<()> {
    let flag = match mode {
        "yours" => "-ay",
        "theirs" => "-at",
        "merge" => "-am",
        _ => return Err(AppError::msg("Choose yours, theirs, or merge.")),
    };
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::msg("Choose a file to resolve."));
    }
    let env = env_for(connection);
    let spec = workspace_file_spec(&connection.root, path);
    run_ok(&env, &["resolve", flag, &spec], None)?;
    if resolve_still_open(&env, &spec)? {
        return Err(AppError::msg(if mode == "merge" {
            crate::error::P4_RESOLVE_CONFLICTS
        } else {
            "This file still needs resolve."
        }));
    }
    Ok(())
}

const MANUAL_MERGE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ManualResolve {
    pub base: String,
    pub yours: String,
    pub theirs: String,
    pub fingerprint: String,
}

fn merge_text(bytes: Vec<u8>, truncated: bool) -> AppResult<String> {
    if truncated || bytes.len() > MANUAL_MERGE_LIMIT || bytes.contains(&0) {
        return Err(AppError::msg(
            "Manual merge requires UTF-8 text files smaller than 2 MiB.",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| AppError::msg("Manual merge requires UTF-8 text files smaller than 2 MiB."))
}

fn manual_resolve_snapshot(
    connection: &P4Connection,
    path: &str,
) -> AppResult<(P4ManualResolve, PathBuf)> {
    use std::hash::{Hash, Hasher};
    let env = env_for(connection);
    let spec = workspace_file_spec(&connection.root, path);
    let preview = run_ok(&env, &["-ztag", "resolve", "-n", "-o", &spec], None)?;
    let (facts, count) = pending_resolve_facts(&preview, &spec)
        .ok_or_else(|| AppError::msg("This file does not need resolve."))?;
    if count != 1
        || !resolve_can_merge(&facts.action, &facts.kind)
        || facts.base_file.is_empty()
        || facts.base_rev.parse::<u64>().unwrap_or(0) == 0
        || facts.from_file.is_empty()
        || facts.end_rev.parse::<u64>().unwrap_or(0) == 0
    {
        return Err(AppError::msg(
            "Manual merge requires one text content resolve with a common base.",
        ));
    }
    let meta = run_ok(
        &env,
        &["-ztag", "fstat", "-T", "clientFile,type,headType", &spec],
        None,
    )?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    if file_type_is_binary(&field(&record, "type"))
        || file_type_is_binary(&field(&record, "headType"))
    {
        return Err(AppError::msg(
            "Manual merge requires UTF-8 text files smaller than 2 MiB.",
        ));
    }
    let local = PathBuf::from(field(&record, "clientFile"));
    if !local.is_absolute() || !fs::symlink_metadata(&local)?.file_type().is_file() {
        return Err(AppError::msg("Choose a regular workspace file."));
    }
    let parent = local
        .parent()
        .ok_or_else(|| AppError::msg("Choose a regular workspace file."))?;
    workspace_directory_path(Path::new(&connection.root), parent.to_path_buf())?;
    let yours = merge_text(
        std::io::BufReader::new(fs::File::open(&local)?)
            .take((MANUAL_MERGE_LIMIT + 1) as u64)
            .bytes()
            .collect::<Result<Vec<_>, _>>()?,
        false,
    )?;
    let read_revision = |file: &str, rev: &str| -> AppResult<String> {
        if !valid_depot_path(file) || !file.starts_with("//") {
            return Err(AppError::msg(
                "Choose the exact depot file path returned by Perforce.",
            ));
        }
        let (bytes, truncated) =
            cli::read_file_prefix(&env, &format!("{file}#{rev}"), MANUAL_MERGE_LIMIT)?;
        merge_text(bytes, truncated)
    };
    let base = read_revision(&facts.base_file, &facts.base_rev)?;
    let (bytes, truncated) =
        cli::read_file_prefix(&env, &incoming_resolve_spec(&facts), MANUAL_MERGE_LIMIT)?;
    let theirs = merge_text(bytes, truncated)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        &connection.port,
        &connection.user,
        &connection.client,
        &local,
        &preview,
        &meta,
        &base,
        &yours,
        &theirs,
    )
        .hash(&mut hash);
    Ok((
        P4ManualResolve {
            base,
            yours,
            theirs,
            fingerprint: format!("{:016x}", hash.finish()),
        },
        local,
    ))
}

pub fn manual_resolve_view(connection: &P4Connection, path: &str) -> AppResult<P4ManualResolve> {
    manual_resolve_snapshot(connection, path).map(|(view, _)| view)
}

pub fn manual_resolve_apply(
    connection: &P4Connection,
    path: &str,
    text: &str,
    fingerprint: &str,
) -> AppResult<()> {
    use std::io::Write;
    merge_text(text.as_bytes().to_vec(), false)?;
    if text.lines().any(|line| {
        line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>") || line.starts_with("|||||||")
    }) {
        return Err(AppError::msg("Remove conflict markers before resolving."));
    }
    let (current, local) = manual_resolve_snapshot(connection, path)?;
    if current.fingerprint != fingerprint {
        return Err(AppError::msg(
            "The operation or workspace changed. Preview it again before applying.",
        ));
    }
    let mut result = tempfile::NamedTempFile::new_in(local.parent().unwrap())?;
    result
        .as_file()
        .set_permissions(fs::metadata(&local)?.permissions())?;
    result.write_all(text.as_bytes())?;
    result.flush()?;
    #[cfg(windows)]
    let original_permissions = fs::metadata(&local)?.permissions();
    #[cfg(windows)]
    if original_permissions.readonly() {
        let mut writable = original_permissions.clone();
        #[allow(
            clippy::permissions_set_readonly_false,
            reason = "This Windows-only branch clears a DOS attribute, not Unix permission bits"
        )]
        writable.set_readonly(false);
        fs::set_permissions(&local, writable)?;
    }
    if let Err(error) = result.persist(&local) {
        #[cfg(windows)]
        let _ = fs::set_permissions(&local, original_permissions);
        return Err(AppError::msg(error.to_string()));
    }
    // The edited workspace file is now the chosen result. Never submit it here.
    resolve_accept(connection, path, "yours")
}

pub fn manual_resolve_external(
    connection: &P4Connection,
    path: &str,
    text: &str,
    fingerprint: &str,
    tool: &str,
) -> AppResult<String> {
    let (view, _) = manual_resolve_snapshot(connection, path)?;
    if view.fingerprint != fingerprint {
        return Err(AppError::msg(
            "The operation or workspace changed. Preview it again before applying.",
        ));
    }
    merge_text(text.as_bytes().to_vec(), false)?;
    let directory = tempfile::tempdir()?;
    let base = directory.path().join("base.txt");
    let yours = directory.path().join("yours.txt");
    let theirs = directory.path().join("theirs.txt");
    let result = directory.path().join("result.txt");
    fs::write(&base, &view.base)?;
    fs::write(&yours, &view.yours)?;
    fs::write(&theirs, &view.theirs)?;
    fs::write(&result, text)?;
    crate::git::merge_files_external(tool, directory.path(), &base, &yours, &theirs, &result)?;
    let result = merge_text(
        std::io::BufReader::new(fs::File::open(result)?)
            .take((MANUAL_MERGE_LIMIT + 1) as u64)
            .bytes()
            .collect::<Result<Vec<_>, _>>()?,
        false,
    )?;
    if manual_resolve_snapshot(connection, path)?.0.fingerprint != fingerprint {
        return Err(AppError::msg(
            "The operation or workspace changed. Preview it again before applying.",
        ));
    }
    Ok(result)
}

struct ResolveFacts {
    depot: String,
    action: String,
    kind: String,
    from_file: String,
    start_rev: String,
    end_rev: String,
    base_file: String,
    base_rev: String,
    shelved_change: String,
}

fn pending_resolve_facts(text: &str, depot: &str) -> Option<(ResolveFacts, usize)> {
    let mut records = parse_ztag(text)
        .into_iter()
        .filter(|record| record.contains_key("clientFile") && record.contains_key("resolveType"));
    if let Some(record) = records.next() {
        let action = field(&record, "resolveType");
        let content_kind = field(&record, "contentResolveType");
        let kind = if content_kind.is_empty() {
            action.clone()
        } else {
            content_kind
        };
        let facts = ResolveFacts {
            depot: depot.to_string(),
            action,
            kind,
            from_file: field(&record, "fromFile"),
            start_rev: field(&record, "startFromRev"),
            end_rev: field(&record, "endFromRev"),
            base_file: field(&record, "baseFile"),
            base_rev: field(&record, "baseRev"),
            shelved_change: field(&record, "shelvedChange"),
        };
        return Some((facts, 1 + records.count()));
    }
    let mut facts = parse_resolve_preview(text)?;
    facts.depot = depot.to_string();
    let count = text.lines().filter(|line| line.contains(" - ")).count();
    Some((facts, count))
}

fn parse_resolve_preview(text: &str) -> Option<ResolveFacts> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| line.contains(" - "))?;
    let (path, rest) = line.split_once(" - ")?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let lower = rest.to_lowercase();
    let (action, kind) = if lower.contains("delete") {
        ("delete", "delete")
    } else if lower.contains("branch") || lower.contains("copy") {
        ("branch", "branch")
    } else if lower.contains("move") || lower.contains("rename") {
        ("move", "move")
    } else if lower.contains("filetype") || lower.contains("type change") {
        ("filetype", "filetype")
    } else {
        ("merge", "content")
    };
    let specs = depot_revs(rest);
    let (from_file, start_rev, end_rev) = specs
        .first()
        .cloned()
        .unwrap_or_else(|| (String::new(), String::new(), String::new()));
    let (base_file, _, base_rev) = if lower.contains("using base") {
        specs
            .get(1)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new(), String::new()))
    } else {
        (String::new(), String::new(), String::new())
    };
    Some(ResolveFacts {
        depot: path.to_string(),
        action: action.to_string(),
        kind: kind.to_string(),
        from_file,
        start_rev,
        end_rev,
        base_file,
        base_rev,
        shelved_change: String::new(),
    })
}

fn depot_revs(text: &str) -> Vec<(String, String, String)> {
    let mut specs = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'/' && bytes[index + 1] == b'/' {
            let start = index;
            index += 2;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'#'
            {
                index += 1;
            }
            let file = text[start..index].to_string();
            if index < bytes.len() && bytes[index] == b'#' {
                index += 1;
                let rev_start = index;
                while index < bytes.len() && bytes[index].is_ascii_digit() {
                    index += 1;
                }
                let first = text[rev_start..index].to_string();
                if index + 1 < bytes.len() && bytes[index] == b',' && bytes[index + 1] == b'#' {
                    index += 2;
                    let rev_start = index;
                    while index < bytes.len() && bytes[index].is_ascii_digit() {
                        index += 1;
                    }
                    specs.push((file, first, text[rev_start..index].to_string()));
                } else {
                    specs.push((file, String::new(), first));
                }
            } else if !file.is_empty() {
                specs.push((file, String::new(), String::new()));
            }
        } else {
            index += 1;
        }
    }
    specs
}

fn resolve_summary(facts: &ResolveFacts) -> String {
    let source = if facts.shelved_change.parse::<u64>().unwrap_or(0) > 0 {
        incoming_resolve_spec(facts)
    } else {
        revision_span(&facts.from_file, &facts.start_rev, &facts.end_rev)
    };
    if source.is_empty() {
        return "Needs resolve".to_string();
    }
    let action = facts.action.to_lowercase();
    let kind = facts.kind.to_lowercase();
    let verb = if kind.contains("delete") || action == "delete" {
        "Deleting"
    } else if kind.contains("branch") || action == "branch" || action == "copy" {
        "Branching"
    } else if kind.contains("move") || action.contains("move") {
        "Moving"
    } else if kind.contains("filetype") || kind.contains("type") {
        "Changing type from"
    } else {
        "Merging"
    };
    let mut text = format!("{verb} {source}");
    if verb == "Merging" && !facts.base_file.is_empty() {
        text.push_str(" using base ");
        text.push_str(&revision_span(&facts.base_file, "", &facts.base_rev));
    }
    text
}

fn revision_span(file: &str, start: &str, end: &str) -> String {
    if file.is_empty() {
        return String::new();
    }
    if end.is_empty() {
        return if start.is_empty() {
            file.to_string()
        } else {
            format!("{file}#{start}")
        };
    }
    if start.is_empty() || start == end {
        format!("{file}#{end}")
    } else {
        format!("{file}#{start},#{end}")
    }
}

fn resolve_can_merge(action: &str, kind: &str) -> bool {
    let action = action.to_lowercase();
    let kind = kind.to_lowercase();
    if kind.contains("binary") || kind.contains("delete") || action == "delete" {
        return false;
    }
    kind.contains("content") || action == "content" || action == "merge" || action == "edit"
}

fn incoming_resolve_spec(facts: &ResolveFacts) -> String {
    if facts.shelved_change.parse::<u64>().unwrap_or(0) > 0 {
        format!("{}@={}", facts.from_file, facts.shelved_change)
    } else {
        let revision = if facts.end_rev.is_empty() {
            &facts.start_rev
        } else {
            &facts.end_rev
        };
        format!("{}#{revision}", facts.from_file)
    }
}

fn merge_preview_is_clean(text: &str) -> bool {
    let mut found = false;
    for line in text.lines().filter(|line| line.contains("Diff chunks:")) {
        let Some((_, conflicts)) = line.rsplit_once(" + ") else {
            return false;
        };
        let Some(count) = conflicts.trim().strip_suffix(" conflicting") else {
            return false;
        };
        if count.parse::<usize>() != Ok(0) {
            return false;
        }
        found = true;
    }
    found
}

fn auto_merge_available(env: &P4Env, spec: &str) -> bool {
    // Build the native merge preview, then skip without accepting or changing the file.
    cli::run_p4(env, &["resolve", "-o", spec], Some("s\n"))
        .map(|output| merge_preview_is_clean(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or(false)
}

fn resolve_diff(env: &P4Env, facts: &ResolveFacts) -> (FileDiff, bool, bool) {
    let depot = facts.depot.clone();
    let end = if facts.end_rev.is_empty() {
        facts.start_rev.clone()
    } else {
        facts.end_rev.clone()
    };
    if !depot.starts_with("//") || facts.from_file.is_empty() || end.is_empty() {
        return (empty_diff(&depot), false, false);
    }
    let incoming = incoming_resolve_spec(facts);
    if depot == facts.from_file {
        if let Ok(text) = cli::run_p4_diff(env, &["diff", "-du", "-f", &incoming]) {
            return (parse_single_diff(&text, &depot), true, true);
        }
    }
    let have = format!("{depot}#have");
    match cli::run_p4_diff(env, &["diff2", "-du", &have, &incoming]) {
        Ok(text) => (parse_single_diff(&text, &depot), true, false),
        Err(_) => (empty_diff(&depot), false, false),
    }
}

fn resolve_still_open(env: &P4Env, path: &str) -> AppResult<bool> {
    match run_ok(env, &["resolve", "-n", path], None) {
        Ok(text) => Ok(text.lines().any(|line| !line.trim().is_empty())),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no file") {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolve_summary_names_the_pending_source_and_base() {
        let tagged = "\
... clientFile /fixture/main/app.ini
... fromFile //depot/dev/app.ini
... startFromRev 4
... endFromRev 7
... baseFile //depot/dev/app.ini
... baseRev 3
... resolveType content
... contentResolveType 3waytext

... clientFile /fixture/main/app.ini
... fromFile //depot/dev/app.ini
... endFromRev 8
... resolveType filetype
";
        let (facts, count) = pending_resolve_facts(tagged, "//depot/main/app.ini").unwrap();
        assert_eq!(count, 2);
        assert_eq!(facts.depot, "//depot/main/app.ini");
        assert!(resolve_can_merge(&facts.action, &facts.kind));
        assert_eq!(
            resolve_summary(&facts),
            "Merging //depot/dev/app.ini#4,#7 using base //depot/dev/app.ini#3"
        );
        assert!(pending_resolve_facts("", "//depot/main/app.ini").is_none());
    }

    #[test]
    fn auto_merge_requires_native_conflict_statistics() {
        assert!(merge_preview_is_clean(
            "Diff chunks: 1 yours + 2 theirs + 0 both + 0 conflicting\nresolve skipped.\n"
        ));
        assert!(!merge_preview_is_clean(
            "Diff chunks: 0 yours + 0 theirs + 0 both + 1 conflicting\n"
        ));
        assert!(!merge_preview_is_clean(
            "Diff chunks: 1 yours + invalid conflicting\n"
        ));
        assert!(!merge_preview_is_clean("No file(s) to resolve.\n"));
        assert!(!merge_preview_is_clean("Diff chunks: 1 yours + 0 theirs + 0 both + 0 conflicting\nDiff chunks: 0 yours + 0 theirs + 0 both + 2 conflicting"));
    }

    #[test]
    fn shelf_resolves_read_the_incoming_shelf_instead_of_the_depot_base() {
        let tagged = "... clientFile /fixture/main/app.ini\n... fromFile //depot/main/app.ini\n... startFromRev none\n... endFromRev 4\n... shelvedChange 123\n... baseFile //depot/main/app.ini\n... baseRev 4\n... resolveType content\n... contentResolveType 3waytext\n";
        let (mut facts, count) = pending_resolve_facts(tagged, "//depot/main/app.ini").unwrap();
        assert_eq!(count, 1);
        assert_eq!(incoming_resolve_spec(&facts), "//depot/main/app.ini@=123");
        assert_eq!(
            resolve_summary(&facts),
            "Merging //depot/main/app.ini@=123 using base //depot/main/app.ini#4"
        );
        facts.shelved_change = String::new();
        assert_eq!(incoming_resolve_spec(&facts), "//depot/main/app.ini#4");
    }

    #[test]
    fn a_delete_resolve_cannot_merge() {
        let facts =
            parse_resolve_preview("//depot/main/Old.ini - delete from //depot/dev/Old.ini#1,#2")
                .unwrap();
        assert_eq!(facts.action, "delete");
        assert!(!resolve_can_merge(&facts.action, &facts.kind));
        assert_eq!(resolve_summary(&facts), "Deleting //depot/dev/Old.ini#1,#2");
    }
}
