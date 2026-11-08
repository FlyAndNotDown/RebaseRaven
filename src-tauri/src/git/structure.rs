use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prune_reason: Option<String>,
    pub missing: bool,
    pub fingerprint: String,
    /// Its folder is gone; `git worktree prune` would remove the entry.
    pub prunable: bool,
    /// The worktree this repository was opened from.
    pub current: bool,
    /// The repository's main working tree.
    pub main: bool,
}

pub(super) fn parse_worktree_list(text: &str) -> Vec<WorktreeInfo> {
    let mut items = Vec::new();
    for (index, record) in text
        .split("\0\0")
        .filter(|record| !record.is_empty())
        .enumerate()
    {
        let mut item = WorktreeInfo {
            path: String::new(),
            head: None,
            branch: None,
            detached: false,
            bare: false,
            locked: false,
            lock_reason: None,
            prune_reason: None,
            missing: false,
            fingerprint: String::new(),
            prunable: false,
            current: false,
            main: index == 0,
        };
        for line in record.split('\0') {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => item.path = value.to_string(),
                "HEAD" => item.head = Some(value.to_string()),
                "branch" => item.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                "detached" => item.detached = true,
                "bare" => item.bare = true,
                "locked" => {
                    item.locked = true;
                    item.lock_reason = (!value.is_empty()).then(|| value.to_string());
                }
                "prunable" => {
                    item.prunable = true;
                    item.prune_reason = (!value.is_empty()).then(|| value.to_string());
                }
                _ => {}
            }
        }
        if !item.path.is_empty() {
            items.push(item);
        }
    }
    items
}

