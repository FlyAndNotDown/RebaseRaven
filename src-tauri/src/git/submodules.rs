use super::*;
use std::hash::{Hash, Hasher};
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: String,
    pub url: Option<String>,
    pub branch: Option<String>,
    /// "clean", "uninitialized", "modified" (checked out at another commit than
    /// recorded), or "conflicted".
    pub state: String,
    pub commit: Option<String>,
}

/// Status output has no NUL mode. Match its paths against the NUL-delimited
/// configuration instead of treating newlines inside a path as record separators.
pub(super) fn parse_submodule_status(
    text: &str,
    paths: &[String],
) -> Vec<(String, String, String)> {
    let mut items = Vec::new();
    let mut rest = text;
    while let Some(flag) = rest.chars().next() {
        let Some((commit, after)) = rest[flag.len_utf8()..].split_once(' ') else {
            break;
        };
        if !matches!(flag, ' ' | '-' | '+' | 'U')
            || !matches!(commit.len(), 40 | 64)
            || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            break;
        }
        let Some(path) = paths
            .iter()
            .filter(|path| {
                after.strip_prefix(path.as_str()).is_some_and(|tail| {
                    tail.is_empty() || tail.starts_with('\n') || tail.starts_with(" (")
                })
            })
            .max_by_key(|path| path.len())
        else {
            break;
        };
        let tail = &after[path.len()..];
        rest = match tail.find('\n') {
            Some(index) => &tail[index + 1..],
            None => "",
        };
        let state = match flag {
            '-' => "uninitialized",
            '+' => "modified",
            'U' => "conflicted",
            _ => "clean",
        };
        items.push((state.into(), commit.into(), path.clone()));
    }
    items
}

pub fn list_submodules(repo: &Repository) -> AppResult<Vec<SubmoduleInfo>> {
    let root = workdir(repo)?;
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let definitions = submodule_definitions(repo)?;
    let paths = definitions
        .iter()
        .map(|module| module.path.clone())
        .collect::<Vec<_>>();
    let stdout = run_git_stdout(root, &["-c", "core.quotePath=off", "submodule", "status"])?;
    Ok(
        parse_submodule_status(&String::from_utf8_lossy(&stdout), &paths)
            .into_iter()
            .filter_map(|(state, commit, path)| {
                definitions
                    .iter()
                    .find(|module| module.path == path)
                    .map(|module| SubmoduleInfo {
                        name: module.name.clone(),
                        url: module.url.clone(),
                        branch: module.branch.clone(),
                        commit: Some(commit).filter(|commit| !commit.is_empty()),
                        state,
                        path,
                    })
            })
            .collect(),
    )
}

fn submodule_definitions(repo: &Repository) -> AppResult<Vec<SubmoduleInfo>> {
    if !repo.workdir().join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let options = ["config", "--null", "--file", ".gitmodules"];
    let mut names_args = options.to_vec();
    names_args.extend(["--name-only", "--get-regexp", r"^submodule\."]);
    let names_output = run_git(repo.workdir(), &names_args)?;
    if !names_output.status.success() && names_output.status.code() != Some(1) {
        return Err(git_output_error(names_output));
    }
    let names = names_output.stdout;
    let mut values_args = options.to_vec();
    values_args.extend(["--get-regexp", r"^submodule\."]);
    let values_output = run_git(repo.workdir(), &values_args)?;
    if !values_output.status.success() && values_output.status.code() != Some(1) {
        return Err(git_output_error(values_output));
    }
    let values = values_output.stdout;
    let names: Vec<_> = names
        .split(|byte| *byte == 0)
        .filter(|key| !key.is_empty())
        .collect();
    let mut paths = HashMap::new();
    let mut urls = HashMap::new();
    let mut branches = HashMap::new();
    for record in values.split(|byte| *byte == 0) {
        // Match complete keys so a newline inside a path remains part of its value.
        let Some(key) = names
            .iter()
            .filter(|key| record.starts_with(key) && record.get(key.len()) == Some(&b'\n'))
            .max_by_key(|key| key.len())
        else {
            continue;
        };
        let key_text = String::from_utf8_lossy(key);
        let Some(name) = key_text.strip_prefix("submodule.") else {
            continue;
        };
        let value = String::from_utf8_lossy(&record[key.len() + 1..]).into_owned();
        if let Some(name) = name.strip_suffix(".path") {
            paths.insert(name.to_string(), to_git_path(&value));
        } else if let Some(name) = name.strip_suffix(".url") {
            urls.insert(name.to_string(), value);
        } else if let Some(name) = name.strip_suffix(".branch") {
            branches.insert(name.to_string(), value);
        }
    }
    let mut modules: Vec<_> = paths
        .into_iter()
        .map(|(name, path)| SubmoduleInfo {
            url: urls.remove(&name),
            branch: branches.remove(&name),
            name,
            path,
            state: "uninitialized".into(),
            commit: None,
        })
        .collect();
    modules.sort_by(|left, right| left.path.cmp(&right.path));
    if modules.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return Err(AppError::msg(
            "Multiple submodule names map to the same path",
        ));
    }
    Ok(modules)
}

