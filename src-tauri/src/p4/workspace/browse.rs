//! Workspace and depot browsing, ignore rules, and file status.
use super::{
    env_for, field, find_config, read_config, run_ok, unescape_p4_path, workspace_directory,
    workspace_file_spec, P4Changelist, P4Connection, P4DirEntry, P4EntryStatus, P4FileSearch,
};
use crate::error::{AppError, AppResult};
use crate::git::strip_verbatim_prefix;
use crate::p4::cli::{self, P4Env};
use crate::p4::parse::{
    indexed_groups, parse_p4_set, parse_unchanged_diff_paths, parse_ztag, valid_depot_path,
    ZtagRecord,
};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

pub fn list_dir(connection: &P4Connection, relative: &str) -> AppResult<Vec<P4DirEntry>> {
    let root = PathBuf::from(&connection.root);
    let dir = workspace_directory(&root, relative)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        entries.push(P4DirEntry {
            ignored: false,
            name,
            path: entry.path().to_string_lossy().into_owned(),
            dir: file_type.is_dir(),
            status: String::new(),
            detail: String::new(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .dir
            .cmp(&left.dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    annotate_ignored(&env_for(connection), &mut entries);
    // Icons come from a later fstat so the names can paint without a server round trip.
    Ok(entries)
}

/// Query the native client so nested ignore files, exclusions and P4IGNORE settings agree with P4.
pub(super) fn annotate_ignored(env: &P4Env, entries: &mut [P4DirEntry]) {
    if entries.is_empty() {
        return;
    }
    let setting = run_ok(env, &["set", "P4IGNORE"], None).ok().map(|output| {
        let values = parse_p4_set(&output);
        ignore_file_setting(&env.cwd, values.get("P4IGNORE").map(String::as_str))
    });
    annotate_ignored_with(entries, &mut |args| {
        let mut options = Vec::new();
        let value;
        if let Some(setting) = &setting {
            value = format!("P4IGNORE={setting}");
            options.extend(["-E", value.as_str()]);
        }
        options.extend_from_slice(args);
        run_ok(env, &options, None)
    });
}

fn ignore_file_setting(directory: &Path, native: Option<&str>) -> String {
    if let Some(value) = native.filter(|value| !value.trim().is_empty()) {
        return value.to_string();
    }
    // Repository discovery also accepts conventional config names without P4CONFIG.
    if let Some(config) = find_config(directory) {
        for parent in config.directory.ancestors() {
            if let Some(value) = read_config(&parent.join(&config.filename))
                .and_then(|values| values.get("P4IGNORE").cloned())
                .filter(|value| !value.trim().is_empty())
            {
                return value;
            }
        }
    }
    // Older P4 clients do not supply the standard names automatically.
    ".p4ignore;p4ignore.txt".to_string()
}

fn annotate_ignored_with(
    entries: &mut [P4DirEntry],
    run: &mut impl FnMut(&[&str]) -> AppResult<String>,
) {
    // P4 selects file or directory matching for the whole batch from its first
    // target. Directory matching keeps containers with included descendants.
    for directories in [true, false] {
        let mut targets = entries
            .iter_mut()
            .filter(|entry| entry.dir == directories)
            .collect::<Vec<_>>();
        for chunk in targets.chunks_mut(40) {
            let paths = chunk
                .iter()
                .map(|entry| {
                    if entry.dir {
                        format!("{}/", entry.path.trim_end_matches(['/', '\\']))
                    } else {
                        entry.path.clone()
                    }
                })
                .collect::<Vec<_>>();
            let args = ["ignores", "-i"]
                .into_iter()
                .chain(paths.iter().map(String::as_str))
                .collect::<Vec<_>>();
            let Ok(output) = run(&args) else {
                continue;
            };
            let ignored = output
                .lines()
                .filter_map(|line| line.strip_suffix(" ignored"))
                .map(|path| local_path_key(path.trim_end_matches(['/', '\\'])))
                .collect::<BTreeSet<_>>();
            for (entry, path) in chunk.iter_mut().zip(&paths) {
                entry.ignored =
                    ignored.contains(&local_path_key(path.trim_end_matches(['/', '\\'])));
            }
        }
    }
}

/// One level of the depot, starting at the depot roots when `path` is empty.
pub fn list_depot(connection: &P4Connection, path: &str) -> AppResult<Vec<P4DirEntry>> {
    let env = env_for(connection);
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path == "//" {
        let stdout = run_ok(&env, &["-ztag", "depots"], None)?;
        let mut entries = Vec::new();
        for record in parse_ztag(&stdout) {
            let name = field(&record, "name");
            if name.is_empty() || name.contains([' ', '*', '?', '#', '@', '/']) {
                continue;
            }
            entries.push(P4DirEntry {
                ignored: false,
                name: name.clone(),
                path: format!("//{name}"),
                dir: true,
                status: String::new(),
                detail: String::new(),
            });
        }
        sort_dir_entries(&mut entries);
        return Ok(entries);
    }
    if !valid_depot_path(path) {
        return Err(AppError::msg(
            "Depot path should look like //depot/project.",
        ));
    }
    let spec = format!("{path}/*");
    let env_files = env.clone();
    let spec_files = spec.clone();
    let (dir_records, file_records) = std::thread::scope(|scope| {
        let dirs = scope.spawn(|| depot_listing(&env, &["-ztag", "dirs", &spec]));
        let files = scope.spawn(|| depot_listing(&env_files, &["-ztag", "files", &spec_files]));
        (dirs.join(), files.join())
    });
    let dir_records = dir_records.map_err(|_| AppError::msg("Could not list depot folders."))??;
    let file_records = file_records.map_err(|_| AppError::msg("Could not list depot files."))??;
    let mut entries = Vec::new();
    for record in dir_records {
        let dir = field(&record, "dir");
        if !valid_depot_path(&dir) {
            continue;
        }
        entries.push(P4DirEntry {
            ignored: false,
            name: depot_base(&dir),
            path: dir,
            dir: true,
            status: String::new(),
            detail: String::new(),
        });
    }
    for record in file_records {
        let file = field(&record, "depotFile");
        if !valid_depot_path(&file) {
            continue;
        }
        entries.push(P4DirEntry {
            ignored: false,
            name: depot_base(&file),
            path: file,
            dir: false,
            status: String::new(),
            detail: String::new(),
        });
    }
    sort_dir_entries(&mut entries);
    Ok(entries)
}

pub fn cancel_depot_search(connection: &P4Connection) {
    cli::cancel_depot_search(&env_for(connection));
}

pub fn search_depot(connection: &P4Connection, query: &str) -> AppResult<P4FileSearch> {
    let env = env_for(connection);
    let job = cli::depot_search_job(&env);
    let generation = job.begin();
    let plan = depot_search_plan(connection, &env, query)?;
    if plan.roots.is_empty() {
        return Ok(P4FileSearch {
            hits: Vec::new(),
            truncated: false,
            scope: plan.scope,
        });
    }
    // `//.../*name*` walks every depot, including engine depots that are not in
    // this stream. Scan the stream (or an explicit //depot prefix) instead, and
    // kill the previous scan when the query changes. Status comes from a later
    // fstat, which would add another round trip on top of the scan.
    let mut hits = Vec::new();
    let mut seen = BTreeSet::new();
    let mut truncated = false;
    for root in &plan.roots {
        if hits.len() >= DEPOT_SEARCH_LIMIT {
            truncated = true;
            break;
        }
        let remaining = DEPOT_SEARCH_LIMIT - hits.len();
        let spec = format!("{root}/.../*{}*", plan.needle);
        let Some(records) = tracked_depot_files(&job, &env, &spec, remaining, generation)? else {
            return Ok(P4FileSearch {
                hits: Vec::new(),
                truncated: false,
                scope: String::new(),
            });
        };
        for record in records {
            let file = field(&record, "depotFile");
            if !valid_depot_path(&file) || !seen.insert(file.clone()) {
                continue;
            }
            hits.push(P4DirEntry {
                ignored: false,
                name: depot_base(&file),
                path: file,
                dir: false,
                status: String::new(),
                detail: String::new(),
            });
            if hits.len() >= DEPOT_SEARCH_LIMIT {
                truncated = true;
                break;
            }
        }
    }
    Ok(P4FileSearch {
        hits,
        truncated,
        scope: plan.scope,
    })
}

const DEPOT_SEARCH_LIMIT: usize = 200;

struct DepotSearchPlan {
    roots: Vec<String>,
    needle: String,
    scope: String,
}

fn depot_search_plan(
    connection: &P4Connection,
    env: &P4Env,
    query: &str,
) -> AppResult<DepotSearchPlan> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(DepotSearchPlan {
            roots: Vec::new(),
            needle: String::new(),
            scope: String::new(),
        });
    }
    if query.starts_with("//") || query.contains('/') {
        let Some((root, needle)) = explicit_depot_query(query) else {
            return Ok(DepotSearchPlan {
                roots: Vec::new(),
                needle: String::new(),
                scope: "Use a file name, or //depot/name.".to_string(),
            });
        };
        if needle.chars().count() < 2 {
            return Ok(DepotSearchPlan {
                roots: Vec::new(),
                needle,
                scope: "Type at least 2 characters.".to_string(),
            });
        }
        let scope = format!("In {root}");
        return Ok(DepotSearchPlan {
            roots: vec![root],
            needle,
            scope,
        });
    }
    if !plain_depot_name(query) {
        return Err(AppError::msg(
            "Search with a file name, or a path like //depot/name.",
        ));
    }
    if query.chars().count() < 2 {
        return Ok(DepotSearchPlan {
            roots: Vec::new(),
            needle: query.to_string(),
            scope: "Type at least 2 characters.".to_string(),
        });
    }
    if let Some(stream) = connection
        .stream
        .as_deref()
        .map(str::trim)
        .filter(|stream| valid_depot_path(stream))
    {
        let root = stream.trim_end_matches('/').to_string();
        let scope = format!("In {root}");
        return Ok(DepotSearchPlan {
            roots: vec![root],
            needle: query.to_string(),
            scope,
        });
    }
    let spec = run_ok(env, &["client", "-o", &connection.client], None)?;
    let roots = client_view_roots(&spec);
    if roots.is_empty() {
        return Err(AppError::msg("This workspace has no depot view to search."));
    }
    let scope = if roots.len() == 1 {
        format!("In {}", roots[0])
    } else {
        "In the client view".to_string()
    };
    Ok(DepotSearchPlan {
        roots,
        needle: query.to_string(),
        scope,
    })
}

/// `//depot/dir/name` or `depot/dir/name` searches that directory only.
/// An unfinished path returns `None` so typing does not raise an error.
fn explicit_depot_query(query: &str) -> Option<(String, String)> {
    if !query.starts_with("//") && !query.contains('/') {
        return None;
    }
    let scoped = if query.starts_with("//") {
        query.to_string()
    } else {
        format!("//{query}")
    };
    let path = scoped.trim().trim_end_matches('/');
    let (dir, name) = path.rsplit_once('/')?;
    if !valid_depot_path(dir) || !plain_depot_name(name) {
        return None;
    }
    Some((dir.to_string(), name.to_string()))
}

fn plain_depot_name(name: &str) -> bool {
    !name.is_empty()
        && !name
            .chars()
            .any(|ch| matches!(ch, ' ' | '\\' | '/' | '?' | '#' | '@' | '*' | '\n' | '\r'))
}

fn tracked_depot_files(
    job: &cli::P4Job,
    env: &P4Env,
    spec: &str,
    limit: usize,
    generation: u64,
) -> AppResult<Option<Vec<ZtagRecord>>> {
    let limit = limit.to_string();
    match job.run(env, &["-ztag", "files", "-m", &limit, spec], generation) {
        Ok(None) => Ok(None),
        Ok(Some(stdout)) => Ok(Some(parse_ztag(&stdout))),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no such file") || message.contains("no file(s)") {
                Ok(Some(Vec::new()))
            } else if job.current() != generation {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn client_view_roots(spec: &str) -> Vec<String> {
    let mut roots = Vec::new();
    let mut in_view = false;
    for raw in spec.split('\n') {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_view = trimmed
                .split_once(':')
                .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("View"));
            continue;
        }
        if !in_view || trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let mapping = trimmed.trim_start_matches('+');
        let depot = if let Some(quoted) = mapping.strip_prefix('"') {
            quoted.split('"').next()
        } else {
            mapping.split_whitespace().next()
        };
        let Some(depot) = depot else {
            continue;
        };
        let Some(root) = mapping_root(depot) else {
            continue;
        };
        if roots.contains(&root) {
            continue;
        }
        roots.push(root);
    }
    roots
}

fn mapping_root(depot: &str) -> Option<String> {
    let depot = depot.trim().trim_start_matches('+');
    if !depot.starts_with("//") {
        return None;
    }
    let mut parts = Vec::new();
    for part in depot.trim_start_matches("//").split('/') {
        if part.is_empty() || part == "..." || part.contains(['*', '%']) {
            break;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    let root = format!("//{}", parts.join("/"));
    valid_depot_path(&root).then_some(root)
}

fn depot_listing(env: &P4Env, args: &[&str]) -> AppResult<Vec<ZtagRecord>> {
    match run_ok(env, args, None) {
        Ok(stdout) => Ok(parse_ztag(&stdout)),
        Err(error) => {
            let message = error.to_string().to_lowercase();
            if message.contains("no such file") {
                Ok(Vec::new())
            } else {
                Err(error)
            }
        }
    }
}

fn depot_base(path: &str) -> String {
    unescape_p4_path(
        path.trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(path),
    )
}

fn sort_dir_entries(entries: &mut [P4DirEntry]) {
    entries.sort_by(|left, right| {
        right
            .dir
            .cmp(&left.dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

/// Have/head and open state for one directory. The file list itself does not wait on this.
pub fn listing_status(
    connection: &P4Connection,
    directory: &str,
    depot: bool,
) -> AppResult<Vec<P4EntryStatus>> {
    if depot {
        let directory = directory.trim().trim_end_matches('/');
        if directory.is_empty() || directory == "//" {
            return Ok(Vec::new());
        }
        if !valid_depot_path(directory) {
            return Err(AppError::msg(
                "Depot path should look like //depot/project.",
            ));
        }
        let spec = format!("{directory}/*");
        return Ok(statuses_from(&env_for(connection), &[spec], true));
    }
    let root = PathBuf::from(&connection.root);
    let dir = workspace_directory(&root, directory)?;
    let pattern = PathBuf::from(workspace_file_spec(
        &connection.root,
        &dir.to_string_lossy(),
    ))
    .join("*")
    .to_string_lossy()
    .into_owned();
    Ok(statuses_from(&env_for(connection), &[pattern], false))
}

fn statuses_from(env: &P4Env, paths: &[String], depot: bool) -> Vec<P4EntryStatus> {
    let records = fstat_records(env, paths);
    let mut rows = Vec::new();
    let mut depots = Vec::new();
    let mut locals = Vec::new();
    let mut edits = Vec::new();
    for record in &records {
        let path = field(record, if depot { "depotFile" } else { "clientFile" });
        if path.is_empty() {
            continue;
        }
        let depot_path = field(record, "depotFile");
        let (status, detail) = status_of(record);
        if status == "edit" && depot_path.starts_with("//") {
            edits.push(depot_path.clone());
        }
        let local = field(record, "clientFile");
        depots.push(depot_path);
        locals.push(local);
        rows.push(P4EntryStatus {
            path,
            status,
            detail,
        });
    }
    let same = unchanged_opened(env, &edits);
    if !same.is_empty() {
        for (row, (depot_path, local)) in rows.iter_mut().zip(depots.into_iter().zip(locals)) {
            if row.status == "edit" && path_is_unchanged(&same, &depot_path, &local) {
                mark_clean_checkout(&mut row.status, &mut row.detail);
            }
        }
    }
    rows
}

/// Opened files whose workspace copy matches the have revision.
/// `p4 diff -sr` exits 1 when any compared file differs, and still prints the identical ones.
fn unchanged_opened(env: &P4Env, paths: &[String]) -> BTreeSet<String> {
    let mut wanted = paths.to_vec();
    wanted.sort();
    wanted.dedup();
    let mut same = BTreeSet::new();
    if wanted.is_empty() {
        return same;
    }
    for chunk in cli::file_batches(&wanted) {
        let Ok(output) = cli::run_p4_files(env, &["diff", "-sr"], chunk) else {
            continue;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if p4_session_expired(&stdout) || p4_session_expired(&stderr) {
            return BTreeSet::new();
        }
        if !matches!(output.status.code(), Some(0) | Some(1)) {
            continue;
        }
        same.extend(
            parse_unchanged_diff_paths(&stdout)
                .into_iter()
                .map(|path| fold_path(&path)),
        );
    }
    same
}

pub(super) fn path_is_unchanged(same: &BTreeSet<String>, depot: &str, local: &str) -> bool {
    (!depot.is_empty() && same.contains(depot))
        || (!local.is_empty() && same.contains(&local_path_key(local)))
}

fn p4_session_expired(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("please login")
        || lower.contains("session has expired")
        || lower.contains("ticket expired")
}

fn mark_clean_checkout(status: &mut String, detail: &mut String) {
    *status = "clean".to_string();
    *detail = detail.replacen("Checked out for edit", "Checked out, no changes", 1);
}

pub(super) fn clear_versioned_ignores(entries: &mut [P4DirEntry]) {
    let parents = entries
        .iter()
        .filter(|entry| !entry.dir && !matches!(entry.status.as_str(), "" | "local"))
        .flat_map(|entry| Path::new(&entry.path).ancestors().skip(1))
        .map(|parent| local_path_key(&parent.to_string_lossy()))
        .collect::<BTreeSet<_>>();
    for entry in entries {
        if (!entry.dir && !matches!(entry.status.as_str(), "" | "local"))
            || (entry.dir && parents.contains(&local_path_key(&entry.path)))
        {
            entry.ignored = false;
        }
    }
}

pub(super) fn include_search_parents(root: &Path, hits: &mut Vec<P4DirEntry>) {
    let mut known = hits
        .iter()
        .map(|entry| local_path_key(&entry.path))
        .collect::<BTreeSet<_>>();
    let parents = hits
        .iter()
        .flat_map(|entry| {
            Path::new(&entry.path)
                .ancestors()
                .skip(1)
                .take_while(|parent| *parent != root && parent.starts_with(root))
                .map(Path::to_path_buf)
        })
        .collect::<BTreeSet<_>>();
    for directory in parents {
        if known.insert(local_path_key(&directory.to_string_lossy())) {
            if let Some(name) = directory.file_name() {
                hits.push(plain_dir(&name.to_string_lossy(), &directory));
            }
        }
    }
}

pub(super) fn plain_dir(name: &str, path: &Path) -> P4DirEntry {
    P4DirEntry {
        ignored: false,
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        dir: true,
        status: String::new(),
        detail: String::new(),
    }
}

pub(super) fn generated_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "intermediate"
            | "saved"
            | "deriveddatacache"
            | "binaries"
            | ".vs"
            | "library"
    )
}

pub(super) fn annotate_paths(connection: &P4Connection, files: &mut [P4DirEntry]) {
    if files.is_empty() {
        return;
    }
    let env = env_for(connection);
    let mut known = HashMap::<String, (String, String)>::new();
    let mut depot_of = HashMap::<String, String>::new();
    let paths: Vec<String> = files
        .iter()
        .map(|file| workspace_file_spec(&connection.root, &file.path))
        .collect();
    for chunk in paths.chunks(40) {
        for record in fstat_records(&env, chunk) {
            let client_file = field(&record, "clientFile");
            if client_file.is_empty() {
                continue;
            }
            let key = local_path_key(&client_file);
            let depot_path = field(&record, "depotFile");
            if depot_path.starts_with("//") {
                depot_of.insert(key.clone(), depot_path);
            }
            known.insert(key, status_of(&record));
        }
    }
    if known.is_empty() {
        return;
    }
    let edits = edits_in(&known, &depot_of, files);
    let same = unchanged_opened(&env, &edits);
    for file in files {
        let key = local_path_key(&file.path);
        let Some((status, detail)) = known.get(&key) else {
            file.status = "local".to_string();
            file.detail = "Not in the depot".to_string();
            continue;
        };
        file.status.clone_from(status);
        file.detail.clone_from(detail);
        let depot = depot_of.get(&key).map(String::as_str).unwrap_or("");
        if file.status == "edit" && path_is_unchanged(&same, depot, &file.path) {
            mark_clean_checkout(&mut file.status, &mut file.detail);
        }
    }
}

fn edits_in(
    known: &HashMap<String, (String, String)>,
    depot_of: &HashMap<String, String>,
    files: &[P4DirEntry],
) -> Vec<String> {
    files
        .iter()
        .filter_map(|file| {
            let key = local_path_key(&file.path);
            let (status, _) = known.get(&key)?;
            if status != "edit" {
                return None;
            }
            depot_of.get(&key).cloned()
        })
        .collect()
}

pub(super) fn fold_path(path: &str) -> String {
    if path.starts_with("//") {
        path.to_string()
    } else {
        local_path_key(path)
    }
}

pub(super) fn local_path_key(path: &str) -> String {
    let path = strip_verbatim_prefix(path);
    if cfg!(windows) {
        path.replace('\\', "/").to_lowercase()
    } else {
        path
    }
}

pub(in crate::p4) fn annotate_pending(connection: &P4Connection, changes: &mut [P4Changelist]) {
    let env = env_for(connection);
    let mut paths = Vec::new();
    for change in changes.iter() {
        for file in &change.files {
            if file.depot_path.starts_with("//") {
                paths.push(file.depot_path.clone());
            }
        }
    }
    paths.sort();
    paths.dedup();
    let mut known = HashMap::new();
    for chunk in cli::file_batches(&paths) {
        for record in fstat_records(&env, chunk) {
            let depot = field(&record, "depotFile");
            if depot.is_empty() {
                continue;
            }
            known.insert(depot, record);
        }
    }
    for change in changes.iter_mut() {
        for file in &mut change.files {
            let record = known.get(&file.depot_path);
            if !file.shelved {
                if let Some(local) = record.and_then(|record| record.get("clientFile")) {
                    if Path::new(local).is_absolute() {
                        file.local_path.clone_from(local);
                    }
                }
            }
            let (status, detail) = combine_status(record.map(status_of), &file.action);
            file.status = status;
            file.detail = detail;
        }
    }
    let mut edits = Vec::new();
    for change in changes.iter() {
        for file in &change.files {
            if !file.shelved && file.status == "edit" && file.depot_path.starts_with("//") {
                edits.push(file.depot_path.clone());
            }
        }
    }
    let same = unchanged_opened(&env, &edits);
    if same.is_empty() {
        return;
    }
    for change in changes.iter_mut() {
        for file in &mut change.files {
            if file.shelved
                || file.status != "edit"
                || !path_is_unchanged(&same, &file.depot_path, &file.local_path)
            {
                continue;
            }
            mark_clean_checkout(&mut file.status, &mut file.detail);
        }
    }
}

fn combine_status(fstat: Option<(String, String)>, action: &str) -> (String, String) {
    let fallback = action_status(action);
    let Some((status, detail)) = fstat else {
        return fallback;
    };
    if matches!(status.as_str(), "current" | "local" | "") && !fallback.0.is_empty() {
        return fallback;
    }
    if (status == "stale" || status == "conflict")
        && !fallback.1.is_empty()
        && !detail.contains(fallback.1.as_str())
    {
        return (status, format!("{detail}\n{}", fallback.1));
    }
    (status, detail)
}

fn action_status(action: &str) -> (String, String) {
    let action = action.to_lowercase();
    if action.contains("delete") {
        ("delete".to_string(), "Marked for delete".to_string())
    } else if action.contains("add") {
        ("add".to_string(), "Marked for add".to_string())
    } else if action.contains("edit") {
        ("edit".to_string(), "Checked out for edit".to_string())
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        ("integrate".to_string(), "Opened for integrate".to_string())
    } else {
        (String::new(), String::new())
    }
}

const FSTAT_FIELDS: &str = "clientFile depotFile haveRev headRev action change ourLock otherOpen otherLock unresolved otherOpen0 otherAction0 otherChange0 otherOpen1 otherAction1 otherChange1 otherOpen2 otherAction2 otherChange2 otherOpen3 otherAction3 otherChange3";
const FSTAT_FIELDS_BASIC: &str =
    "clientFile depotFile haveRev headRev action change otherOpen otherLock unresolved";

fn fstat_records(env: &P4Env, paths: &[String]) -> Vec<ZtagRecord> {
    if paths.is_empty() {
        return Vec::new();
    }
    let stdout = fstat_stdout(env, FSTAT_FIELDS, paths)
        .or_else(|| fstat_stdout(env, FSTAT_FIELDS_BASIC, paths))
        .unwrap_or_default();
    parse_ztag(&stdout)
}

fn fstat_stdout(env: &P4Env, fields: &str, paths: &[String]) -> Option<String> {
    cli::run_p4_ok_files(env, &["-ztag", "fstat", "-T", fields], paths).ok()
}

struct OtherOpen {
    label: String,
    change: String,
    locked: bool,
}

fn status_of(record: &ZtagRecord) -> (String, String) {
    let action = field(record, "action").to_lowercase();
    let have = field(record, "haveRev").parse::<u64>().unwrap_or(0);
    let head = field(record, "headRev").parse::<u64>().unwrap_or(0);
    let others = field(record, "otherOpen").parse::<u64>().unwrap_or(0);
    let openers = other_opens(record);
    let locked = !field(record, "otherLock").is_empty() || openers.iter().any(|item| item.locked);
    let unresolved = record.contains_key("unresolved");
    let ours = action_phrase(&action);
    let (status, headline) = if unresolved {
        ("conflict", "Needs resolve".to_string())
    } else if action.contains("delete") {
        ("delete", "Marked for delete".to_string())
    } else if action.contains("add") {
        ("add", "Marked for add".to_string())
    } else if head > have && head > 0 {
        (
            "stale",
            if have == 0 {
                "Not synced".to_string()
            } else {
                "Not latest".to_string()
            },
        )
    } else if action.contains("edit") {
        ("edit", "Checked out for edit".to_string())
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        ("integrate", "Opened for integrate".to_string())
    } else if others > 0 || locked || !openers.is_empty() {
        let owner = openers
            .iter()
            .find(|item| item.locked)
            .or_else(|| openers.first());
        let headline = match owner {
            Some(owner) if owner.locked => format!("Locked by {}", owner.label),
            Some(owner) => format!("Opened by {}", owner.label),
            None if locked => "Locked by another user".to_string(),
            None => "Opened by another user".to_string(),
        };
        ("other", headline)
    } else if head > 0 {
        ("current", "Up to date".to_string())
    } else {
        ("local", "Not in the depot".to_string())
    };
    let depot = field(record, "depotFile");
    let mut lines = Vec::new();
    if depot.starts_with("//") {
        lines.push(depot);
    }
    lines.push(headline);
    if let Some(ours) = ours {
        push_line(&mut lines, ours.to_string());
        let change = field(record, "change");
        if !change.is_empty() && change != "default" {
            push_line(&mut lines, format!("Your changelist {change}"));
        }
    }
    if record.contains_key("ourLock") {
        push_line(&mut lines, "Locked by you".to_string());
    }
    for opener in &openers {
        note_opener(&mut lines, opener);
    }
    let named = openers.len() as u64;
    if named > 0 && others > named {
        let extra = others - named;
        let line = if extra == 1 {
            "1 more user has this file open".to_string()
        } else {
            format!("{extra} more users have this file open")
        };
        push_line(&mut lines, line);
    }
    if head > 0 {
        if have == 0 {
            push_line(&mut lines, format!("Head revision {head}"));
        } else if have == head {
            push_line(&mut lines, format!("Revision {have}"));
        } else {
            push_line(&mut lines, format!("Have revision {have}"));
            push_line(&mut lines, format!("Head revision {head}"));
        }
    }
    (status.to_string(), lines.join("\n"))
}

fn action_phrase(action: &str) -> Option<&'static str> {
    if action.contains("delete") {
        Some("Marked for delete")
    } else if action.contains("add") {
        Some("Marked for add")
    } else if action.contains("edit") {
        Some("Checked out for edit")
    } else if action.contains("integrate") || action.contains("move") || action.contains("branch") {
        Some("Opened for integrate")
    } else {
        None
    }
}

fn other_opens(record: &ZtagRecord) -> Vec<OtherOpen> {
    let lock = split_user_client(&field(record, "otherLock"));
    let mut openers = Vec::new();
    for group in indexed_groups(record) {
        let who = field(&group, "otherOpen");
        if who.is_empty() {
            continue;
        }
        let (user, client) = split_user_client(&who);
        if user.is_empty() {
            continue;
        }
        let locked = !lock.0.is_empty()
            && user.eq_ignore_ascii_case(&lock.0)
            && (lock.1.is_empty() || client.eq_ignore_ascii_case(&lock.1));
        openers.push(OtherOpen {
            label: person_label(&user, &client),
            change: field(&group, "otherChange"),
            locked,
        });
    }
    if openers.is_empty() && !lock.0.is_empty() {
        openers.push(OtherOpen {
            label: person_label(&lock.0, &lock.1),
            change: String::new(),
            locked: true,
        });
    }
    openers
}

fn split_user_client(value: &str) -> (String, String) {
    let value = value.split_whitespace().next().unwrap_or("").trim();
    match value.split_once('@') {
        Some((user, client)) => (user.trim().to_string(), client.trim().to_string()),
        None => (value.to_string(), String::new()),
    }
}

fn person_label(user: &str, client: &str) -> String {
    if client.is_empty() {
        user.to_string()
    } else {
        format!("{user} on {client}")
    }
}

fn note_opener(lines: &mut Vec<String>, opener: &OtherOpen) {
    let verb = if opener.locked {
        "Locked by"
    } else {
        "Opened by"
    };
    let short = format!("{verb} {}", opener.label);
    let line = if opener.change.is_empty() || opener.change == "default" {
        short.clone()
    } else {
        format!("{short} in changelist {}", opener.change)
    };
    if let Some(existing) = lines.iter_mut().find(|item| item.as_str() == short) {
        *existing = line;
        return;
    }
    push_line(lines, line);
}

fn push_line(lines: &mut Vec<String>, line: String) {
    if line.is_empty() || lines.iter().any(|item| item == &line) {
        return;
    }
    lines.push(line);
}

#[cfg(test)]
mod tests {
    use super::super::tests::record;
    use super::super::{local_from_client, mapped_location, normalize_location};
    use super::*;
    #[test]
    fn search_ancestors_keep_ignore_rules_without_changing_an_excluded_child() {
        let root = PathBuf::from("workspace");
        let mut file = plain_dir("keep.txt", &root.join("cache/nested/keep.txt"));
        file.dir = false;
        let mut hits = vec![file, plain_dir("nested", &root.join("cache/nested"))];
        include_search_parents(&root, &mut hits);
        assert_eq!(hits.len(), 3);
        annotate_ignored_with(&mut hits, &mut |args| {
            Ok(args
                .iter()
                .skip(2)
                .filter(|path| path.ends_with('/'))
                .map(|path| format!("{path} ignored\n"))
                .collect::<String>())
        });
        assert!(hits
            .iter()
            .filter(|entry| entry.dir)
            .all(|entry| entry.ignored));
        assert!(!hits[0].ignored);
    }

    #[test]
    fn native_ignore_setting_keeps_custom_and_disabled_rule_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("p4config.txt"),
            "P4IGNORE=project.ignore\n",
        )
        .unwrap();
        assert_eq!(
            ignore_file_setting(root.path(), Some("custom.ignore;shared.ignore")),
            "custom.ignore;shared.ignore"
        );
        assert_eq!(
            ignore_file_setting(root.path(), Some("missing.ignore")),
            "missing.ignore"
        );
        assert_eq!(ignore_file_setting(root.path(), None), "project.ignore");
    }

    #[test]
    fn ignore_configuration_inherits_rules_from_the_same_config_name() {
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("project");
        fs::create_dir(&child).unwrap();
        fs::write(
            root.path().join("p4config.txt"),
            "P4IGNORE=shared.ignore\r\n",
        )
        .unwrap();
        fs::write(child.join("p4config.txt"), "P4CLIENT=project\r\n").unwrap();
        fs::write(child.join(".p4config.txt"), "P4IGNORE=unrelated.ignore\n").unwrap();
        assert_eq!(ignore_file_setting(&child, None), "shared.ignore");
        fs::write(
            child.join("p4config.txt"),
            "\u{feff}P4IGNORE=project.ignore\r\n",
        )
        .unwrap();
        assert_eq!(ignore_file_setting(&child, None), "project.ignore");
    }

    #[test]
    fn ignored_entries_follow_native_results_and_keep_directory_rules() {
        let root = PathBuf::from("workspace");
        let mut entries = vec![
            plain_dir("build", &root.join("build")),
            plain_dir("source", &root.join("source")),
            plain_dir("space ignored", &root.join("space ignored")),
        ];
        entries[1].dir = false;
        annotate_ignored_with(&mut entries, &mut |args| {
            assert_eq!(&args[..2], ["ignores", "-i"]);
            Ok(args[2..]
                .iter()
                .filter(|path| {
                    matches!(
                        Path::new(path.trim_end_matches(['/', '\\']))
                            .file_name()
                            .and_then(|name| name.to_str()),
                        Some("build" | "space ignored")
                    )
                })
                .map(|path| format!("{} ignored\n", path.trim_end_matches(['/', '\\'])))
                .collect())
        });
        assert!(entries[0].ignored);
        assert!(!entries[1].ignored);
        assert!(entries[2].ignored);
    }

    #[test]
    fn native_matching_keeps_included_containers_without_losing_ignored_files() {
        let root = tempfile::tempdir().unwrap();
        let generated = root.path().join("generated");
        let source = root.path().join("source");
        let cache = root.path().join("cache");
        fs::create_dir_all(&generated).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let output = generated.join("output.bin");
        let keep = generated.join("keep.txt");
        fs::write(&output, "output").unwrap();
        fs::write(&keep, "keep").unwrap();
        let mut entries = vec![
            plain_dir("generated", &generated),
            plain_dir("source", &source),
            plain_dir("cache", &cache),
            plain_dir("output.bin", &output),
            plain_dir("keep.txt", &keep),
        ];
        entries[3].dir = false;
        entries[4].dir = false;
        annotate_ignored_with(&mut entries, &mut |args| {
            // These native results correspond to rules that ignore generated
            // and cache, but include generated/keep.txt. Only directory mode
            // keeps the container; file mode still ignores ordinary contents.
            let directories = Path::new(args[2]).is_dir();
            Ok(args[2..]
                .iter()
                .filter(|path| {
                    let path = Path::new(path);
                    if directories {
                        path == cache
                    } else {
                        (path.starts_with(&generated) && path != keep) || path.starts_with(&cache)
                    }
                })
                .map(|path| format!("{} ignored\n", path.trim_end_matches(['/', '\\'])))
                .collect())
        });
        assert!(!entries[0].ignored);
        assert!(!entries[1].ignored);
        assert!(entries[2].ignored);
        assert!(entries[3].ignored);
        assert!(!entries[4].ignored);
    }

    #[test]
    fn versioned_search_files_and_their_containers_override_ignore_rules() {
        let root = PathBuf::from("workspace");
        let mut entries = vec![
            plain_dir("project", &root.join("project")),
            plain_dir("cache", &root.join("cache")),
        ];
        for status in [
            "current",
            "stale",
            "edit",
            "clean",
            "add",
            "delete",
            "integrate",
            "other",
            "local",
            "",
        ] {
            let mut entry = plain_dir(status, &root.join("project").join(format!("{status}.txt")));
            entry.dir = false;
            entry.status = status.to_string();
            entries.push(entry);
        }
        for entry in &mut entries {
            entry.ignored = true;
        }
        clear_versioned_ignores(&mut entries);
        assert!(!entries[0].ignored);
        assert!(entries[1].ignored);
        assert!(entries[2..10].iter().all(|entry| !entry.ignored));
        assert!(entries[10..].iter().all(|entry| entry.ignored));
    }

    #[test]
    fn ignore_queries_are_bounded_and_never_invent_matches_on_failure() {
        let mut entries = (0..81)
            .map(|index| plain_dir(&index.to_string(), &PathBuf::from(index.to_string())))
            .collect::<Vec<_>>();
        let mut calls = 0;
        annotate_ignored_with(&mut entries, &mut |args| {
            calls += 1;
            assert!(args.len() <= 42);
            Err(AppError::msg("Ignore rules unavailable"))
        });
        assert_eq!(calls, 3);
        assert!(entries.iter().all(|entry| !entry.ignored));
    }

    #[test]
    fn an_empty_our_lock_tag_is_visible_without_replacing_the_open_action() {
        let record = parse_ztag("... depotFile //depot/main/asset.bin\n... action edit\n... change 42\n... haveRev 1\n... headRev 1\n... ourLock\n").remove(0);
        let (status, detail) = status_of(&record);
        assert_eq!(status, "edit");
        assert!(detail.lines().any(|line| line == "Locked by you"));
        assert!(detail.lines().any(|line| line == "Checked out for edit"));
        assert!(detail.lines().any(|line| line == "Your changelist 42"));
    }

    #[test]
    fn other_open_names_the_user_and_puts_each_fact_on_its_own_line() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
            ("otherOpen0", "alice@dev-pc"),
            ("otherAction0", "edit"),
            ("otherChange0", "44"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(
            detail,
            "Opened by alice on dev-pc in changelist 44\nRevision 3"
        );
    }

    #[test]
    fn a_lock_names_the_user_when_no_open_record_is_present() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
            ("otherLock", "alice@dev-pc"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(detail, "Locked by alice on dev-pc\nRevision 3");
    }

    #[test]
    fn stale_checkout_splits_status_changelist_and_revisions() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "8"),
            ("action", "edit"),
            ("change", "42"),
        ]));
        assert_eq!(status, "stale");
        assert_eq!(
            detail,
            "Not latest\nChecked out for edit\nYour changelist 42\nHave revision 3\nHead revision 8"
        );
    }

    #[test]
    fn your_changelist_is_not_the_same_line_as_someone_elses() {
        let (status, detail) = status_of(&record(&[
            ("depotFile", "//depot/main/settings.ini"),
            ("haveRev", "39"),
            ("headRev", "39"),
            ("action", "edit"),
            ("change", "42"),
            ("otherOpen", "2"),
            ("otherOpen0", "alice@dev-pc"),
            ("otherAction0", "edit"),
            ("otherChange0", "43"),
            ("otherOpen1", "bob@build-pc"),
            ("otherAction1", "edit"),
            ("otherChange1", "43"),
        ]));
        assert_eq!(status, "edit");
        assert_eq!(
            detail,
            "\
//depot/main/settings.ini
Checked out for edit
Your changelist 42
Opened by alice on dev-pc in changelist 43
Opened by bob on build-pc in changelist 43
Revision 39"
        );
    }

    #[test]
    fn depot_path_identity_preserves_case_on_every_platform() {
        let mut same = BTreeSet::new();
        same.insert(fold_path("//depot/main/File.txt"));
        assert!(path_is_unchanged(&same, "//depot/main/File.txt", ""));
        assert!(!path_is_unchanged(&same, "//depot/main/file.txt", ""));
        assert_ne!(
            normalize_location("//depot/Main/...", true),
            normalize_location("//depot/main/...", true)
        );
        assert_eq!(
            mapped_location("//depot/main/name...", true),
            "//depot/main/name..."
        );
        assert_eq!(mapped_location("//depot/main/...", true), "//depot/main");
    }

    #[test]
    fn a_clean_checkout_replaces_only_the_edit_headline() {
        let mut status = "edit".to_string();
        let mut detail = "\
//depot/main/mobile.ini
Checked out for edit
Your changelist 42
Revision 4"
            .to_string();
        mark_clean_checkout(&mut status, &mut detail);
        assert_eq!(status, "clean");
        assert_eq!(
            detail,
            "\
//depot/main/mobile.ini
Checked out, no changes
Your changelist 42
Revision 4"
        );
    }

    #[test]
    fn an_unnamed_open_still_splits_the_revision() {
        let (status, detail) = status_of(&record(&[
            ("haveRev", "3"),
            ("headRev", "3"),
            ("otherOpen", "1"),
        ]));
        assert_eq!(status, "other");
        assert_eq!(detail, "Opened by another user\nRevision 3");
    }

    #[test]
    fn depot_search_scopes_to_an_explicit_path() {
        let (root, needle) = explicit_depot_query("//vendor/library/settings").unwrap();
        assert_eq!(root, "//vendor/library");
        assert_eq!(needle, "settings");
        let (root, needle) = explicit_depot_query("depot/Player").unwrap();
        assert_eq!(root, "//depot");
        assert_eq!(needle, "Player");
        assert!(explicit_depot_query("Player").is_none());
        assert!(explicit_depot_query("//vendor").is_none());
    }

    #[test]
    fn client_view_roots_keep_the_depot_side_and_skip_exclusions() {
        let spec = "\
Client:\tpc

View:
\t//depot/... //pc/...
\t-//depot/Saved/... //pc/Saved/...
\t+//vendor/library/... //pc/library/...
\t//... //pc/everything/...

Description:
\tCreated by RebaseRaven.
";
        assert_eq!(
            client_view_roots(spec),
            vec!["//depot".to_string(), "//vendor/library".to_string(),]
        );
    }

    #[test]
    fn client_view_roots_keep_distinct_depot_case_and_deduplicate_exact_names() {
        let spec = "View:\n\t//depot/Main/... //pc/Main/...\n\t//depot/main/... //pc/main/...\n\t//depot/Main/... //pc/copy/...\n";
        assert_eq!(
            client_view_roots(spec),
            vec!["//depot/Main", "//depot/main"]
        );
    }

    #[test]
    fn client_view_roots_keep_quoted_directories_with_spaces() {
        let spec = "View:\n\t\"//depot/shared files/...\" //pc/...\n";
        assert_eq!(client_view_roots(spec), vec!["//depot/shared files"]);
    }

    #[test]
    fn depot_path_is_the_first_status_line() {
        let (status, detail) = status_of(&record(&[
            ("depotFile", "//depot/main/notes.bat"),
            ("haveRev", "1"),
            ("headRev", "1"),
        ]));
        assert_eq!(status, "current");
        assert_eq!(detail, "//depot/main/notes.bat\nUp to date\nRevision 1");
    }

    #[test]
    fn client_paths_decode_once_when_mapped_to_local_files() {
        let root = Path::new("/work/client");
        let expected = root.join("docs").join("a@b#c%d*e.txt");
        assert_eq!(
            local_from_client(root, "pc", "//pc/docs/a%40b%23c%25d%2Ae.txt"),
            expected.to_string_lossy()
        );
        assert_eq!(
            local_from_client(root, "pc", "//pc/literal%2523.txt"),
            root.join("literal%23.txt").to_string_lossy()
        );
        assert_eq!(depot_base("//depot/docs/a%23b.txt"), "a#b.txt");
        assert_eq!(depot_base("//depot/literal%2523.txt"), "literal%23.txt");
    }
}
