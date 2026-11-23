//! Perforce workspace commands.
//!
//! A workspace is a client: a server, a user, and a view mapped onto a local
//! root. History lives on the server, so reads go through `p4` rather than a
//! local commit graph.

mod browse;
pub(super) use browse::annotate_pending;
use browse::{
    annotate_ignored, annotate_paths, clear_versioned_ignores, generated_dir,
    include_search_parents, local_path_key, plain_dir,
};
pub use browse::{cancel_depot_search, list_depot, list_dir, listing_status, search_depot};
mod opened_diff;
pub use opened_diff::{opened_diff, P4OpenedDiff};
mod resolve;
pub(super) use resolve::resolve_file_versions;
pub use resolve::{
    manual_resolve_apply, manual_resolve_external, manual_resolve_view, resolve_accept,
    resolve_view, P4ManualResolve, P4ResolveView,
};
mod sync;
use sync::file_at;
pub use sync::{get_revision, revision_targets, sync, P4GetRevision, P4SyncResult, RevisionOutput};
mod search;
pub use search::WorkspaceSearch;

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::git::{strip_verbatim_prefix, FileDiff};
use crate::p4::cli::{self, P4Env};
use crate::p4::parse::{
    blank_change_spec, classic_client_spec, created_change_id, file_type_is_binary, indexed_groups,
    known_p4_value, normalize_charset, parse_p4_set, parse_p4config, parse_single_diff, parse_ztag,
    path_depth, path_is_within, read_description, set_description, set_spec_field, spec_field,
    valid_client_name, valid_depot_path, ZtagRecord,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Auth {
    pub port: String,
    pub user: String,
    pub password: String,
    pub charset: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ClientOption {
    pub name: String,
    pub root: String,
    pub stream: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamOption {
    pub parent: String,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4DepotEntry {
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CheckedConnection {
    pub server: String,
    pub clients: Vec<P4ClientOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Connection {
    pub root: String,
    pub port: String,
    pub user: String,
    pub client: String,
    pub charset: String,
    pub stream: Option<String>,
    pub server: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4File {
    pub depot_path: String,
    pub local_path: String,
    pub action: String,
    pub rev: String,
    pub shelved: bool,
    pub binary: bool,
    /// Workspace icon state: current, stale, conflict, edit, clean, add, delete, integrate, other, local.
    pub status: String,
    /// Sentence shown in the file tooltip.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4StreamChange {
    pub path: String,
    pub base_change: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Changelist {
    pub id: String,
    pub user: String,
    pub client: String,
    pub status: String,
    pub description: String,
    pub time: i64,
    pub shelved: bool,
    pub files: Vec<P4File>,
    pub stream: Option<P4StreamChange>,
    pub shelved_stream: Option<P4StreamChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum P4Open {
    Ready {
        connection: P4Connection,
        pending: Vec<P4Changelist>,
    },
    Login {
        connection: P4Connection,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoDetection {
    Git {
        path: String,
    },
    Perforce {
        connection: P4Connection,
    },
    Ambiguous {
        path: String,
        git_path: String,
        connection: P4Connection,
    },
    None {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4ChangePage {
    pub changes: Vec<P4Changelist>,
    pub has_more: bool,
    /// Oldest change number this page already considered. The next page starts before it.
    pub scanned_through: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4PathHistoryRequest {
    pub user: String,
    pub client: String,
    pub query: String,
    pub before: Option<i64>,
    pub limit: usize,
    pub scan_limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4FileSearch {
    pub hits: Vec<P4DirEntry>,
    pub truncated: bool,
    /// Depot search tells the user which path was scanned. Empty for a workspace search.
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Describe {
    pub change: P4Changelist,
    pub diffs: Vec<FileDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Revision {
    pub depot_path: String,
    pub rev: String,
    pub change: String,
    pub action: String,
    pub user: String,
    pub time: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4DirEntry {
    pub ignored: bool,
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Empty, or current, stale, edit, add, delete, integrate, other, local.
    pub status: String,
    /// Sentence shown when the file icon is hovered.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4EntryStatus {
    pub path: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4CreateRequest {
    pub port: String,
    pub user: String,
    pub password: String,
    pub client: String,
    pub root: String,
    pub stream: String,
    pub depot_path: String,
    pub charset: String,
}

struct ConfigFile {
    directory: PathBuf,
    filename: String,
    values: BTreeMap<String, String>,
}

pub fn detect_repository(path: &str) -> AppResult<RepoDetection> {
    let start = existing_dir(path)?;
    let git = git_root(&start)?;
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let p4 = match p4_connection_with(
        &start,
        find_config(&start),
        cli::active_p4().is_some(),
        |env, args| cli::run_p4_probe(env, args, deadline),
    ) {
        Ok(value) => value,
        Err(AppError::P4Missing) if git.is_some() => None,
        Err(err) => return Err(err),
    };
    let selected = start.to_string_lossy().into_owned();
    match (git, p4) {
        (Some(git_path), Some(connection)) => pick_closer(&start, selected, git_path, connection),
        (Some(git_path), None) => Ok(RepoDetection::Git { path: git_path }),
        (None, Some(connection)) => Ok(RepoDetection::Perforce { connection }),
        (None, None) => Ok(RepoDetection::None { path: selected }),
    }
}

fn pick_closer(
    start: &Path,
    selected: String,
    git_path: String,
    connection: P4Connection,
) -> AppResult<RepoDetection> {
    let git_depth = path_depth(Path::new(&git_path), start);
    let p4_depth = path_depth(Path::new(&connection.root), start);
    Ok(match (git_depth, p4_depth) {
        (Some(git_depth), Some(p4_depth)) if git_depth < p4_depth => {
            RepoDetection::Git { path: git_path }
        }
        (Some(git_depth), Some(p4_depth)) if p4_depth < git_depth => {
            RepoDetection::Perforce { connection }
        }
        (Some(_), Some(_)) => RepoDetection::Ambiguous {
            path: selected,
            git_path,
            connection,
        },
        (Some(_), None) => RepoDetection::Git { path: git_path },
        (None, Some(_)) => RepoDetection::Perforce { connection },
        (None, None) => RepoDetection::None { path: selected },
    })
}

pub fn open_workspace(path: &str) -> AppResult<P4Open> {
    let start = existing_dir(path)?;
    let Some(connection) = p4_connection(&start)? else {
        return Err(AppError::msg(format!(
            "No Perforce workspace found at {}",
            start.to_string_lossy()
        )));
    };
    match load_pending(&connection) {
        Ok(pending) => Ok(P4Open::Ready {
            connection,
            pending,
        }),
        Err(AppError::P4Login) => Ok(P4Open::Login { connection }),
        Err(err) => Err(err),
    }
}

pub fn refresh_pending(connection: &P4Connection) -> AppResult<Vec<P4Changelist>> {
    load_pending(connection)
}

pub fn submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    limit: usize,
    before: Option<i64>,
) -> AppResult<P4ChangePage> {
    let env = env_for(connection);
    let limit = limit.clamp(1, 200);
    let user = optional_name(user)?;
    let client = optional_name(client)?;
    let mut args = vec![
        "-ztag".to_string(),
        "changes".into(),
        "-s".into(),
        "submitted".into(),
        "-m".into(),
        limit.to_string(),
        "-L".into(),
    ];
    if let Some(user) = &user {
        args.push("-u".into());
        args.push(user.clone());
    }
    if let Some(client) = &client {
        args.push("-c".into());
        args.push(client.clone());
    }
    // A user or workspace already scopes the query. A depot path on top of that
    // hides this client's own submits when the stream view does not match them.
    // Query the changelist index directly: stream filters are not available on
    // every server, and depot-path filters depend on mapped file revisions.
    push_history_range(&mut args, before);
    let stdout = run_owned(&env, &args, None)?;
    Ok(change_page(&stdout, limit))
}

fn change_page(stdout: &str, limit: usize) -> P4ChangePage {
    let mut changes = Vec::new();
    for record in parse_ztag(stdout) {
        changes.push(change_from_record(&record, Vec::new(), false));
    }
    let has_more = changes.len() >= limit;
    let scanned_through = changes
        .iter()
        .rev()
        .find_map(|change| change.id.parse::<i64>().ok());
    P4ChangePage {
        changes,
        has_more,
        scanned_through,
    }
}

fn directory_history_spec(connection: &P4Connection, path: &str) -> AppResult<String> {
    if path == "//" {
        return Ok("//...".into());
    }
    let path = workspace_cli_path(&connection.root, path);
    if path.starts_with("//") {
        if !valid_depot_path(&path)
            || path.contains("...")
            || path.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err(AppError::msg("Choose one depot directory."));
        }
    } else {
        workspace_directory(Path::new(&connection.root), &path)?;
    }
    revision_file_spec(&connection.root, &path, true, "")
}

pub fn path_history(
    connection: &P4Connection,
    path: &str,
    request: &P4PathHistoryRequest,
) -> AppResult<P4ChangePage> {
    path_history_with(connection, path, request, |env, args| {
        run_owned(env, args, None)
    })
}

fn path_history_with(
    connection: &P4Connection,
    path: &str,
    request: &P4PathHistoryRequest,
    mut run: impl FnMut(&P4Env, &[String]) -> AppResult<String>,
) -> AppResult<P4ChangePage> {
    let scope = directory_history_spec(connection, path)?;
    let user = optional_name(&request.user)?;
    let client = optional_name(&request.client)?;
    let env = env_for(connection);
    let mut load = |limit: usize, before: Option<i64>| {
        if before.is_some_and(|number| number <= 1) {
            return Ok(change_page("", limit));
        }
        let mut args = vec![
            "-ztag".into(),
            "changes".into(),
            "-s".into(),
            "submitted".into(),
            "-m".into(),
            limit.to_string(),
            "-L".into(),
        ];
        for (flag, value) in [("-u", &user), ("-c", &client)] {
            if let Some(value) = value {
                args.extend([flag.into(), value.clone()]);
            }
        }
        args.push(match before {
            Some(number) => format!("{scope}@1,@{}", number - 1),
            None => scope.clone(),
        });
        let output = match run(&env, &args) {
            Err(error) if error.to_string().to_lowercase().contains("no such file") => {
                String::new()
            }
            other => other?,
        };
        Ok(change_page(&output, limit))
    };
    if request.query.trim().is_empty() {
        return load(request.limit.clamp(1, 200), request.before);
    }
    scan_submitted(
        &request.query,
        request.before,
        request.limit,
        request.scan_limit,
        Vec::new(),
        load,
    )
}

pub fn search_submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    query: &str,
    before: Option<i64>,
    match_limit: usize,
    scan_limit: usize,
) -> AppResult<P4ChangePage> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return submitted(connection, user, client, match_limit, before);
    }
    let mut matches = Vec::new();
    if before.is_none()
        && needle.chars().all(|ch| ch.is_ascii_digit())
        && needle
            .parse::<i64>()
            .is_ok_and(|id| id.to_string() == needle)
    {
        if let Ok(id) = needle.parse::<i64>() {
            if let Some(change) = exact_submitted(connection, user, client, id)? {
                matches.push(change);
            }
        }
    }
    scan_submitted(
        &needle,
        before,
        match_limit,
        scan_limit,
        matches,
        |limit, cursor| submitted(connection, user, client, limit, cursor),
    )
}

fn scan_submitted(
    query: &str,
    before: Option<i64>,
    match_limit: usize,
    scan_limit: usize,
    mut matches: Vec<P4Changelist>,
    mut load: impl FnMut(usize, Option<i64>) -> AppResult<P4ChangePage>,
) -> AppResult<P4ChangePage> {
    let needle = query.trim().to_lowercase();
    let match_limit = match_limit.clamp(1, 100);
    let scan_limit = scan_limit.clamp(1, 2_000);
    let mut cursor = before;
    let mut scanned = 0usize;
    let mut has_more = false;
    'pages: loop {
        if matches.len() >= match_limit || scanned >= scan_limit {
            has_more = true;
            break;
        }
        let batch = load(80, cursor)?;
        if batch.changes.is_empty() {
            break;
        }
        for (index, change) in batch.changes.iter().enumerate() {
            if let Ok(number) = change.id.parse::<i64>() {
                cursor = Some(number);
            }
            scanned += 1;
            if change_matches(change, &needle) && !matches.iter().any(|item| item.id == change.id) {
                matches.push(change.clone());
            }
            if matches.len() >= match_limit || scanned >= scan_limit {
                has_more = index + 1 < batch.changes.len() || batch.has_more;
                break 'pages;
            }
        }
        if !batch.has_more {
            break;
        }
    }
    Ok(P4ChangePage {
        changes: matches,
        has_more,
        scanned_through: cursor,
    })
}

fn change_matches(change: &P4Changelist, needle: &str) -> bool {
    change.id.to_lowercase().contains(needle)
        || change.user.to_lowercase().contains(needle)
        || change.description.to_lowercase().contains(needle)
}

fn exact_submitted(
    connection: &P4Connection,
    user: &str,
    client: &str,
    id: i64,
) -> AppResult<Option<P4Changelist>> {
    if id <= 0 {
        return Ok(None);
    }
    let env = env_for(connection);
    let user = optional_name(user)?;
    let client = optional_name(client)?;
    let mut args = vec![
        "-ztag".to_string(),
        "changes".into(),
        "-s".into(),
        "submitted".into(),
        "-m".into(),
        "1".into(),
        "-L".into(),
    ];
    if let Some(user) = &user {
        args.push("-u".into());
        args.push(user.clone());
    }
    if let Some(client) = &client {
        args.push("-c".into());
        args.push(client.clone());
    }
    args.push(format!("@{id},{id}"));
    let stdout = run_owned(&env, &args, None)?;
    Ok(parse_ztag(&stdout)
        .into_iter()
        .map(|record| change_from_record(&record, Vec::new(), false))
        .find(|change| change.id == id.to_string()))
}

pub fn describe(connection: &P4Connection, change_id: &str) -> AppResult<P4Describe> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    // File names only. A full `describe -du` pulls every diff in the changelist
    // before the list can paint, which stalls large submits. Each file's diff
    // is loaded on its own when that file is selected.
    let meta = run_ok(&env, &["-ztag", "describe", "-s", &id], None)?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    let files = files_from_groups(connection, &indexed_groups(&record), false);
    Ok(P4Describe {
        change: change_from_record(&record, files, false),
        diffs: Vec::new(),
    })
}

pub fn shelf_diff(
    connection: &P4Connection,
    depot_path: &str,
    change_id: &str,
) -> AppResult<FileDiff> {
    let id = require_numbered(change_id)?;
    if !depot_path.starts_with("//") {
        return Err(AppError::msg("Shelf diff needs a depot path."));
    }
    let env = env_for(connection);

    let shelf = format!("{depot_path}@={id}");
    let meta = run_ok(&env, &["-ztag", "files", &shelf], None)?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    let base = field(&record, "rev");
    let have = format!("{depot_path}#{base}");
    let action = field(&record, "action");
    let deleted = action == "delete" || action == "move/delete";
    if deleted || action == "add" || action == "move/add" {
        let spec = if deleted { &have } else { &shelf };
        return printed_file_diff(
            &env,
            depot_path,
            spec,
            file_type_is_binary(&field(&record, "type")),
            deleted,
        );
    }
    let text = cli::run_p4_diff(&env, &["diff2", "-du", &have, &shelf])?;
    Ok(parse_single_diff(&text, depot_path))
}

pub fn revision_diff(connection: &P4Connection, path: &str, rev: &str) -> AppResult<FileDiff> {
    use super::history::{
        compare_files, exact_depot, mapped_local, revision_number, P4CompareRequest, P4Comparison,
        P4FileVersion,
    };
    let number = revision_number(rev)?;
    if number == 0 {
        return Err(AppError::msg(
            "Enter a positive revision or changelist number.",
        ));
    }
    let depot = if path.starts_with("//") {
        exact_depot(path)?;
        path.to_string()
    } else {
        mapped_local(connection, path)?.0
    };
    let request = P4CompareRequest {
        path: path.to_string(),
        base: P4FileVersion::Revision {
            depot_path: depot.clone(),
            revision: (number - 1).to_string(),
        },
        head: P4FileVersion::Revision {
            depot_path: depot,
            revision: number.to_string(),
        },
    };
    match compare_files(connection, &request)? {
        P4Comparison::Diff { diff } => Ok(diff),
        P4Comparison::Text { .. } => {
            Err(AppError::msg("The selected file revision is unavailable."))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P4HistoryCursor {
    pub depot_path: String,
    pub before_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4RevisionPage {
    pub revisions: Vec<P4Revision>,
    pub next: Option<P4HistoryCursor>,
}

pub fn filelog(
    connection: &P4Connection,
    path: &str,
    cursor: Option<&P4HistoryCursor>,
) -> AppResult<P4RevisionPage> {
    let env = env_for(connection);
    let spec = if let Some(cursor) = cursor {
        if !cursor.depot_path.starts_with("//")
            || !valid_depot_path(&cursor.depot_path)
            || cursor.depot_path.contains(['*', '#', '@'])
            || cursor.depot_path.contains("...")
        {
            return Err(AppError::msg(
                "Choose one depot file without wildcards or revision suffixes.",
            ));
        }
        if cursor.before_revision <= 1 {
            return Ok(P4RevisionPage {
                revisions: Vec::new(),
                next: None,
            });
        }
        format!("{}#1,#{}", cursor.depot_path, cursor.before_revision - 1)
    } else {
        workspace_file_spec(&connection.root, path)
    };
    if spec.contains("...") || spec.contains('*') {
        return Err(AppError::msg(
            "Choose one depot file without wildcards or revision suffixes.",
        ));
    }
    let stdout = run_ok(
        &env,
        &["-ztag", "filelog", "-m", "51", "-l", "-t", &spec],
        None,
    )?;
    Ok(revision_page(&stdout))
}

fn revision_page(stdout: &str) -> P4RevisionPage {
    let mut revisions = Vec::new();
    for record in parse_ztag(stdout) {
        let depot_path = field(&record, "depotFile");
        if depot_path.is_empty() {
            continue;
        }
        for group in indexed_groups(&record) {
            let rev = field(&group, "rev");
            if rev
                .parse::<u64>()
                .ok()
                .filter(|number| *number > 0)
                .is_none()
            {
                continue;
            }
            revisions.push(P4Revision {
                depot_path: depot_path.clone(),
                rev,
                change: field(&group, "change"),
                action: field(&group, "action"),
                user: field(&group, "user"),
                time: field_i64(&group, "time"),
                description: clean_description(&field(&group, "desc")),
            });
            if revisions.len() == 51 {
                break;
            }
        }
        if revisions.len() == 51 {
            break;
        }
    }
    let next = revisions.get(50).and_then(|revision| {
        Some(P4HistoryCursor {
            depot_path: revision.depot_path.clone(),
            before_revision: revision.rev.parse::<u64>().ok()?.checked_add(1)?,
        })
    });
    revisions.truncate(50);
    P4RevisionPage { revisions, next }
}

fn workspace_directory(root: &Path, directory: &str) -> AppResult<PathBuf> {
    let directory = PathBuf::from(strip_verbatim_prefix(directory.trim()));
    workspace_directory_path(root, directory)
}

pub(super) fn workspace_directory_path(root: &Path, directory: PathBuf) -> AppResult<PathBuf> {
    let dir = if directory.as_os_str().is_empty() {
        root.to_path_buf()
    } else if directory.is_absolute() {
        directory
    } else {
        root.join(directory)
    };
    if !path_is_within(root, &dir) {
        return Err(AppError::msg("Path is outside the workspace."));
    }
    if !dir.is_dir() {
        return Err(AppError::msg("Folder not found."));
    }
    if !path_is_within(&fs::canonicalize(root)?, &fs::canonicalize(&dir)?) {
        return Err(AppError::msg("Path is outside the workspace."));
    }
    Ok(dir)
}

pub fn submit(connection: &P4Connection, change_id: &str, description: &str) -> AppResult<()> {
    require_description(description)?;
    let env = env_for(connection);
    let (spec, fix_statuses) = change_spec(&env, change_id)?;
    let spec = set_description(&spec, description);
    let args: &[&str] = if fix_statuses {
        &["submit", "-s", "-i"]
    } else {
        &["submit", "-i"]
    };
    run_ok(&env, args, Some(&spec))?;
    Ok(())
}

pub fn save_change(
    connection: &P4Connection,
    change_id: &str,
    description: &str,
) -> AppResult<String> {
    require_description(description)?;
    let env = env_for(connection);
    let (spec, fix_statuses) = change_spec(&env, change_id)?;
    let spec = set_description(&spec, description);
    let args: &[&str] = if fix_statuses {
        &["change", "-s", "-i"]
    } else {
        &["change", "-i"]
    };
    let output = run_ok(&env, args, Some(&spec))?;
    Ok(created_change_id(&output).unwrap_or_else(|| change_id.to_string()))
}

pub fn new_change(connection: &P4Connection, description: &str) -> AppResult<String> {
    require_description(description)?;
    let env = env_for(connection);
    let spec = blank_change_spec(&connection.client, &connection.user, description);
    let output = run_ok(&env, &["change", "-i"], Some(&spec))?;
    created_change_id(&output).ok_or_else(|| AppError::msg(output.trim().to_string()))
}

pub fn delete_change(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let env = env_for(connection);
    delete_change_with(connection, change_id, |args| run_ok(&env, args, None))
}

fn delete_change_with(
    connection: &P4Connection,
    change_id: &str,
    mut run: impl FnMut(&[&str]) -> AppResult<String>,
) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    if id.parse::<i64>().unwrap_or(0) <= 0 {
        return Err(AppError::msg("Choose a numbered changelist."));
    }
    let spec = run(&["change", "-o", &id])?;
    if spec_field(&spec, "Status") != "pending"
        || spec_field(&spec, "Client") != connection.client
        || spec_field(&spec, "User") != connection.user
    {
        return Err(AppError::msg(
            "Choose your own pending changelist in this workspace.",
        ));
    }
    if !spec_field(&spec, "Stream").is_empty() {
        return Err(AppError::msg(
            "Submit or revert the opened stream definition first.",
        ));
    }
    // The server atomically refuses a changelist with opened files or a shelf.
    run(&["change", "-d", &id])?;
    Ok(())
}

pub fn reopen(connection: &P4Connection, change_id: &str, files: &[String]) -> AppResult<()> {
    if files.is_empty() {
        return Ok(());
    }
    let target = if change_id == "default" {
        "default"
    } else {
        change_id
    };
    let env = env_for(connection);
    let mut args = vec!["reopen".to_string(), "-c".into(), target.into()];
    args.extend(
        files
            .iter()
            .map(|path| workspace_file_spec(&connection.root, path)),
    );
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn revert(connection: &P4Connection, files: &[String], wipe: &[String]) -> AppResult<()> {
    if files.is_empty() && wipe.is_empty() {
        return Err(AppError::msg("Choose a file to revert."));
    }
    let env = env_for(connection);
    revert_with(&env, files, false)?;
    revert_with(&env, wipe, true)?;
    Ok(())
}

fn revert_with(env: &P4Env, files: &[String], wipe: bool) -> AppResult<()> {
    if files.is_empty() {
        return Ok(());
    }
    let mut args = vec!["revert".to_string()];
    if wipe {
        args.push("-w".into());
    }
    args.extend(
        files
            .iter()
            .map(|path| workspace_file_spec(&env.cwd.to_string_lossy(), path)),
    );
    run_owned(env, &args, None)?;
    Ok(())
}

pub fn revert_unchanged(
    connection: &P4Connection,
    change_id: Option<&str>,
    paths: &[String],
) -> AppResult<()> {
    let env = env_for(connection);
    let args = revert_unchanged_args(connection, change_id, paths)?;
    run_owned(&env, &args, None)?;
    Ok(())
}

fn revert_unchanged_args(
    connection: &P4Connection,
    change_id: Option<&str>,
    paths: &[String],
) -> AppResult<Vec<String>> {
    let mut args = vec!["revert".into(), "-a".into()];
    if let Some(change) = change_id {
        let id = if change == "default" {
            change.to_string()
        } else {
            require_numbered(change)?
        };
        args.extend(["-c".into(), id]);
    }
    if paths.is_empty() {
        if !valid_client_name(&connection.client) {
            return Err(AppError::msg("Choose a workspace."));
        }
        args.push(format!("//{}/...", connection.client));
    } else {
        if paths.iter().any(|path| path.trim().is_empty()) {
            return Err(AppError::msg("Choose files to revert."));
        }
        args.extend(
            paths
                .iter()
                .map(|path| workspace_file_spec(&connection.root, path)),
        );
    }
    Ok(args)
}

pub fn submit_shelf(
    connection: &P4Connection,
    change_id: &str,
    description: &str,
) -> AppResult<()> {
    require_description(description)?;
    let id = require_numbered(change_id)?;
    let pending = refresh_pending(connection)?;
    let change = pending
        .iter()
        .find(|change| change.id == id)
        .ok_or_else(|| {
            AppError::msg("Choose your own pending shelved changelist in this workspace.")
        })?;
    validate_shelf_submission(connection, change)?;
    save_change(connection, &id, description)?;
    run_ok(&env_for(connection), &["submit", "-e", &id], None)?;
    Ok(())
}

fn validate_shelf_submission(connection: &P4Connection, change: &P4Changelist) -> AppResult<()> {
    if change.user != connection.user
        || change.client != connection.client
        || change.status != "pending"
        || !change.shelved
    {
        return Err(AppError::msg(
            "Choose your own pending shelved changelist in this workspace.",
        ));
    }
    if change.files.iter().any(|file| !file.shelved) || change.stream.is_some() {
        return Err(AppError::msg(
            "Move or revert the opened changes in this changelist before submitting its shelf.",
        ));
    }
    Ok(())
}

pub fn shelve(connection: &P4Connection, change_id: &str, files: &[String]) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    let mut args = vec!["shelve".to_string(), "-f".into(), "-c".into(), id];
    args.extend(
        files
            .iter()
            .map(|path| workspace_file_spec(&connection.root, path)),
    );
    run_owned(&env, &args, None)?;
    Ok(())
}

pub fn delete_shelf(connection: &P4Connection, change_id: &str) -> AppResult<()> {
    let id = require_numbered(change_id)?;
    let env = env_for(connection);
    run_ok(&env, &["shelve", "-d", "-c", &id], None)?;
    Ok(())
}

fn empty_diff(path: &str) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated: false,
        lines: Vec::new(),
    }
}

pub(super) fn workspace_file_spec(root: &str, path: &str) -> String {
    file_spec(&workspace_cli_path(root, path))
}

pub(super) fn revision_file_spec(
    root: &str,
    path: &str,
    recursive: bool,
    suffix: &str,
) -> AppResult<String> {
    let path = workspace_cli_path(root, path);
    if !path.starts_with("//") && !Path::new(&path).is_absolute() {
        return Err(AppError::msg("Choose a file or folder."));
    }
    if !recursive {
        return Ok(file_at(&path, suffix));
    }
    let spec = file_spec(&path);
    if spec == "//" {
        return Ok(format!("//...{suffix}"));
    }
    let (directory, separator) = if cfg!(windows) && !spec.starts_with("//") {
        let separator = if spec.contains('\\') { '\\' } else { '/' };
        (spec.trim_end_matches(['/', '\\']), separator)
    } else {
        (spec.trim_end_matches('/'), '/')
    };
    Ok(format!("{directory}{separator}...{suffix}"))
}

fn workspace_cli_path(root: &str, path: &str) -> String {
    let path = strip_verbatim_prefix(path);
    if cfg!(windows) {
        if let Some(local) = local_unc_path(root, &path) {
            return local;
        }
    }
    path
}

/// A forward-slash UNC path inside this workspace is local, even though it begins with //.
fn local_unc_path(root: &str, path: &str) -> Option<String> {
    let normalize = |value: &str| {
        let value = value.replace('\\', "/");
        if let Some(rest) = value.strip_prefix("//?/UNC/") {
            format!("//{rest}")
        } else {
            value
        }
    };
    let root = normalize(root);
    let path = normalize(path);
    if !root.starts_with("//") || !path.starts_with("//") {
        return None;
    }
    let root = root.trim_end_matches('/');
    let prefix = path.get(..root.len())?;
    if !prefix.eq_ignore_ascii_case(root)
        || (path.len() != root.len() && path.as_bytes().get(root.len()) != Some(&b'/'))
    {
        return None;
    }
    Some(path.replace('/', "\\"))
}

/// Depot/client paths returned by p4 already contain filespec escapes; local paths do not.
fn file_spec(path: &str) -> String {
    if path.starts_with("//") {
        path.to_string()
    } else {
        escape_p4_path(path)
    }
}

fn escape_p4_path(path: &str) -> String {
    path.replace('%', "%25")
        .replace('#', "%23")
        .replace('@', "%40")
        .replace('*', "%2A")
}

fn unescape_p4_path(path: &str) -> String {
    path.replace("%40", "@")
        .replace("%23", "#")
        .replace("%2A", "*")
        .replace("%2a", "*")
        .replace("%25", "%")
}

pub fn file_action(
    connection: &P4Connection,
    action: &str,
    paths: &[String],
    change_id: Option<&str>,
) -> AppResult<()> {
    let args = file_action_args(connection, action, paths, change_id)?;
    run_owned(&env_for(connection), &args, None)?;
    Ok(())
}

fn file_action_args(
    connection: &P4Connection,
    action: &str,
    paths: &[String],
    change_id: Option<&str>,
) -> AppResult<Vec<String>> {
    let command = match action {
        "edit" | "add" | "delete" | "lock" | "unlock" => action,
        _ => return Err(AppError::msg("Unsupported file action.")),
    };
    if paths.is_empty() {
        return Err(AppError::msg("Choose a file."));
    }
    let mut args = vec![command.to_string()];
    if matches!(command, "lock" | "unlock") {
        let id = change_id.map(str::trim).unwrap_or_default();
        if id != "default"
            && (id.is_empty()
                || !id.bytes().all(|byte| byte.is_ascii_digit())
                || id.parse::<i64>().unwrap_or(0) <= 0)
        {
            return Err(AppError::msg(
                "Choose a pending changelist to lock or unlock files.",
            ));
        }
        for path in paths {
            let depot = path.starts_with("//") && local_unc_path(&connection.root, path).is_none();
            if path.is_empty()
                || path.chars().any(|ch| matches!(ch, '\0' | '\n' | '\r'))
                || path.contains("...")
                || (depot && path.contains(['*', '#', '@']))
                || (!depot && !Path::new(path).is_absolute())
            {
                return Err(AppError::msg(
                    "Choose explicit opened files to lock or unlock.",
                ));
            }
        }
        // Numbered changelists need -c, especially for unlock. Always include
        // the selected files; omitting them would affect the whole changelist.
        args.extend(["-c".to_string(), id.to_string()]);
    }
    if command == "add" {
        // Unlike other commands, add -f needs literal filenames, including wildcards.
        args.push("-f".into());
        args.extend(
            paths
                .iter()
                .map(|path| workspace_cli_path(&connection.root, path)),
        );
    } else {
        args.extend(
            paths
                .iter()
                .map(|path| workspace_file_spec(&connection.root, path)),
        );
    }
    Ok(args)
}

pub fn move_file(connection: &P4Connection, source: &str, destination: &str) -> AppResult<()> {
    let env = env_for(connection);
    move_file_with(connection, source, destination, |args| {
        run_ok(&env, args, None)
    })
}

fn move_file_with(
    connection: &P4Connection,
    source: &str,
    destination: &str,
    mut run: impl FnMut(&[&str]) -> AppResult<String>,
) -> AppResult<()> {
    let (source, target) = move_file_paths(Path::new(&connection.root), source, destination)?;
    let from = workspace_file_spec(&connection.root, &source.to_string_lossy());
    let to = workspace_file_spec(&connection.root, &target.to_string_lossy());
    let meta = run(&["-ztag", "fstat", "-T", "depotFile,action", &from])?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    if field(&record, "depotFile").is_empty() {
        return Err(AppError::msg("Choose a versioned workspace file."));
    }
    let action = field(&record, "action");
    match action.as_str() {
        "" => {
            run(&["edit", &from])?;
        }
        "edit" | "add" | "move/add" => {}
        _ => {
            return Err(AppError::msg(
                "Resolve or revert this file's pending action before moving it.",
            ))
        }
    }
    // Never force an overwrite or undo an edit after failure: local content must survive.
    run(&["move", &from, &to])?;
    Ok(())
}

fn move_file_paths(root: &Path, source: &str, destination: &str) -> AppResult<(PathBuf, PathBuf)> {
    let source = PathBuf::from(strip_verbatim_prefix(source));
    if !source.is_absolute() {
        return Err(AppError::msg("Choose a local workspace file."));
    }
    let parent = source
        .parent()
        .ok_or_else(|| AppError::msg("Choose a file."))?;
    let source_parent = workspace_directory_path(root, parent.to_path_buf())?;
    let source = fs::canonicalize(source_parent)?.join(
        source
            .file_name()
            .ok_or_else(|| AppError::msg("Choose a file."))?,
    );
    if !fs::symlink_metadata(&source)?.file_type().is_file() {
        return Err(AppError::msg("Choose a regular workspace file."));
    }
    let relative = if cfg!(windows) {
        destination.replace('\\', "/")
    } else {
        destination.to_string()
    };
    if relative.is_empty()
        || relative.contains('\0')
        || relative.starts_with('/')
        || relative.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.contains(':')
                || part.contains("...")
        })
        || Path::new(&relative).has_root()
    {
        return Err(AppError::msg(
            "Enter a relative destination inside this workspace.",
        ));
    }
    let relative = Path::new(&relative);
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let target_parent = workspace_directory_path(root, parent.to_path_buf())?;
    let target = fs::canonicalize(target_parent)?.join(
        relative
            .file_name()
            .ok_or_else(|| AppError::msg("Enter a file name."))?,
    );
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(AppError::msg(
                "The destination already exists. Choose another file name.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok((source, target))
}

pub fn login(connection: &P4Connection, password: &str) -> AppResult<()> {
    cli::login(&env_for(connection), password)
}

pub fn create_workspace(
    request: P4CreateRequest,
    mut progress: impl FnMut(&str),
) -> AppResult<P4Connection> {
    let port = request.port.trim().to_string();
    let user = request.user.trim().to_string();
    let client = request.client.trim().to_string();
    let stream = request.stream.trim().to_string();
    let depot_path = request.depot_path.trim().to_string();
    let charset = normalize_charset(&request.charset);
    if port.is_empty() || port.contains(char::is_whitespace) {
        return Err(AppError::msg(
            "Enter a server address, for example ssl:perforce.example.com:1666.",
        ));
    }
    if user.is_empty() || user.contains(char::is_whitespace) {
        return Err(AppError::msg("Enter a Perforce user."));
    }
    if !valid_client_name(&client) {
        return Err(AppError::msg(
            "Client name can use letters, numbers, dots, hyphens, and underscores.",
        ));
    }
    if stream.is_empty() && depot_path.is_empty() {
        return Err(AppError::msg("Enter a stream or a depot path."));
    }
    if !stream.is_empty() && !depot_path.is_empty() {
        return Err(AppError::msg("Enter a stream or a depot path, not both."));
    }
    if !stream.is_empty() && !valid_depot_path(&stream) {
        return Err(AppError::msg("Stream should look like //depot/main."));
    }
    if !depot_path.is_empty() && !valid_depot_path(&depot_path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let root = PathBuf::from(strip_verbatim_prefix(request.root.trim()));
    if !root.is_absolute() {
        return Err(AppError::msg(
            "Choose an absolute folder for the workspace.",
        ));
    }
    fs::create_dir_all(&root)?;
    let env = P4Env {
        cwd: root.clone(),
        port: port.clone(),
        user: user.clone(),
        client: client.clone(),
        charset: charset.clone(),
    };
    if !request.password.is_empty() {
        cli::login(&env, request.password.trim())?;
    }
    if client_exists(&env, &client)? {
        return Err(AppError::msg(format!("Client '{client}' already exists.")));
    }
    let spec = if stream.is_empty() {
        classic_client_spec(&client, &user, &root.to_string_lossy(), &depot_path)
    } else {
        let current = run_ok(&env, &["client", "-S", &stream, "-o", &client], None)?;
        set_spec_field(&current, "Root", &root.to_string_lossy())
    };
    run_ok(&env, &["client", "-i"], Some(&spec))?;
    write_config(&root, &env)?;
    let connection = connection_after_create(&env, &root, &stream)?;
    if let Err(err) = sync(&connection, &[], false, &mut progress) {
        return Err(AppError::msg(format!(
            "Workspace '{client}' was created, but sync failed: {err}"
        )));
    }
    Ok(connection)
}

pub fn check_connection(auth: &P4Auth) -> AppResult<P4CheckedConnection> {
    let env = prepare_auth(auth)?;
    let info = run_ok(&env, &["-ztag", "info"], None)?;
    let record = parse_ztag(&info).into_iter().next().unwrap_or_default();
    let server = record
        .get("serverAddress")
        .filter(|value| known_p4_value(value))
        .cloned()
        .unwrap_or_else(|| env.port.clone());
    Ok(P4CheckedConnection {
        server,
        clients: list_clients(&env)?,
    })
}

pub fn list_streams(auth: &P4Auth) -> AppResult<Vec<P4StreamOption>> {
    let env = prepare_auth(auth)?;
    let stdout = run_ok(&env, &["-ztag", "streams", "-m", "2000"], None)?;
    let mut streams = Vec::new();
    for record in parse_ztag(&stdout) {
        let path = field(&record, "Stream");
        if !valid_depot_path(&path) {
            continue;
        }
        streams.push(P4StreamOption {
            path,
            kind: field(&record, "Type"),
            parent: field(&record, "Parent"),
        });
    }
    streams.sort_by_key(|item| item.path.to_lowercase());
    Ok(streams)
}

pub fn list_depot_dirs(auth: &P4Auth, path: &str) -> AppResult<Vec<P4DepotEntry>> {
    let env = prepare_auth(auth)?;
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path == "//" {
        let stdout = run_ok(&env, &["-ztag", "depots"], None)?;
        let mut entries = Vec::new();
        for record in parse_ztag(&stdout) {
            let name = field(&record, "name");
            if name.is_empty() || name.contains([' ', '*', '?', '#', '@']) {
                continue;
            }
            entries.push(P4DepotEntry {
                path: format!("//{name}"),
                dir: true,
            });
        }
        entries.sort_by_key(|item| item.path.to_lowercase());
        return Ok(entries);
    }
    if !valid_depot_path(path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let spec = format!("{path}/*");
    let stdout = run_ok(&env, &["-ztag", "dirs", &spec], None)?;
    let mut entries = Vec::new();
    for record in parse_ztag(&stdout) {
        let dir = field(&record, "dir");
        if !valid_depot_path(&dir) {
            continue;
        }
        entries.push(P4DepotEntry {
            path: dir,
            dir: true,
        });
    }
    entries.sort_by_key(|item| item.path.to_lowercase());
    Ok(entries)
}

/// Point a local client root at this server user and client, then return that root.
pub fn prepare_client(auth: &P4Auth, name: &str) -> AppResult<String> {
    let name = name.trim();
    if !valid_client_name(name) {
        return Err(AppError::msg(
            "Client name can use letters, numbers, dots, hyphens, and underscores.",
        ));
    }
    let mut env = prepare_auth(auth)?;
    env.client = name.to_string();
    let stdout = run_ok(&env, &["-ztag", "info"], None)?;
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let root_text = record
        .get("clientRoot")
        .filter(|value| known_p4_value(value))
        .cloned()
        .unwrap_or_default();
    if root_text.is_empty() {
        return Err(AppError::msg("That client has no local root."));
    }
    let root = PathBuf::from(strip_verbatim_prefix(&root_text));
    if !root.is_dir() {
        return Err(AppError::msg(format!(
            "Client root is not on this machine: {}",
            root.display()
        )));
    }
    update_config_file(&root, &env)?;
    Ok(root.to_string_lossy().into_owned())
}

fn prepare_auth(auth: &P4Auth) -> AppResult<P4Env> {
    let port = auth.port.trim().to_string();
    let user = auth.user.trim().to_string();
    if port.is_empty() || port.contains(char::is_whitespace) {
        return Err(AppError::msg(
            "Enter a server address, for example ssl:perforce.example.com:1666.",
        ));
    }
    if user.is_empty() || user.contains(char::is_whitespace) {
        return Err(AppError::msg("Enter a Perforce user."));
    }
    let env = P4Env {
        cwd: PathBuf::new(),
        port,
        user,
        client: String::new(),
        charset: normalize_charset(&auth.charset),
    };
    if !auth.password.trim().is_empty() {
        cli::login(&env, auth.password.trim())?;
    }
    Ok(env)
}

pub fn list_users(connection: &P4Connection) -> AppResult<Vec<String>> {
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "users", "-m", "2000"], None)?;
    let mut users = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "User");
        if valid_client_name(&name) && !users.contains(&name) {
            users.push(name);
        }
    }
    users.sort_by_key(|item| item.to_lowercase());
    Ok(users)
}

pub fn list_user_clients(connection: &P4Connection, user: &str) -> AppResult<Vec<String>> {
    let user = require_name(user)?;
    let env = env_for(connection);
    let stdout = run_ok(&env, &["-ztag", "clients", "-u", &user], None)?;
    let mut clients = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "client");
        if valid_client_name(&name) && !clients.contains(&name) {
            clients.push(name);
        }
    }
    clients.sort_by_key(|item| item.to_lowercase());
    Ok(clients)
}

fn list_clients(env: &P4Env) -> AppResult<Vec<P4ClientOption>> {
    let stdout = run_ok(env, &["-ztag", "clients", "-u", &env.user], None)?;
    let mut clients = Vec::new();
    for record in parse_ztag(&stdout) {
        let name = field(&record, "client");
        if !valid_client_name(&name) {
            continue;
        }
        let stream = record
            .get("Stream")
            .cloned()
            .filter(|value| known_p4_value(value))
            .unwrap_or_default();
        let description = record
            .get("Description")
            .map(|value| {
                value
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        clients.push(P4ClientOption {
            name,
            root: record.get("Root").cloned().unwrap_or_default(),
            stream,
            description,
        });
    }
    clients.sort_by_key(|item| item.name.to_lowercase());
    Ok(clients)
}

pub(super) fn connection_after_create(
    env: &P4Env,
    root: &Path,
    stream: &str,
) -> AppResult<P4Connection> {
    let stdout = run_ok(env, &["-ztag", "info"], None).unwrap_or_default();
    let record = parse_ztag(&stdout).into_iter().next().unwrap_or_default();
    let reported = record
        .get("clientRoot")
        .map(|value| PathBuf::from(strip_verbatim_prefix(value)));
    let root = reported.unwrap_or_else(|| root.to_path_buf());
    let reported_stream = record
        .get("clientStream")
        .cloned()
        .filter(|value| known_p4_value(value));
    Ok(P4Connection {
        root: root.to_string_lossy().into_owned(),
        port: first_text(Some(&env.port), &field(&record, "serverAddress")),
        user: first_text(record.get("userName"), &env.user),
        client: first_text(record.get("clientName"), &env.client),
        charset: env.charset.clone(),
        stream: reported_stream.or_else(|| {
            if stream.is_empty() {
                None
            } else {
                Some(stream.to_string())
            }
        }),
        server: record.get("serverVersion").cloned().unwrap_or_default(),
    })
}

fn load_pending(connection: &P4Connection) -> AppResult<Vec<P4Changelist>> {
    let env = env_for(connection);
    let pending_text = run_ok(
        &env,
        &[
            "-ztag",
            "changes",
            "-s",
            "pending",
            "-c",
            &connection.client,
            "-L",
        ],
        None,
    )?;
    let shelved_text = super::review::allow_empty(run_ok(
        &env,
        &[
            "-ztag",
            "changes",
            "-s",
            "shelved",
            "-c",
            &connection.client,
            "-L",
        ],
        None,
    ))?;
    let opened_text = run_ok(&env, &["-ztag", "opened"], None)?;
    let opened = parse_ztag(&opened_text);
    let depot_files: Vec<String> = opened
        .iter()
        .filter_map(|record| record.get("depotFile").cloned())
        .collect();
    let locals = where_paths(&env, &depot_files);
    let open_stream = opened.iter().find_map(|record| {
        stream_from_record(record).map(|stream| {
            let change = field(record, "change");
            (
                if change.is_empty() {
                    "default".to_string()
                } else {
                    change
                },
                stream,
            )
        })
    });
    let mut by_change: BTreeMap<String, Vec<P4File>> = BTreeMap::new();
    for record in &opened {
        if !record.contains_key("depotFile") {
            continue;
        }
        let change = {
            let value = field(record, "change");
            if value.is_empty() {
                "default".to_string()
            } else {
                value
            }
        };
        by_change
            .entry(change)
            .or_default()
            .push(file_from_opened(connection, record, &locals, false));
    }
    let default_description = run_ok(&env, &["change", "-o"], None)
        .map(|spec| read_description(&spec))
        .unwrap_or_default();
    let mut changes = vec![P4Changelist {
        id: "default".to_string(),
        user: connection.user.clone(),
        client: connection.client.clone(),
        status: "pending".to_string(),
        description: default_description,
        time: 0,
        shelved: false,
        files: by_change.remove("default").unwrap_or_default(),
        stream: None,
        shelved_stream: None,
    }];
    let numbered = pending_summaries(connection, &pending_text, &shelved_text, by_change);
    changes.extend(numbered);
    for change in &mut changes {
        change
            .files
            .sort_by_cached_key(|file| file.depot_path.to_lowercase());
        change.stream = open_stream
            .as_ref()
            .filter(|(id, _)| id == &change.id)
            .map(|(_, stream)| stream.clone());
    }
    annotate_pending(connection, &mut changes);
    Ok(changes)
}

fn pending_summaries(
    connection: &P4Connection,
    pending: &str,
    shelves: &str,
    mut opened: BTreeMap<String, Vec<P4File>>,
) -> Vec<P4Changelist> {
    let mut shelves: BTreeMap<_, _> = parse_ztag(shelves)
        .into_iter()
        .filter_map(|record| Some((record.get("change")?.clone(), record)))
        .collect();
    let mut changes = Vec::new();
    for record in parse_ztag(pending) {
        let Some(id) = record.get("change") else {
            continue;
        };
        let files = opened.remove(id).unwrap_or_default();
        changes.push(change_from_record(
            &record,
            files,
            shelves.remove(id).is_some(),
        ));
    }
    for (id, record) in shelves {
        changes.push(change_from_record(
            &record,
            opened.remove(&id).unwrap_or_default(),
            true,
        ));
    }
    for (id, files) in opened {
        changes.push(P4Changelist {
            id,
            files,
            user: connection.user.clone(),
            client: connection.client.clone(),
            status: "pending".to_string(),
            description: String::new(),
            time: 0,
            shelved: false,
            stream: None,
            shelved_stream: None,
        });
    }
    changes.sort_by_key(|change| std::cmp::Reverse(change_number(&change.id)));
    changes
}

fn file_from_opened(
    connection: &P4Connection,
    record: &ZtagRecord,
    locals: &BTreeMap<String, String>,
    shelved: bool,
) -> P4File {
    let depot_path = field(record, "depotFile");
    let local_path = locals.get(&depot_path).cloned().unwrap_or_else(|| {
        local_from_client(
            Path::new(&connection.root),
            &connection.client,
            &field(record, "clientFile"),
        )
    });
    P4File {
        depot_path,
        local_path,
        action: field(record, "action"),
        rev: field(record, "rev"),
        shelved,
        binary: file_type_is_binary(&field(record, "type")),
        status: String::new(),
        detail: String::new(),
    }
}

pub(super) fn files_from_groups(
    connection: &P4Connection,
    groups: &[ZtagRecord],
    shelved: bool,
) -> Vec<P4File> {
    groups
        .iter()
        .filter_map(|group| {
            let depot_path = field(group, "depotFile");
            if depot_path.is_empty() {
                return None;
            }
            Some(P4File {
                local_path: local_from_client(
                    Path::new(&connection.root),
                    &connection.client,
                    &field(group, "clientFile"),
                ),
                depot_path,
                action: field(group, "action"),
                rev: field(group, "rev"),
                shelved,
                binary: file_type_is_binary(&field(group, "type")),
                status: String::new(),
                detail: String::new(),
            })
        })
        .collect()
}

pub(super) fn stream_from_record(record: &ZtagRecord) -> Option<P4StreamChange> {
    let path = record
        .get("stream")
        .filter(|path| path.starts_with("//"))?
        .clone();
    Some(P4StreamChange {
        path,
        base_change: record
            .get("streamHaveChange")
            .or_else(|| record.get("haveChange"))
            .cloned()
            .unwrap_or_default(),
    })
}

pub(super) fn change_from_record(
    record: &ZtagRecord,
    files: Vec<P4File>,
    shelved: bool,
) -> P4Changelist {
    P4Changelist {
        id: field(record, "change"),
        user: field(record, "user"),
        client: field(record, "client"),
        status: {
            let status = field(record, "status");
            if status.is_empty() {
                "submitted".to_string()
            } else {
                status
            }
        },
        description: clean_description(&field(record, "desc")),
        time: field_i64(record, "time"),
        shelved,
        files,
        stream: if shelved {
            None
        } else {
            stream_from_record(record)
        },
        shelved_stream: if shelved {
            stream_from_record(record)
        } else {
            None
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P4Location {
    pub depot: String,
    pub local: String,
}

/// Map a workspace or depot path to the other side of the client view.
pub fn locate(connection: &P4Connection, path: &str) -> AppResult<P4Location> {
    let path = workspace_cli_path(&connection.root, path.trim());
    let depot_spec = path.starts_with("//");
    let spec = trim_location_separators(path.trim(), depot_spec);
    if spec.is_empty() || spec == "//" {
        return Err(AppError::msg("Choose a file or folder."));
    }
    let env = env_for(connection);
    let encoded = file_spec(spec);
    let stdout = run_ok(&env, &["-ztag", "where", &encoded], None)?;
    let wanted = normalize_location(spec, depot_spec);
    let mut fallback = None;
    for record in parse_ztag(&stdout) {
        if record.contains_key("unmap") {
            continue;
        }
        let depot = mapped_location(&field(&record, "depotFile"), true);
        let local = mapped_location(&field(&record, "path"), false);
        if depot.is_empty() || local.is_empty() {
            continue;
        }
        let location = P4Location { depot, local };
        let matching_path = if depot_spec {
            &location.depot
        } else {
            &location.local
        };
        if normalize_location(matching_path, depot_spec) == wanted {
            return Ok(location);
        }
        if fallback.is_none() {
            fallback = Some(location);
        }
    }
    fallback.ok_or_else(|| AppError::msg("That path is not in this workspace."))
}

fn trim_location_separators(value: &str, depot: bool) -> &str {
    if cfg!(windows) && !depot {
        value.trim_end_matches(['/', '\\'])
    } else {
        value.trim_end_matches('/')
    }
}

fn mapped_location(value: &str, depot: bool) -> String {
    let value = trim_location_separators(value.trim(), depot);
    let value = value
        .strip_suffix("/...")
        .or_else(|| {
            if cfg!(windows) && !depot {
                value.strip_suffix("\\...")
            } else {
                None
            }
        })
        .unwrap_or(value);
    trim_location_separators(value, depot).to_string()
}

fn normalize_location(value: &str, depot: bool) -> String {
    let location = mapped_location(value, depot);
    if depot {
        location
    } else {
        local_path_key(&location)
    }
}

fn where_paths(env: &P4Env, files: &[String]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for chunk in files.chunks(80) {
        let mut args = vec!["-ztag".to_string(), "where".into()];
        args.extend(chunk.iter().cloned());
        let Ok(stdout) = run_owned(env, &args, None) else {
            continue;
        };
        for record in parse_ztag(&stdout) {
            if let (Some(depot), Some(path)) = (record.get("depotFile"), record.get("path")) {
                map.insert(depot.clone(), path.clone());
            }
        }
    }
    map
}

fn local_from_client(root: &Path, client: &str, client_file: &str) -> String {
    let prefix = format!("//{client}/");
    let Some(relative) = client_file.strip_prefix(&prefix) else {
        return String::new();
    };
    if relative.is_empty() {
        return root.to_string_lossy().into_owned();
    }
    root.join(unescape_p4_path(relative).replace('/', std::path::MAIN_SEPARATOR_STR))
        .to_string_lossy()
        .into_owned()
}

fn push_history_range(args: &mut Vec<String>, before: Option<i64>) {
    if let Some(change) = before.filter(|change| *change > 1) {
        args.push(format!("@1,@{}", change - 1));
    }
}

fn p4_connection(start: &Path) -> AppResult<Option<P4Connection>> {
    p4_connection_with(
        start,
        find_config(start),
        cli::active_p4().is_some(),
        |env, args| run_ok(env, args, None),
    )
}

fn p4_connection_with(
    start: &Path,
    config: Option<ConfigFile>,
    available: bool,
    mut run: impl FnMut(&P4Env, &[&str]) -> AppResult<String>,
) -> AppResult<Option<P4Connection>> {
    if !available {
        if config.as_ref().is_some_and(config_is_workspace) {
            return Err(AppError::P4Missing);
        }
        return Ok(None);
    }
    let env = match &config {
        Some(config) if config_is_workspace(config) => env_from_config(start, config),
        _ => ambient_env(start, &mut run),
    };
    match run(&env, &["-ztag", "info"]) {
        Ok(stdout) => Ok(connection_from_info(start, &env, &stdout)),
        Err(_) => Ok(config
            .filter(config_is_workspace)
            .map(|config| connection_from_config(&config))),
    }
}

fn connection_from_info(start: &Path, env: &P4Env, stdout: &str) -> Option<P4Connection> {
    let record = parse_ztag(stdout).into_iter().next()?;
    let client = field(&record, "clientName");
    let root = field(&record, "clientRoot");
    if !known_p4_value(&client) || !known_p4_value(&root) {
        return None;
    }
    let root_path = PathBuf::from(strip_verbatim_prefix(&root));
    if !path_is_within(&root_path, start) {
        return None;
    }
    let stream = record
        .get("clientStream")
        .cloned()
        .filter(|value| known_p4_value(value));
    Some(P4Connection {
        root: root_path.to_string_lossy().into_owned(),
        port: first_text(Some(&env.port), &field(&record, "serverAddress")),
        user: first_text(record.get("userName"), &env.user),
        client,
        charset: env.charset.clone(),
        stream,
        server: record.get("serverVersion").cloned().unwrap_or_default(),
    })
}

fn ambient_env(start: &Path, run: &mut impl FnMut(&P4Env, &[&str]) -> AppResult<String>) -> P4Env {
    let mut env = P4Env {
        cwd: start.to_path_buf(),
        port: String::new(),
        user: String::new(),
        client: String::new(),
        charset: String::new(),
    };
    if let Ok(text) = run(&env, &["set"]) {
        let map = parse_p4_set(&text);
        env.port = map.get("P4PORT").cloned().unwrap_or_default();
        env.user = map.get("P4USER").cloned().unwrap_or_default();
        env.client = map.get("P4CLIENT").cloned().unwrap_or_default();
        env.charset = normalize_charset(map.get("P4CHARSET").map(String::as_str).unwrap_or(""));
    }
    env
}

fn env_from_config(start: &Path, config: &ConfigFile) -> P4Env {
    P4Env {
        cwd: start.to_path_buf(),
        port: config.values.get("P4PORT").cloned().unwrap_or_default(),
        user: config.values.get("P4USER").cloned().unwrap_or_default(),
        client: config.values.get("P4CLIENT").cloned().unwrap_or_default(),
        charset: normalize_charset(
            config
                .values
                .get("P4CHARSET")
                .map(String::as_str)
                .unwrap_or(""),
        ),
    }
}

fn connection_from_config(config: &ConfigFile) -> P4Connection {
    P4Connection {
        root: config.directory.to_string_lossy().into_owned(),
        port: config.values.get("P4PORT").cloned().unwrap_or_default(),
        user: config.values.get("P4USER").cloned().unwrap_or_default(),
        client: config.values.get("P4CLIENT").cloned().unwrap_or_default(),
        charset: normalize_charset(
            config
                .values
                .get("P4CHARSET")
                .map(String::as_str)
                .unwrap_or(""),
        ),
        stream: None,
        server: String::new(),
    }
}

fn config_is_workspace(config: &ConfigFile) -> bool {
    config
        .values
        .get("P4PORT")
        .is_some_and(|value| !value.trim().is_empty())
        && config
            .values
            .get("P4CLIENT")
            .is_some_and(|value| !value.trim().is_empty())
}

fn find_config(start: &Path) -> Option<ConfigFile> {
    let names = config_names();
    let mut current = Some(start);
    while let Some(dir) = current {
        for name in &names {
            let file = dir.join(name);
            if !file.is_file() {
                continue;
            }
            if let Some(values) = read_config(&file) {
                return Some(ConfigFile {
                    directory: dir.to_path_buf(),
                    filename: name.clone(),
                    values,
                });
            }
        }
        current = dir.parent();
    }
    None
}

fn config_names() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(name) = std::env::var("P4CONFIG") {
        let name = name.trim();
        if !name.is_empty() && !name.contains(['/', '\\']) {
            names.push(name.to_string());
        }
    }
    for fallback in [".p4config", "p4config.txt", ".p4config.txt"] {
        if !names.iter().any(|name| name.eq_ignore_ascii_case(fallback)) {
            names.push(fallback.to_string());
        }
    }
    names
}

fn read_config(path: &Path) -> Option<BTreeMap<String, String>> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 65_536 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    Some(parse_p4config(text))
}

fn git_root(start: &Path) -> AppResult<Option<String>> {
    let found = crate::git::open_for_detection(start)
        .map(|repo| strip_verbatim_prefix(&repo.workdir().to_string_lossy()));
    git_root_result(start, found)
}

fn git_root_result(start: &Path, found: AppResult<String>) -> AppResult<Option<String>> {
    match found {
        Ok(root) => Ok(Some(root)),
        Err(AppError::GitMissing) => Ok(find_git_dir(start)),
        Err(err)
            if err
                .to_string()
                .starts_with("fatal: not a git repository (or any of the parent directories):")
                || err.to_string().starts_with(
                    "fatal: not a git repository (or any parent up to mount point ",
                ) =>
        {
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

fn find_git_dir(start: &Path) -> Option<String> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let marker = dir.join(".git");
        if marker.is_dir() || marker.is_file() {
            return Some(dir.to_string_lossy().into_owned());
        }
        current = dir.parent();
    }
    None
}

fn existing_dir(path: &str) -> AppResult<PathBuf> {
    let path = strip_verbatim_prefix(path);
    let start = PathBuf::from(&path);
    if !start.exists() {
        return Err(AppError::msg(format!("Folder not found: {path}")));
    }
    if start.is_file() {
        Ok(start.parent().unwrap_or(&start).to_path_buf())
    } else {
        Ok(start)
    }
}

fn client_exists(env: &P4Env, name: &str) -> AppResult<bool> {
    let stdout = run_ok(env, &["clients", "-e", name], None)?;
    Ok(stdout
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(name)))
}

fn write_config(root: &Path, env: &P4Env) -> AppResult<()> {
    update_config_file(root, env)
}

pub(super) fn update_config_file(root: &Path, env: &P4Env) -> AppResult<()> {
    let names = config_names();
    let path = names
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            root.join(
                names
                    .first()
                    .cloned()
                    .unwrap_or_else(|| ".p4config".to_string()),
            )
        });
    let mut values = if path.is_file() {
        read_config(&path).unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    values.insert("P4PORT".to_string(), env.port.clone());
    values.insert("P4USER".to_string(), env.user.clone());
    values.insert("P4CLIENT".to_string(), env.client.clone());
    if env.charset.is_empty() {
        values.remove("P4CHARSET");
    } else {
        values.insert("P4CHARSET".to_string(), env.charset.clone());
    }
    let mut text = String::new();
    for (key, value) in &values {
        text.push_str(key);
        text.push('=');
        text.push_str(value);
        text.push('\n');
    }
    fs::write(path, text)?;
    Ok(())
}

fn change_spec(env: &P4Env, change_id: &str) -> AppResult<(String, bool)> {
    if change_id.is_empty() || change_id == "default" || change_id == "new" {
        // A new -s form marks JobView suggestions as ignore. Keep the native
        // default form until a numbered changelist has explicit fix records.
        Ok((run_ok(env, &["change", "-o"], None)?, false))
    } else {
        Ok((run_ok(env, &["change", "-s", "-o", change_id], None)?, true))
    }
}

const MAX_PREVIEW_BYTES: usize = 2_000_000;

fn printed_file_diff(
    env: &P4Env,
    path: &str,
    spec: &str,
    binary: bool,
    deleted: bool,
) -> AppResult<FileDiff> {
    if binary {
        return Ok(content_file_diff(path, &[], false, true, deleted));
    }
    let (bytes, truncated) = cli::read_file_prefix(env, spec, MAX_PREVIEW_BYTES)?;
    Ok(content_file_diff(path, &bytes, truncated, false, deleted))
}

pub(super) fn content_file_diff(
    path: &str,
    bytes: &[u8],
    truncated: bool,
    binary: bool,
    deleted: bool,
) -> FileDiff {
    if binary || bytes.contains(&0) {
        return FileDiff {
            path: path.to_string(),
            old_path: None,
            binary: true,
            truncated,
            lines: Vec::new(),
        };
    }
    let text = String::from_utf8_lossy(bytes);
    let count = text.lines().count();
    let mut lines = vec![crate::git::DiffLine {
        kind: "hunk".to_string(),
        content: if deleted {
            format!("@@ -1,{count} +0,0 @@")
        } else {
            format!("@@ -0,0 +1,{count} @@")
        },
        old_lineno: None,
        new_lineno: None,
    }];
    for (index, line) in text.lines().enumerate() {
        if lines.len() >= 4000 {
            return FileDiff {
                path: path.to_string(),
                old_path: None,
                binary: false,
                truncated: true,
                lines,
            };
        }
        lines.push(crate::git::DiffLine {
            kind: if deleted { "delete" } else { "add" }.to_string(),
            content: line.to_string(),
            old_lineno: deleted.then_some((index as u32) + 1),
            new_lineno: (!deleted).then_some((index as u32) + 1),
        });
    }
    FileDiff {
        path: path.to_string(),
        old_path: None,
        binary: false,
        truncated,
        lines,
    }
}

pub(super) fn env_for(connection: &P4Connection) -> P4Env {
    P4Env {
        cwd: PathBuf::from(&connection.root),
        port: connection.port.clone(),
        user: connection.user.clone(),
        client: connection.client.clone(),
        charset: connection.charset.clone(),
    }
}

fn run_ok(env: &P4Env, args: &[&str], input: Option<&str>) -> AppResult<String> {
    cli::run_p4_ok(env, args, input)
}

fn run_owned(env: &P4Env, args: &[String], input: Option<&str>) -> AppResult<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_p4_ok(env, &refs, input)
}

fn require_description(description: &str) -> AppResult<()> {
    if description.trim().is_empty() {
        Err(AppError::msg("Enter a changelist description."))
    } else {
        Ok(())
    }
}

fn optional_name(value: &str) -> AppResult<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(require_name(value)?))
}

fn require_name(value: &str) -> AppResult<String> {
    let value = value.trim();
    if !valid_client_name(value) {
        return Err(AppError::msg(
            "That name is not a Perforce user or workspace.",
        ));
    }
    Ok(value.to_string())
}

fn require_numbered(change_id: &str) -> AppResult<String> {
    let change_id = change_id.trim();
    if change_id.is_empty() || change_id == "default" || change_id.parse::<i64>().is_err() {
        return Err(AppError::msg("Choose a numbered changelist."));
    }
    Ok(change_id.to_string())
}

fn field(record: &ZtagRecord, key: &str) -> String {
    record.get(key).cloned().unwrap_or_default()
}

fn field_i64(record: &ZtagRecord, key: &str) -> i64 {
    record
        .get(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn clean_description(text: &str) -> String {
    let text = text.trim();
    if text == "<enter description here>" {
        String::new()
    } else {
        text.to_string()
    }
}

fn change_number(id: &str) -> i64 {
    id.parse().unwrap_or(0)
}

fn first_text(preferred: Option<&String>, fallback: &str) -> String {
    preferred
        .map(String::as_str)
        .filter(|value| known_p4_value(value))
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn pending_lists_every_shelf_without_reading_its_files() {
        let connection = P4Connection {
            root: String::new(),
            port: String::new(),
            user: "author".into(),
            client: "main".into(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        };
        let shelves: String = (100..=145)
            .map(|id| format!("... change {id}\n... status pending\n... desc Shelf {id}\n\n"))
            .collect();
        let changes = pending_summaries(
            &connection,
            "... change 100\n... status pending\n",
            &shelves,
            BTreeMap::new(),
        );
        assert_eq!(changes.len(), 46);
        assert!(changes
            .iter()
            .all(|change| change.shelved && change.files.is_empty()));
        assert_eq!(changes[0].id, "145");
        assert_eq!(changes[0].description, "Shelf 145");
    }

    #[test]
    fn directory_history_scopes_pages_and_search_to_the_selected_subtree() {
        let root = tempfile::tempdir().unwrap();
        let connection = mutation_connection(root.path());
        let request = P4PathHistoryRequest {
            user: "alice".into(),
            client: "work".into(),
            query: "42".into(),
            before: Some(100),
            limit: 50,
            scan_limit: 100,
        };
        let page = path_history_with(&connection,"//depot/project/docs",&request, |_: &P4Env,args:&[String]| {
            assert_eq!(args.last().unwrap(),"//depot/project/docs/...@1,@99");
            assert!(args.windows(2).any(|pair| pair == ["-u","alice"]));
            assert!(args.windows(2).any(|pair| pair == ["-c","work"]));
            Ok("... change 52\n... desc Other change\n\n... change 42\n... desc Matching change\n".into())
        }).unwrap();
        assert_eq!(page.changes.len(), 1);
        assert_eq!(page.changes[0].id, "42");
        assert_eq!(page.scanned_through, Some(42));
    }

    #[test]
    fn depot_root_history_keeps_all_depots_in_scope_and_paginates_normally() {
        let root = tempfile::tempdir().unwrap();
        let connection = mutation_connection(root.path());
        for (before, expected) in [(None, "//..."), (Some(100), "//...@1,@99")] {
            let request = P4PathHistoryRequest {
                user: String::new(),
                client: String::new(),
                query: String::new(),
                before,
                limit: 50,
                scan_limit: 500,
            };
            let page = path_history_with(&connection, "//", &request, |_, args| {
                assert_eq!(args.last().unwrap(), expected);
                assert!(args.windows(2).any(|pair| pair == ["-m", "50"]));
                Ok("... change 42\n... desc Update shared files\n".into())
            })
            .unwrap();
            assert_eq!(page.changes[0].id, "42");
        }
    }

    #[test]
    fn directory_history_escapes_local_folders_and_rejects_paths_outside_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let connection = mutation_connection(root.path());
        let directory = root.path().join("notes #1@review");
        fs::create_dir(&directory).unwrap();
        let scope = directory_history_spec(&connection, &directory.to_string_lossy()).unwrap();
        assert!(scope
            .replace('\\', "/")
            .ends_with("notes %231%40review/..."));
        assert!(directory_history_spec(&connection, "../outside").is_err());
        assert!(directory_history_spec(&connection, "//depot/project/../other").is_err());
        assert!(directory_history_spec(&connection, "//depot/project/...").is_err());
    }

    #[test]
    fn directory_history_finishes_paging_at_the_first_changelist() {
        let root = tempfile::tempdir().unwrap();
        let connection = mutation_connection(root.path());
        let request = P4PathHistoryRequest {
            user: String::new(),
            client: String::new(),
            query: String::new(),
            before: Some(1),
            limit: 50,
            scan_limit: 500,
        };
        let page = path_history_with(&connection, "//depot/project", &request, |_, _| {
            panic!("No command should run after the oldest changelist")
        })
        .unwrap();
        assert!(page.changes.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn file_history_pages_across_renames_using_the_first_unseen_revision() {
        let mut text = "... depotFile //depot/new.txt\n".to_string();
        for index in 0..50 {
            text.push_str(&format!(
                "... rev{index} {}\n... change{index} {}\n",
                50 - index,
                100 - index
            ));
        }
        text.push_str("\n... depotFile //depot/old.txt\n... rev0 73\n... change0 49\n");
        let page = super::revision_page(&text);
        assert_eq!(page.revisions.len(), 50);
        let next = page.next.unwrap();
        assert_eq!(next.depot_path, "//depot/old.txt");
        assert_eq!(next.before_revision, 74);
        assert_eq!(page.revisions[49].rev, "1");
    }

    #[test]
    fn final_history_page_keeps_full_descriptions_and_stops_paging() {
        let page = super::revision_page("... depotFile //depot/file.txt\n... rev0 2\n... desc0 A complete description\n... user0 alice\n... rev1 1\n");
        assert_eq!(page.revisions.len(), 2);
        assert!(page.next.is_none());
        assert_eq!(page.revisions[0].description, "A complete description");
    }

    use super::browse::{fold_path, path_is_unchanged};
    use super::*;
    use std::collections::BTreeSet;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "rebaseraven-p4-{label}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn record(pairs: &[(&str, &str)]) -> ZtagRecord {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn discovery_config(root: &Path) -> ConfigFile {
        ConfigFile {
            directory: root.to_path_buf(),
            filename: ".p4config".into(),
            values: BTreeMap::from([
                ("P4PORT".into(), "ssl:perforce.example.com:1666".into()),
                ("P4USER".into(), "alice".into()),
                ("P4CLIENT".into(), "dev-pc".into()),
            ]),
        }
    }

    #[test]
    fn discovery_ignores_unreachable_ambient_servers_but_keeps_explicit_workspace_hints() {
        let temporary = TestDirectory::new("discovery-unreachable");
        let mut calls = Vec::new();
        let found = p4_connection_with(&temporary.0, None, true, |env, args| {
            calls.push(
                args.iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>(),
            );
            if args == ["set"] {
                Ok("P4PORT=ssl:perforce.example.com:1666 (set)\nP4CLIENT=other-pc (set)\n".into())
            } else {
                assert_eq!(env.client, "other-pc");
                Err(AppError::msg("Perforce workspace discovery timed out."))
            }
        })
        .unwrap();
        assert!(found.is_none());
        assert_eq!(calls, [vec!["set"], vec!["-ztag", "info"]]);

        let found = p4_connection_with(
            &temporary.0,
            Some(discovery_config(&temporary.0)),
            true,
            |_, args| {
                assert_eq!(args, ["-ztag", "info"]);
                Err(AppError::msg("Perforce workspace discovery timed out."))
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.root, temporary.0.to_string_lossy());
        assert_eq!(found.port, "ssl:perforce.example.com:1666");
        assert_eq!(found.client, "dev-pc");
    }

    #[test]
    fn discovery_handles_expired_settings_and_missing_optional_p4() {
        let temporary = TestDirectory::new("discovery-local");
        assert!(p4_connection_with(&temporary.0, None, false, |_, _| panic!(
            "missing CLI was launched"
        ))
        .unwrap()
        .is_none());
        assert_eq!(
            p4_connection_with(
                &temporary.0,
                Some(discovery_config(&temporary.0)),
                false,
                |_, _| panic!("missing CLI was launched")
            )
            .unwrap_err()
            .to_string(),
            crate::error::P4_MISSING
        );
        let mut calls = 0;
        assert!(p4_connection_with(&temporary.0, None, true, |_, _| {
            calls += 1;
            Err(AppError::msg("Perforce workspace discovery timed out."))
        })
        .unwrap()
        .is_none());
        assert_eq!(calls, 2);
    }

    #[test]
    fn reachable_ambient_discovery_preserves_same_and_nested_root_selection() {
        let temporary = TestDirectory::new("discovery-roots");
        let inner = temporary.0.join("inner");
        let selected = inner.join("src");
        fs::create_dir_all(&selected).unwrap();
        let root = temporary.0.to_string_lossy().into_owned();
        let inner = inner.to_string_lossy().into_owned();
        let selected_text = selected.to_string_lossy().into_owned();
        for (git_root, p4_root, expected) in [
            (root.as_str(), root.as_str(), "ambiguous"),
            (inner.as_str(), root.as_str(), "git"),
            (root.as_str(), inner.as_str(), "perforce"),
        ] {
            let found = p4_connection_with(&selected, None, true, |env, args| {
                if args == ["set"] {
                    Ok("P4PORT=ssl:perforce.example.com:1666 (set)\nP4USER=alice (set)\nP4CLIENT=dev-pc (set)\n".into())
                } else {
                    assert_eq!(env.port, "ssl:perforce.example.com:1666");
                    Ok(format!("... clientName dev-pc\n... clientRoot {p4_root}\n... userName alice\n... serverAddress identity.example.com:1666\n"))
                }
            }).unwrap().unwrap();
            let found =
                pick_closer(&selected, selected_text.clone(), git_root.into(), found).unwrap();
            assert!(
                matches!(
                    (&found, expected),
                    (RepoDetection::Ambiguous { .. }, "ambiguous")
                        | (RepoDetection::Git { .. }, "git")
                        | (RepoDetection::Perforce { .. }, "perforce")
                ),
                "{found:?}"
            );
        }
        assert!(
            p4_connection_with(&temporary.0, None, true, |_, args| {
                Ok(if args == ["set"] {
                    String::new()
                } else {
                    format!(
                        "... clientName other-pc\n... clientRoot {}\n",
                        selected.display()
                    )
                })
            })
            .unwrap()
            .is_none(),
            "an unrelated workspace must not claim a Git folder"
        );
    }

    #[test]
    fn git_discovery_only_treats_absent_repositories_as_an_optional_match() {
        let temporary = TestDirectory::new("discovery-git-errors");
        assert!(git_root_result(
            &temporary.0,
            Err(AppError::msg(
                "fatal: not a git repository (or any of the parent directories): .git"
            ))
        )
        .unwrap()
        .is_none());
        assert!(git_root_result(
            &temporary.0,
            Err(AppError::msg("fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary.")),
        ).unwrap().is_none());
        for message in [
            "Bare repositories are not supported yet",
            "fatal: bad config line 1",
            "fatal: not a git repository: /work/missing.git",
            "fatal: detected dubious ownership in repository",
            "Could not start Git",
        ] {
            let error = git_root_result(&temporary.0, Err(AppError::msg(message))).unwrap_err();
            assert_eq!(error.to_string(), message);
        }
        fs::write(
            temporary.0.join(".git"),
            "gitdir: /work/shared.git/worktrees/example\n",
        )
        .unwrap();
        assert_eq!(
            git_root_result(&temporary.0, Err(AppError::GitMissing))
                .unwrap()
                .unwrap(),
            temporary.0.to_string_lossy()
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_filespecs_normalize_verbatim_drive_and_unc_paths() {
        assert_eq!(
            workspace_file_spec(r"C:\work\client", r"\\?\C:\work\client\ leading #@%.txt"),
            r"C:\work\client\ leading %23%40%25.txt"
        );
        assert_eq!(
            workspace_file_spec(
                r"\\server\share\client",
                r"\\?\UNC\server\share\client\ leading #@%.txt"
            ),
            r"\\server\share\client\ leading %23%40%25.txt"
        );
        assert_eq!(
            workspace_file_spec(r"C:\work\client", "//depot/main/file%23name.txt"),
            "//depot/main/file%23name.txt"
        );
    }

    fn mutation_connection(root: &Path) -> P4Connection {
        P4Connection {
            root: root.to_string_lossy().into_owned(),
            port: "perforce.example.com:1666".into(),
            user: "alice".into(),
            client: "dev-pc".into(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        }
    }

    #[test]
    fn lock_actions_target_only_explicit_files_in_the_selected_changelist() {
        let temporary = TestDirectory::new("lock-args");
        let connection = mutation_connection(&temporary.0);
        let local = temporary
            .0
            .join("asset #@%*.bin")
            .to_string_lossy()
            .into_owned();
        let paths = vec![local, "//depot/main/asset%23%40%25%2A.bin".into()];
        for command in ["lock", "unlock"] {
            for change in ["default", "42"] {
                let args = file_action_args(&connection, command, &paths, Some(change)).unwrap();
                assert_eq!(&args[..3], &[command, "-c", change]);
                assert_eq!(args.len(), 5);
                assert!(args[3].ends_with("asset %23%40%25%2A.bin"));
                assert_eq!(args[4], "//depot/main/asset%23%40%25%2A.bin");
                assert!(!args
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "-f" | "-x" | "-g")));
            }
            assert!(file_action_args(&connection, command, &[], Some("42")).is_err());
            assert!(file_action_args(&connection, command, &paths, None).is_err());
            for change in ["", "0", "-1", "42 -f", "42,43", "999999999999999999999"] {
                assert!(file_action_args(&connection, command, &paths, Some(change)).is_err());
            }
            for path in [
                "",
                "-f",
                "relative.txt",
                "//depot/main/...",
                "//depot/main/*",
                "//depot/main/file#1",
                "//depot/main/file@42",
            ] {
                assert!(
                    file_action_args(&connection, command, &[path.into()], Some("42")).is_err()
                );
            }
        }
        assert!(file_action_args(&connection, "unlock -f", &paths, Some("42")).is_err());
        assert!(file_action_args(&connection, "revert", &paths, Some("42")).is_err());
        // Existing add semantics still pass literal wildcard bytes with -f.
        let add = file_action_args(&connection, "add", &paths[..1], None).unwrap();
        assert_eq!(&add[..2], &["add", "-f"]);
        assert!(add[2].ends_with("asset #@%*.bin"));
    }

    #[cfg(windows)]
    #[test]
    fn locking_a_forward_slash_unc_workspace_file_escapes_its_literal_filename() {
        let connection = mutation_connection(Path::new(r"\\fileserver\share\workspace"));
        let args = file_action_args(
            &connection,
            "lock",
            &["//fileserver/share/workspace/asset#@%*.bin".into()],
            Some("42"),
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "lock",
                "-c",
                "42",
                r"\\fileserver\share\workspace\asset%23%40%25%2A.bin"
            ]
        );
    }

    #[test]
    fn delete_change_requires_an_owned_pending_numbered_change_and_never_forces() {
        let connection = mutation_connection(Path::new(""));
        for invalid in ["default", "0", "-1", "42 -f"] {
            assert!(delete_change_with(&connection, invalid, |_| panic!(
                "invalid change reached CLI"
            ))
            .is_err());
        }
        for spec in [
            "Status: submitted\nClient: dev-pc\nUser: alice\n",
            "Status: pending\nClient: other-pc\nUser: alice\n",
            "Status: pending\nClient: dev-pc\nUser: bob\n",
        ] {
            assert!(delete_change_with(&connection, "42", |args| {
                assert_eq!(args, ["change", "-o", "42"]);
                Ok(spec.into())
            })
            .is_err());
        }
        let mut calls = Vec::new();
        let error = delete_change_with(&connection, "42", |args| {
            calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            if args[1] == "-o" {
                Ok("Status: pending\nClient: dev-pc\nUser: alice\n".into())
            } else {
                Err(AppError::msg("Changelist contains shelved files."))
            }
        })
        .unwrap_err();
        assert!(error.to_string().contains("shelved"));
        assert_eq!(
            calls,
            [vec!["change", "-o", "42"], vec!["change", "-d", "42"]]
        );
    }

    #[test]
    fn move_file_validates_destinations_before_any_cli_call() {
        let temporary = TestDirectory::new("move-paths");
        let source = temporary.0.join("source.txt");
        fs::write(&source, b"local edits\n").unwrap();
        fs::write(temporary.0.join("existing.txt"), b"keep\n").unwrap();
        let connection = mutation_connection(&temporary.0);
        for invalid in [
            "../escape.txt",
            "/outside.txt",
            "C:/outside.txt",
            "a/../b.txt",
            "missing/file.txt",
            "existing.txt",
            "file...txt",
            "",
        ] {
            assert!(
                move_file_with(&connection, &source.to_string_lossy(), invalid, |_| panic!(
                    "invalid destination reached CLI"
                ))
                .is_err()
            );
        }
        assert_eq!(fs::read(&source).unwrap(), b"local edits\n");
        assert_eq!(
            fs::read(temporary.0.join("existing.txt")).unwrap(),
            b"keep\n"
        );
    }

    #[test]
    fn move_file_rejects_unversioned_files_without_checking_them_out() {
        let temporary = TestDirectory::new("move-unversioned");
        let source = temporary.0.join("local.txt");
        fs::write(&source, b"keep local content\n").unwrap();
        let connection = mutation_connection(&temporary.0);
        let error = move_file_with(
            &connection,
            &source.to_string_lossy(),
            "target.txt",
            |args| {
                assert_eq!(&args[..4], &["-ztag", "fstat", "-T", "depotFile,action"]);
                Ok(String::new())
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Choose a versioned workspace file.");
        assert_eq!(fs::read(source).unwrap(), b"keep local content\n");
        assert!(!temporary.0.join("target.txt").exists());
    }

    #[test]
    fn move_file_keeps_literal_leading_spaces_in_destination_folders_and_names() {
        let temporary = TestDirectory::new("move-literal-spaces");
        let source = temporary.0.join("source.txt");
        fs::write(&source, b"local edits\n").unwrap();
        fs::create_dir(temporary.0.join("folder")).unwrap();
        let intended = temporary.0.join(" folder");
        fs::create_dir(&intended).unwrap();
        let (actual_source, destination) = move_file_paths(
            &temporary.0,
            &source.to_string_lossy(),
            " folder/ target.txt",
        )
        .unwrap();
        assert_eq!(actual_source, fs::canonicalize(&source).unwrap());
        assert_eq!(
            destination,
            fs::canonicalize(&intended).unwrap().join(" target.txt")
        );
        assert!(!temporary.0.join("folder/ target.txt").exists());
        assert_eq!(fs::read(&source).unwrap(), b"local edits\n");
    }

    #[cfg(unix)]
    #[test]
    fn move_file_keeps_trailing_spaces_in_source_and_destination_directories() {
        let temporary = TestDirectory::new("move-trailing-spaces");
        let source_directory = temporary.0.join("source folder ");
        let target_directory = temporary.0.join("target folder ");
        fs::create_dir(&source_directory).unwrap();
        fs::create_dir(&target_directory).unwrap();
        let source = source_directory.join("source.txt");
        fs::write(&source, b"local edits\n").unwrap();
        let (actual_source, destination) = move_file_paths(
            &temporary.0,
            &source.to_string_lossy(),
            "target folder /target.txt",
        )
        .unwrap();
        assert_eq!(actual_source, fs::canonicalize(&source).unwrap());
        assert_eq!(
            destination,
            fs::canonicalize(&target_directory)
                .unwrap()
                .join("target.txt")
        );
    }

    #[test]
    fn move_file_preserves_changelist_escapes_filespecs_and_keeps_edits_after_failure() {
        let temporary = TestDirectory::new("move-command");
        let source = temporary.0.join("source #@%.txt");
        fs::write(&source, b"local edits\n").unwrap();
        let connection = mutation_connection(&temporary.0);
        for action in ["", "edit", "add", "move/add"] {
            let mut calls = Vec::new();
            let result = move_file_with(
                &connection,
                &source.to_string_lossy(),
                "target #@%.txt",
                |args| {
                    calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                    if args[0] == "-ztag" {
                        assert_eq!(&args[1..4], &["fstat", "-T", "depotFile,action"]);
                        Ok(format!(
                            "... depotFile //depot/source.txt\n... action {action}\n"
                        ))
                    } else if args[0] == "move" {
                        Err(AppError::msg("Move rejected."))
                    } else {
                        Ok(String::new())
                    }
                },
            );
            assert!(result.is_err());
            assert_eq!(calls.len(), if action.is_empty() { 3 } else { 2 });
            let last = calls.last().unwrap();
            assert_eq!(last[0], "move");
            assert_eq!(last.len(), 3);
            assert!(last[1].ends_with("source %23%40%25.txt"));
            assert!(last[2].ends_with("target %23%40%25.txt"));
            assert!(!calls
                .iter()
                .flatten()
                .any(|arg| arg == "-f" || arg == "-c" || arg == "revert"));
            assert_eq!(fs::read(&source).unwrap(), b"local edits\n");
        }
    }

    #[test]
    fn workspace_directories_keep_absolute_paths_and_reject_parent_escapes() {
        let temporary = TestDirectory::new("directory");
        let root = temporary.0.join("client");
        let src = root.join("src");
        let outside = temporary.0.join("outside");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(src.join("file.txt"), b"content").unwrap();
        fs::write(outside.join("private.txt"), b"outside").unwrap();

        assert_eq!(workspace_directory(&root, "src").unwrap(), src);
        assert_eq!(
            workspace_directory(&root, &src.to_string_lossy()).unwrap(),
            src
        );
        assert_eq!(workspace_directory(&root, "").unwrap(), root);
        assert!(workspace_directory(&root, "../outside").is_err());
        assert!(workspace_directory(&root, &outside.to_string_lossy()).is_err());

        let connection = P4Connection {
            root: root.to_string_lossy().into_owned(),
            port: String::new(),
            user: String::new(),
            client: String::new(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        };
        assert_eq!(list_dir(&connection, "src").unwrap()[0].name, "file.txt");
        assert!(list_dir(&connection, "../outside").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn workspace_directories_reject_symlinks_to_outside_folders() {
        let temporary = TestDirectory::new("symlink");
        let root = temporary.0.join("client");
        let outside = temporary.0.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(workspace_directory(&root, "link").is_err());
        assert!(workspace_directory(&root, "link/..").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn a_local_diff_path_matches_the_workspace_file() {
        let mut same = BTreeSet::new();
        same.insert(fold_path(r"C:\work\client\Config\IOS\mobile.ini"));
        assert!(path_is_unchanged(
            &same,
            "//depot/main/client/Config/IOS/mobile.ini",
            r"C:\work\client\Config\IOS\mobile.ini",
        ));
        assert!(!path_is_unchanged(
            &same,
            "//depot/main/client/project.json",
            r"C:\work\client\project.json",
        ));
        assert!(path_is_unchanged(
            &same,
            "//depot/main/client/Config/IOS/mobile.ini",
            "c:/WORK/client/config/ios/mobile.ini",
        ));
        assert_eq!(
            normalize_location(r"C:\work\client\Config\...", false),
            "c:/work/client/config"
        );
    }

    #[test]
    #[cfg(unix)]
    fn posix_local_path_identity_preserves_case_and_backslashes() {
        let local = "/work/client/Config/name\\";
        let mut same = BTreeSet::new();
        same.insert(fold_path(local));
        assert!(path_is_unchanged(&same, "", local));
        assert!(!path_is_unchanged(&same, "", "/work/client/config/name\\"));
        assert!(!path_is_unchanged(&same, "", "/work/client/Config/name/"));
        assert_eq!(normalize_location(local, false), local);
        assert_eq!(mapped_location(local, false), local);
        assert_eq!(
            normalize_location("/work/client/name\\...", false),
            "/work/client/name\\..."
        );
    }

    #[test]
    fn directory_revisions_append_a_wildcard_after_escaping_the_path() {
        let path = if cfg!(windows) {
            "C:/work/docs @ home"
        } else {
            "/work/docs @ home"
        };
        assert_eq!(
            revision_file_spec("", path, true, "@release,@release").unwrap(),
            format!("{}/...@release,@release", path.replace('@', "%40"))
        );
        assert_eq!(
            revision_file_spec("", "//depot/docs%23notes", true, "#4").unwrap(),
            "//depot/docs%23notes/...#4"
        );
        assert!(revision_file_spec("", "-f", true, "").is_err());
    }

    #[test]
    fn file_content_diffs_keep_additions_deletions_and_missing_final_newlines() {
        let added = content_file_diff("notes.txt", b"first\r\nlast", false, false, false);
        assert_eq!(added.lines.len(), 3);
        assert_eq!(added.lines[1].content, "first");
        assert_eq!(added.lines[2].content, "last");
        assert_eq!(added.lines[2].kind, "add");
        assert_eq!(added.lines[2].new_lineno, Some(2));
        assert_eq!(added.lines[2].old_lineno, None);
        let deleted = content_file_diff("notes.txt", b"first\nlast", false, false, true);
        assert_eq!(deleted.lines[0].content, "@@ -1,2 +0,0 @@");
        assert_eq!(deleted.lines[2].kind, "delete");
        assert_eq!(deleted.lines[2].old_lineno, Some(2));
        assert_eq!(deleted.lines[2].new_lineno, None);
        assert!(content_file_diff("image.bin", b"data\0", false, false, false).binary);
        assert!(content_file_diff("image.bin", b"data", false, true, false).binary);
        assert!(content_file_diff("notes.txt", b"data", true, false, false).truncated);
        let many = "line\n".repeat(5_000);
        let limited = content_file_diff("notes.txt", many.as_bytes(), false, false, false);
        assert_eq!(limited.lines.len(), 4_000);
        assert!(limited.truncated);
        let unicode =
            content_file_diff("notes.txt", "cafe\u{301}\n".as_bytes(), false, false, false);
        assert_eq!(unicode.lines[1].content, "cafe\u{301}");
    }

    #[test]
    fn workspace_discovery_keeps_the_reachable_endpoint_instead_of_server_identity() {
        let root = Path::new("/work/client");
        let mut env = P4Env {
            cwd: root.to_path_buf(),
            port: "ssl:perforce.example.com:1666".into(),
            user: "alice".into(),
            client: "dev-pc".into(),
            charset: String::new(),
        };
        let info = "... clientName dev-pc\n... clientRoot /work/client\n... serverAddress internal.example.com:1666\n... userName alice\n";
        assert_eq!(
            connection_from_info(root, &env, info).unwrap().port,
            env.port
        );
        env.port.clear();
        assert_eq!(
            connection_from_info(root, &env, info).unwrap().port,
            "internal.example.com:1666"
        );
    }

    #[test]
    fn description_search_matches_text_outside_the_loaded_page() {
        let change = P4Changelist {
            id: "900".to_string(),
            user: "alice".to_string(),
            client: "alice_main".to_string(),
            status: "submitted".to_string(),
            description: "Fix the stream switch".to_string(),
            time: 0,
            shelved: false,
            files: Vec::new(),
            stream: None,
            shelved_stream: None,
        };
        assert!(change_matches(&change, "stream"));
        assert!(change_matches(&change, "900"));
        assert!(!change_matches(&change, "missing"));
    }

    #[test]
    fn workspace_search_keeps_hierarchy_and_skips_generated_trees() {
        let root = std::env::temp_dir().join(format!(
            "rebaseraven-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("client").join("src")).unwrap();
        fs::write(
            root.join("client").join("src").join("notes.bat"),
            b"@echo off",
        )
        .unwrap();
        fs::create_dir_all(root.join("Intermediate").join("deep")).unwrap();
        fs::write(
            root.join("Intermediate").join("deep").join("secret.txt"),
            b"x",
        )
        .unwrap();
        fs::create_dir_all(root.join(".cache")).unwrap();

        let match_workspace_files = |root: &Path, query| {
            search::Walker::new(root.to_owned(), query)
                .page(&false.into())
                .unwrap()
                .0
        };
        let hits = match_workspace_files(&root, "notes");
        assert!(hits.iter().any(|hit| !hit.dir && hit.name == "notes.bat"));
        assert!(hits.iter().all(|hit| !hit.path.contains("secret.txt")));

        let folders = match_workspace_files(&root, "cache");
        assert!(folders
            .iter()
            .any(|hit| hit.dir && hit.name.eq_ignore_ascii_case(".cache")));

        let generated = match_workspace_files(&root, "secret");
        assert!(generated.is_empty());
        let named = match_workspace_files(&root, "intermediate");
        assert!(named
            .iter()
            .any(|hit| hit.dir && hit.name.eq_ignore_ascii_case("Intermediate")));
        assert!(named.iter().all(|hit| hit.dir));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn history_paging_is_a_changelist_range() {
        let mut args = Vec::new();
        push_history_range(&mut args, None);
        assert!(args.is_empty());
        push_history_range(&mut args, Some(1));
        assert!(args.is_empty());
        push_history_range(&mut args, Some(1200));
        assert_eq!(args, vec!["@1,@1199".to_string()]);
    }
}

#[cfg(test)]
mod stream_record_tests {
    use super::*;
    #[test]
    fn stream_records_are_kept_separate_from_file_records() {
        let row = parse_ztag(
            "... stream //project/dev\n... haveChange 40\n... action edit\n... change default\n",
        )
        .remove(0);
        let stream = stream_from_record(&row).unwrap();
        assert_eq!(stream.path, "//project/dev");
        assert_eq!(stream.base_change, "40");
        assert!(files_from_groups(
            &P4Connection {
                root: String::new(),
                port: String::new(),
                user: String::new(),
                client: String::new(),
                charset: String::new(),
                stream: None,
                server: String::new()
            },
            &indexed_groups(&row),
            false
        )
        .is_empty());
        let file = parse_ztag("... depotFile //project/dev/readme.md\n... rev 3\n").remove(0);
        assert!(stream_from_record(&file).is_none());
    }
    #[test]
    fn shelf_and_submitted_metadata_expose_streams_without_inventing_files() {
        let row = parse_ztag("... change 42\n... stream //project/dev\n... streamHaveChange 40\n... status submitted\n").remove(0);
        let shelf = change_from_record(&row, Vec::new(), true);
        assert!(shelf.stream.is_none());
        assert_eq!(shelf.shelved_stream.unwrap().base_change, "40");
        assert!(shelf.files.is_empty());
        let submitted = change_from_record(&row, Vec::new(), false);
        assert!(submitted.shelved_stream.is_none());
        assert_eq!(submitted.stream.unwrap().path, "//project/dev");
        assert!(submitted.files.is_empty());
    }
}

#[cfg(test)]
mod pending_action_tests {
    use super::*;
    fn connection() -> P4Connection {
        P4Connection {
            root: String::new(),
            port: String::new(),
            user: "alice".into(),
            client: "alice-main".into(),
            charset: String::new(),
            stream: None,
            server: String::new(),
        }
    }
    #[test]
    fn unchanged_revert_keeps_the_requested_scope() {
        let connection = connection();
        assert_eq!(
            revert_unchanged_args(&connection, Some("42"), &[]).unwrap(),
            ["revert", "-a", "-c", "42", "//alice-main/..."]
        );
        assert_eq!(
            revert_unchanged_args(
                &connection,
                Some("default"),
                &["//depot/main/app.ts".into()]
            )
            .unwrap(),
            ["revert", "-a", "-c", "default", "//depot/main/app.ts"]
        );
        assert_eq!(
            revert_unchanged_args(&connection, None, &["//depot/main/app.ts".into()]).unwrap(),
            ["revert", "-a", "//depot/main/app.ts"]
        );
        assert!(revert_unchanged_args(&connection, Some("-a"), &[]).is_err());
        assert!(revert_unchanged_args(&connection, None, &[String::new()]).is_err());
    }
    #[test]
    fn shelf_submission_rejects_opened_or_foreign_changes() {
        let connection = connection();
        let mut change = P4Changelist {
            id: "42".into(),
            user: "alice".into(),
            client: "alice-main".into(),
            status: "pending".into(),
            description: "Update navigation".into(),
            time: 0,
            shelved: true,
            files: Vec::new(),
            stream: None,
            shelved_stream: None,
        };
        assert!(validate_shelf_submission(&connection, &change).is_ok());
        change.stream = Some(P4StreamChange {
            path: "//project/main".into(),
            base_change: "40".into(),
        });
        assert!(validate_shelf_submission(&connection, &change).is_err());
        change.stream = None;
        change.files.push(P4File {
            depot_path: "//project/main/app.ts".into(),
            local_path: String::new(),
            action: "edit".into(),
            rev: "1".into(),
            shelved: true,
            binary: false,
            status: String::new(),
            detail: String::new(),
        });
        assert!(validate_shelf_submission(&connection, &change).is_ok());
        change.files[0].shelved = false;
        assert!(validate_shelf_submission(&connection, &change).is_err());
        change.files.clear();
        change.user = "bob".into();
        assert!(validate_shelf_submission(&connection, &change).is_err());
        change.user = "alice".into();
        change.shelved = false;
        assert!(validate_shelf_submission(&connection, &change).is_err());
    }
}