/// Initializes and checks out submodules at their recorded commits, nested
/// ones included. An empty `paths` updates them all.
pub fn update_submodules(
    repo: &mut Repository,
    paths: &[String],
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    update_submodules_with_options(repo, paths, None, on_progress)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleUpdateOptions {
    pub remote: bool,
    pub recursive: bool,
    pub fetch: bool,
    pub strategy: SubmoduleUpdateStrategy,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubmoduleUpdateStrategy {
    Checkout,
    Merge,
    Rebase,
}

pub fn update_submodules_with_options(
    repo: &mut Repository,
    paths: &[String],
    options: Option<&SubmoduleUpdateOptions>,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let _lock = SubmoduleLock::acquire(repo)?;
    let specs: Vec<_> = selected_paths(repo, paths)?
        .iter()
        .map(|path| literal_submodule_pathspec(path))
        .collect();
    let mut args = vec![
        "--no-literal-pathspecs",
        "submodule",
        "update",
        "--init",
        "--progress",
    ];
    if options.is_none_or(|options| options.recursive) {
        args.push("--recursive");
    }
    if let Some(options) = options {
        if options.remote {
            args.push("--remote");
        }
        if !options.fetch {
            args.push("--no-fetch");
        }
        args.push(match options.strategy {
            SubmoduleUpdateStrategy::Checkout => "--checkout",
            SubmoduleUpdateStrategy::Merge => "--merge",
            SubmoduleUpdateStrategy::Rebase => "--rebase",
        });
    }
    if !specs.is_empty() {
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
    }
    run_git_ok_progress(workdir(repo)?, &args, on_progress)?;
    snapshot(repo)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleSettings {
    pub module: SubmoduleInfo,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCatalog {
    pub modules: Vec<SubmoduleInfo>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleAdd {
    pub url: String,
    pub path: String,
    pub name: Option<String>,
    pub branch: Option<String>,
    pub depth: Option<u32>,
    pub force: bool,
}

fn optional_file(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 4_194_304 => Ok(Some(bytes)),
        Ok(_) => Err(AppError::msg(
            "Submodule configuration is too large to edit here",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn catalog_hash(repo: &Repository) -> AppResult<std::collections::hash_map::DefaultHasher> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        repo.path(),
        head_oid(repo),
        optional_file(&repo.workdir().join(".gitmodules"))?,
        optional_file(&repo.commondir().join("config"))?,
        optional_file(&repo.path().join("config.worktree"))?,
    )
        .hash(&mut hash);
    run_git_stdout(
        repo.workdir(),
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            ".gitmodules",
        ],
    )?
    .hash(&mut hash);
    Ok(hash)
}

pub fn submodule_catalog(repo: &Repository) -> AppResult<SubmoduleCatalog> {
    let hash = catalog_hash(repo)?;
    Ok(SubmoduleCatalog {
        modules: list_submodules(repo)?,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn module_path(repo: &Repository, value: &str) -> AppResult<String> {
    use std::path::Component;
    let value = if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.to_string()
    };
    if value.is_empty() || value.len() > 8192 || value.contains('\0') {
        return Err(AppError::msg(
            "Choose a relative submodule path inside this repository",
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(&value).components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().eq_ignore_ascii_case(".git") => {
                parts.push(part.to_string_lossy().into_owned())
            }
            Component::CurDir => {}
            _ => {
                return Err(AppError::msg(
                    "Submodule paths must stay inside this repository and outside Git metadata",
                ))
            }
        }
    }
    if parts.is_empty() {
        return Err(AppError::msg("Choose a subdirectory for the submodule"));
    }
    let mut destination = repo.workdir().to_path_buf();
    for part in &parts {
        destination.push(part);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::msg(
                    "Submodule paths cannot pass through symbolic links",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(parts.join("/"))
}

fn selected_paths(repo: &Repository, paths: &[String]) -> AppResult<Vec<String>> {
    let definitions = submodule_definitions(repo)?;
    paths
        .iter()
        .map(|path| {
            let path = module_path(repo, path)?;
            if definitions.iter().any(|module| module.path == path) {
                Ok(path)
            } else {
                Err(AppError::msg(format!(
                    "Submodule `{path}` no longer exists"
                )))
            }
        })
        .collect()
}

// Keep literal selection in each argument across legacy submodule script dispatch.
fn literal_submodule_pathspec(path: &str) -> String {
    format!(":(top,literal){path}")
}

fn child_repo(repo: &Repository, path: &str) -> AppResult<Option<Repository>> {
    let directory = repo.workdir().join(path);
    if !directory.join(".git").exists() {
        return Ok(None);
    }
    let child = open_at(&directory)?;
    if !super::structure::same_folder(&directory.to_string_lossy(), child.workdir()) {
        return Err(AppError::msg(
            "The submodule checkout points to a different repository",
        ));
    }
    Ok(Some(child))
}

pub fn submodule_settings(repo: &Repository, path: &str) -> AppResult<SubmoduleSettings> {
    let path = module_path(repo, path)?;
    let module = list_submodules(repo)?
        .into_iter()
        .find(|module| module.path == path)
        .ok_or_else(|| AppError::msg("The submodule no longer exists"))?;
    let mut hash = catalog_hash(repo)?;
    (
        &module.name,
        &module.path,
        &module.url,
        &module.branch,
        &module.state,
        &module.commit,
    )
        .hash(&mut hash);
    run_git_stdout(
        repo.workdir(),
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            &path,
        ],
    )?
    .hash(&mut hash);
    if let Some(child) = child_repo(repo, &path)? {
        (
            optional_file(&child.commondir().join("config"))?,
            optional_file(&child.path().join("config.worktree"))?,
            head_oid(&child),
        )
            .hash(&mut hash);
    }
    Ok(SubmoduleSettings {
        module,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn valid_url(url: &str) -> AppResult<&str> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > 8192
        || url.starts_with('-')
        || url.chars().any(char::is_control)
    {
        return Err(AppError::msg("Enter a valid submodule URL"));
    }
    Ok(url)
}

fn valid_branch(repo: &Repository, branch: Option<&str>) -> AppResult<Option<String>> {
    let branch = branch.map(str::trim).filter(|branch| !branch.is_empty());
    if let Some(branch) = branch {
        if branch != "."
            && (branch.len() > 8192
                || branch.starts_with('-')
                || !run_git(
                    repo.workdir(),
                    &["check-ref-format", &format!("refs/heads/{branch}")],
                )?
                .status
                .success())
        {
            return Err(AppError::msg(
                "Enter a valid tracking branch or use the remote default",
            ));
        }
    }
    Ok(branch.map(str::to_string))
}

fn definition_change_ready(repo: &Repository) -> AppResult<()> {
    if super::operations::git_operation(repo).is_some() {
        return Err(AppError::msg(
            "Finish the current operation before changing submodule definitions",
        ));
    }
    Ok(())
}

fn stage_metadata_ready(repo: &Repository) -> AppResult<()> {
    if repo.workdir().join(".gitmodules").exists()
        && run_git_stdout(
            repo.workdir(),
            &[
                "--literal-pathspecs",
                "ls-files",
                "--stage",
                "-z",
                "--",
                ".gitmodules",
            ],
        )?
        .is_empty()
    {
        return Err(AppError::msg(
            "Stage .gitmodules before adding or removing a submodule",
        ));
    }
    let output = run_git(
        repo.workdir(),
        &[
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--quiet",
            "--",
            ".gitmodules",
        ],
    )?;
    if !output.status.success() {
        return Err(AppError::msg(
            "Stage or stash changes to .gitmodules before adding or removing a submodule",
        ));
    }
    Ok(())
}

pub fn add_submodule(
    repo: &mut Repository,
    request: &SubmoduleAdd,
    fingerprint: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let _lock = SubmoduleLock::acquire(repo)?;
    definition_change_ready(repo)?;
    stage_metadata_ready(repo)?;
    let url = valid_url(&request.url)?;
    let path = module_path(repo, &request.path)?;
    let branch = valid_branch(repo, request.branch.as_deref())?;
    if branch.as_deref() == Some(".") {
        return Err(AppError::msg(
            "Choose a named branch when adding a submodule. Parent-branch tracking can be configured after adding it.",
        ));
    }
    if request
        .depth
        .is_some_and(|depth| depth == 0 || depth > i32::MAX as u32)
    {
        return Err(AppError::msg("Clone depth must be a positive integer"));
    }
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if name.is_some_and(|name| {
        name.len() > 1024
            || name.starts_with('-')
            || name.chars().any(char::is_control)
            || Path::new(name)
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
    }) {
        return Err(AppError::msg("Enter a valid submodule name"));
    }
    let catalog = submodule_catalog(repo)?;
    if catalog.fingerprint != fingerprint {
        return Err(AppError::msg(
            "Submodule configuration changed. Reload before adding.",
        ));
    }
    if catalog
        .modules
        .iter()
        .any(|module| module.path == path || name.unwrap_or(&path) == module.name)
    {
        return Err(AppError::msg("That submodule path or name already exists"));
    }
    let mut args = vec![
        "--literal-pathspecs".to_string(),
        "submodule".to_string(),
        "add".to_string(),
    ];
    if let Some(branch) = branch {
        args.extend(["--branch".to_string(), branch]);
    }
    if let Some(name) = name {
        args.extend(["--name".to_string(), name.to_string()]);
    }
    if let Some(depth) = request.depth {
        args.extend(["--depth".to_string(), depth.to_string()]);
    }
    if request.force {
        args.push("--force".to_string());
    }
    args.extend(["--".to_string(), url.to_string(), path]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok_progress(repo.workdir(), &args, on_progress)?;
    snapshot(repo)
}

pub fn edit_submodule(
    repo: &mut Repository,
    path: &str,
    url: &str,
    branch: Option<&str>,
    fingerprint: &str,
) -> AppResult<WorkspaceSnapshot> {
    let _lock = SubmoduleLock::acquire(repo)?;
    definition_change_ready(repo)?;
    let url = valid_url(url)?;
    let branch = valid_branch(repo, branch)?;
    let settings = submodule_settings(repo, path)?;
    if settings.fingerprint != fingerprint {
        return Err(AppError::msg(
            "Submodule configuration changed. Reload before saving.",
        ));
    }
    let path = &settings.module.path;
    if settings.module.url.as_deref() != Some(url) {
        run_git_stdout(
            repo.workdir(),
            &[
                "--literal-pathspecs",
                "submodule",
                "set-url",
                "--",
                path,
                url,
            ],
        )?;
    }
    if settings.module.branch != branch {
        let mut args = vec!["--literal-pathspecs", "submodule", "set-branch"];
        if let Some(branch) = branch.as_deref() {
            args.extend(["--branch", branch]);
        } else {
            args.push("--default");
        }
        args.extend(["--", path]);
        run_git_stdout(repo.workdir(), &args)?;
    }
    snapshot(repo)
}

pub fn sync_submodules(
    repo: &mut Repository,
    paths: &[String],
    recursive: bool,
) -> AppResult<WorkspaceSnapshot> {
    let _lock = SubmoduleLock::acquire(repo)?;
    let paths: Vec<_> = selected_paths(repo, paths)?
        .iter()
        .map(|path| literal_submodule_pathspec(path))
        .collect();
    let mut args = vec!["--no-literal-pathspecs", "submodule", "sync"];
    if recursive {
        args.push("--recursive");
    }
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    run_git_stdout(repo.workdir(), &args)?;
    snapshot(repo)
}

#[derive(Debug, Clone, serde::Deserialize, Serialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SubmoduleRemovalKind {
    Deinit,
    Remove,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRemovalPreview {
    pub module: SubmoduleInfo,
    pub files: usize,
    pub bytes: u64,
    pub dirty: bool,
    pub fingerprint: String,
}

fn checkout_facts(directory: &Path, hash: &mut impl Hasher) -> AppResult<(usize, u64)> {
    let started = Instant::now();
    let mut pending = vec![(directory.to_path_buf(), 0)];
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut entries = 0usize;
    while let Some((path, depth)) = pending.pop() {
        entries += 1;
        if entries > 1_000_000 || depth > 128 || started.elapsed() > Duration::from_secs(10) {
            return Err(AppError::msg(
                "The checkout is too large to verify for removal here",
            ));
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        (
            path.strip_prefix(directory).unwrap_or(&path),
            metadata.len(),
            metadata.modified()?,
            metadata.permissions().readonly(),
            metadata.file_type().is_dir(),
            metadata.file_type().is_symlink(),
        )
            .hash(hash);
        if metadata.file_type().is_symlink() {
            fs::read_link(&path)?.hash(hash);
            files += 1;
        } else if metadata.is_dir() {
            let mut children: Vec<_> = fs::read_dir(&path)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<_, _>>()?;
            children.sort();
            for child in children.into_iter().rev() {
                if depth == 0 && child.file_name().is_some_and(|name| name == ".git") {
                    (child.clone(), optional_file(&child).ok().flatten()).hash(hash);
                    continue;
                }
                pending.push((child, depth + 1));
            }
        } else {
            files += 1;
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok((files, bytes))
}

pub fn preview_submodule_removal(
    repo: &Repository,
    path: &str,
    kind: &SubmoduleRemovalKind,
    force: bool,
) -> AppResult<SubmoduleRemovalPreview> {
    let settings = submodule_settings(repo, path)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (&settings.fingerprint, kind, force).hash(&mut hash);
    let (files, bytes) = checkout_facts(&repo.workdir().join(&settings.module.path), &mut hash)?;
    let mut dirty = settings.module.state == "modified" || settings.module.state == "conflicted";
    if let Some(child) = child_repo(repo, &settings.module.path)? {
        let status = run_git_stdout(
            child.workdir(),
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        status.hash(&mut hash);
        dirty |= !status.is_empty();
    } else {
        dirty |= files > 0;
    }
    Ok(SubmoduleRemovalPreview {
        module: settings.module,
        files,
        bytes,
        dirty,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn remove_submodule(
    repo: &mut Repository,
    path: &str,
    kind: &SubmoduleRemovalKind,
    force: bool,
    fingerprint: &str,
) -> AppResult<WorkspaceSnapshot> {
    let _lock = SubmoduleLock::acquire(repo)?;
    definition_change_ready(repo)?;
    if matches!(kind, SubmoduleRemovalKind::Remove) {
        stage_metadata_ready(repo)?;
    }
    let preview = preview_submodule_removal(repo, path, kind, force)?;
    if preview.fingerprint != fingerprint {
        return Err(AppError::msg(
            "The submodule or its local files changed. Reload the removal preview.",
        ));
    }
    if preview.dirty && !force {
        return Err(AppError::msg("The submodule has local changes. Review the preview and enable force removal to discard them."));
    }
    let path = preview.module.path;
    let pathspec = literal_submodule_pathspec(&path);
    let directory = repo.workdir().join(&path);
    if directory.join(".git").is_dir() {
        run_git_stdout(
            repo.workdir(),
            &[
                "--no-literal-pathspecs",
                "submodule",
                "absorbgitdirs",
                "--",
                &pathspec,
            ],
        )?;
    }
    if let Some(child) = child_repo(repo, &path)? {
        if child
            .path()
            .canonicalize()?
            .starts_with(directory.canonicalize()?)
        {
            return Err(AppError::msg(
                "The submodule Git directory must be stored outside its checkout before removal",
            ));
        }
    }
    if matches!(kind, SubmoduleRemovalKind::Remove) {
        let mut check = vec!["--literal-pathspecs", "rm", "--dry-run"];
        if force {
            check.push("--force");
        }
        check.extend(["--", &path]);
        run_git_stdout(repo.workdir(), &check)?;
    }
    let mut args = vec!["--no-literal-pathspecs", "submodule", "deinit"];
    if force {
        args.push("--force");
    }
    args.extend(["--", &pathspec]);
    run_git_stdout(repo.workdir(), &args)?;
    if matches!(kind, SubmoduleRemovalKind::Remove) {
        let mut remove = vec!["--literal-pathspecs", "rm"];
        if force {
            remove.push("--force");
        }
        remove.extend(["--", &path]);
        run_git_stdout(repo.workdir(), &remove)?;
    }
    snapshot(repo)
}

struct SubmoduleLock(fs::File);
impl SubmoduleLock {
    fn acquire(repo: &Repository) -> AppResult<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(repo.path().join("rebaseraven-submodule.lock"))?;
        file.try_lock()
            .map_err(|_| AppError::msg("Another submodule change is still running"))?;
        Ok(Self(file))
    }
}
impl Drop for SubmoduleLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
mod tests;