pub(super) fn same_folder(left: &str, right: &Path) -> bool {
    let left = Path::new(left);
    let left = strip_verbatim_path(left.canonicalize().unwrap_or_else(|_| left.to_path_buf()));
    let right = strip_verbatim_path(right.canonicalize().unwrap_or_else(|_| right.to_path_buf()));
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

pub fn list_worktrees(repo: &Repository) -> AppResult<Vec<WorktreeInfo>> {
    let root = workdir_owned(repo)?;
    let stdout = run_git_stdout(&root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut items = parse_worktree_list(&String::from_utf8_lossy(&stdout));
    let fingerprint = super::worktrees::catalog_fingerprint(repo, &stdout, &items)?;
    for item in &mut items {
        item.missing = !Path::new(&item.path).is_dir();
        item.fingerprint = fingerprint.clone();
        item.current = same_folder(&item.path, &root);
    }
    Ok(items)
}

/// Creates a worktree at `path`, checking out `branch`, or a new branch
/// `new_branch` started from `start` (HEAD when empty).
pub fn add_worktree(
    repo: &Repository,
    path: &str,
    branch: Option<&str>,
    new_branch: Option<&str>,
    start: Option<&str>,
) -> AppResult<String> {
    let _lock = super::worktrees::WorktreeLock::acquire(repo)?;
    if path.is_empty() {
        return Err(AppError::msg("Choose a folder for the worktree"));
    }
    let mut args = vec!["worktree", "add"];
    let new_branch = new_branch.map(str::trim).filter(|name| !name.is_empty());
    if let Some(name) = new_branch {
        args.extend(["-b", name]);
    }
    args.extend(["--", path]);
    match (
        new_branch,
        branch.map(str::trim).filter(|name| !name.is_empty()),
    ) {
        (None, Some(branch)) => args.push(branch),
        (Some(_), _) => {
            if let Some(start) = start.map(str::trim).filter(|start| !start.is_empty()) {
                args.push(start);
            }
        }
        (None, None) => return Err(AppError::msg("Choose a branch or name a new one")),
    }
    run_git_stdout(workdir(repo)?, &args)?;
    let created = PathBuf::from(path);
    let created = if created.is_absolute() {
        created
    } else {
        workdir(repo)?.join(created)
    };
    Ok(strip_verbatim_prefix(
        &created.canonicalize().unwrap_or(created).to_string_lossy(),
    ))
}

pub fn remove_worktree(repo: &Repository, path: &str, force: bool) -> AppResult<()> {
    let _lock = super::worktrees::WorktreeLock::acquire(repo)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", path]);
    run_git_stdout(workdir(repo)?, &args)?;
    Ok(())
}

pub fn prune_worktrees(repo: &Repository) -> AppResult<()> {
    let _lock = super::worktrees::WorktreeLock::acquire(repo)?;
    run_git_stdout(workdir(repo)?, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod structure_tests {
    use super::*;

    fn repository(path: &Path) -> Repository {
        fs::create_dir_all(path).unwrap();
        run_git_stdout(path, &["init", "-q"]).unwrap();
        run_git_stdout(path, &["config", "user.name", "Alice"]).unwrap();
        run_git_stdout(path, &["config", "user.email", "alice@example.com"]).unwrap();
        fs::write(path.join("file.txt"), "base\n").unwrap();
        run_git_stdout(path, &["add", "file.txt"]).unwrap();
        run_git_stdout(path, &["-c", "core.hooksPath=", "commit", "-qm", "base"]).unwrap();
        open_at(path).unwrap()
    }

    #[test]
    fn relative_worktrees_return_the_absolute_repo_relative_destination() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("main"));
        let created =
            add_worktree(&repo, "nested/worktree space", None, Some("side"), None).unwrap();
        let expected = repo
            .workdir()
            .join("nested/worktree space")
            .canonicalize()
            .unwrap();
        assert!(Path::new(&created).is_absolute());
        assert!(same_folder(&created, &expected));
        let trees = list_worktrees(&repo).unwrap();
        // Git and the native filesystem may use different Windows separators.
        assert!(
            trees
                .iter()
                .any(|tree| same_folder(&tree.path, Path::new(&created))
                    && tree.branch.as_deref() == Some("side")
                    && !tree.current
                    && !tree.main),
            "created={created:?}, trees={trees:#?}"
        );
        assert!(trees.iter().any(|tree| tree.main && tree.current));
        let linked = open_at(Path::new(&created)).unwrap();
        let linked_trees = list_worktrees(&linked).unwrap();
        assert!(
            linked_trees.iter().any(|tree| tree.current
                && !tree.main
                && tree.branch.as_deref() == Some("side")
                && same_folder(&tree.path, Path::new(&created))),
            "created={created:?}, linked_trees={linked_trees:#?}"
        );
        assert!(linked_trees
            .iter()
            .any(|tree| tree.main && !tree.current && same_folder(&tree.path, repo.workdir())));
        drop(linked);
        fs::write(Path::new(&created).join("file.txt"), "dirty\n").unwrap();
        assert!(remove_worktree(&repo, &created, false).is_err());
        assert!(Path::new(&created).join("file.txt").is_file());
        remove_worktree(&repo, &created, true).unwrap();
        assert!(!Path::new(&created).exists());
        assert!(ref_exists(&repo, "refs/heads/side"));
        assert_eq!(list_worktrees(&repo).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn worktree_paths_keep_newlines_backslashes_and_trailing_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("main"));
        for (index, name) in [
            " worktree\nwith\\literal ",
            "trailing-newline\n",
            "trailing-carriage-return\r",
        ]
        .into_iter()
        .enumerate()
        {
            let path = temp.path().join(name);
            let branch = format!("side-{index}");
            let created =
                add_worktree(&repo, path.to_str().unwrap(), None, Some(&branch), None).unwrap();
            assert_eq!(Path::new(&created), path.canonicalize().unwrap());
            let trees = list_worktrees(&repo).unwrap();
            assert_eq!(trees.len(), 2);
            assert_eq!(trees[1].path, created);
            let linked = open_at(Path::new(&created)).unwrap();
            assert!(list_worktrees(&linked).unwrap()[1].current);
            drop(linked);
            remove_worktree(&repo, &created, false).unwrap();
            assert!(!path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn submodules_keep_literal_paths_with_explicit_config_names() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("source");
        let _source = repository(&source_path);
        let repo = repository(&temp.path().join("main"));
        let path = "libs/space \\and\nnewline";
        run_git_stdout(
            repo.workdir(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--name",
                "portable-module",
                source_path.to_str().unwrap(),
                path,
            ],
        )
        .unwrap();
        let modules = list_submodules(&repo).unwrap();
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].path, path);
        assert_eq!(modules[0].state, "clean");
        assert_eq!(modules[0].url.as_deref(), source_path.to_str());
        assert!(open_at(&repo.workdir().join(&modules[0].path)).is_ok());
        run_git_stdout(repo.workdir(), &["submodule", "deinit", "-f", "--", path]).unwrap();
        let modules = list_submodules(&repo).unwrap();
        assert_eq!(modules[0].path, path);
        assert_eq!(modules[0].state, "uninitialized");
    }
}
