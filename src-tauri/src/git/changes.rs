use super::*;

/// Staging goes through `git add` so clean filters such as Git LFS store a
/// pointer instead of the file contents.
pub fn stage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    run_git_pathspecs(workdir(repo)?, &["add", "--all"], &specs)?;
    Ok(())
}

pub fn unstage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let specs: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    let root = workdir(repo)?;
    if head_oid(repo).is_some() {
        run_git_pathspecs(root, &["reset", "-q", "HEAD"], &specs)?;
    } else {
        run_git_pathspecs(
            root,
            &["rm", "-q", "--cached", "--force", "--ignore-unmatch"],
            &specs,
        )?;
    }
    Ok(())
}

pub(super) fn is_untracked(repo: &Repository, rel: &str) -> bool {
    let Ok(output) = run_git(
        repo.workdir(),
        &[
            "--literal-pathspecs",
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=no",
            "--",
            rel,
        ],
    ) else {
        return false;
    };
    output.status.success() && output.stdout.starts_with(b"??")
}

/// Resolve parent directories for containment, but preserve the final entry so
/// discarding a symlink removes the link instead of the file it points to.
fn discard_entry_path(root: &Path, relative: &str) -> AppResult<PathBuf> {
    safe_repo_path(relative)?;
    let candidate = root.join(relative);
    let mut parent = candidate.parent();
    while let Some(path) = parent {
        match path.canonicalize() {
            Ok(canonical) => {
                if !canonical.starts_with(root) {
                    return Err(AppError::msg("Path is outside the repository"));
                }
                return Ok(candidate);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => parent = path.parent(),
            Err(err) => return Err(err.into()),
        }
    }
    Err(AppError::msg("Path is outside the repository"))
}

/// Git on Windows cannot overwrite a read-only file. Elsewhere it replaces the
/// file, and clearing the flag would make it world-writable.
pub(super) fn clear_readonly(full: &Path) -> AppResult<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(full) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(());
    }
    let mut perms = metadata.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(full, perms)?;
    }
    Ok(())
}

// ls-tree expands a selected directory if queried alongside a descendant.
fn paths_in_head(root: &Path, head: &str, paths: &[String]) -> AppResult<HashSet<Vec<u8>>> {
    let selected: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut groups = std::collections::BTreeMap::<usize, Vec<String>>::new();
    for path in paths {
        let selected_parents = path
            .match_indices('/')
            .filter(|(index, _)| selected.contains(&path[..*index]))
            .count();
        groups
            .entry(selected_parents)
            .or_default()
            .push(path.clone());
    }
    let mut tracked = HashSet::new();
    for paths in groups.values() {
        for chunk in pathspec_chunks(paths) {
            let mut args = vec![
                "--literal-pathspecs",
                "ls-tree",
                "-t",
                "-z",
                "--name-only",
                head,
                "--",
            ];
            args.extend(chunk.iter().map(String::as_str));
            let output = run_git_stdout(root, &args)?;
            tracked.extend(
                output
                    .split(|byte| *byte == 0)
                    .filter(|entry| !entry.is_empty())
                    .map(<[u8]>::to_vec),
            );
        }
    }
    Ok(tracked)
}

fn reject_case_aliases(root: &Path, head: Option<&str>, paths: &[String]) -> AppResult<()> {
    // The index (including staged removals from HEAD) may spell a path
    // differently from the filesystem. Never delete it as an untracked path.
    let config = run_git(root, &["config", "--bool", "--get", "core.ignorecase"])?;
    match config.status.code() {
        Some(1) => return Ok(()),
        Some(0) if config.stdout != b"true\n" && config.stdout != b"true\r\n" => return Ok(()),
        Some(0) => {}
        _ => return Err(git_output_error(config)),
    }
    let tree = head.map(|head| format!("--with-tree={head}"));
    let specs: Vec<_> = paths
        .iter()
        .map(|path| format!(":(icase,literal){path}"))
        .collect();
    let requested: HashSet<_> = paths.iter().map(String::as_str).collect();
    for chunk in pathspec_chunks(&specs) {
        let mut args = vec!["ls-files", "-z"];
        args.extend(tree.as_deref());
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        let output = run_git_stdout(root, &args)?;
        for entry in output
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let entry = String::from_utf8_lossy(entry);
            // Git matched this entry case-insensitively. It must also be
            // inside one of the requested paths with its exact spelling.
            if !entry
                .match_indices('/')
                .map(|(i, _)| &entry[..i])
                .chain([entry.as_ref()])
                .any(|part| requested.contains(part))
            {
                return Err(AppError::msg("A selected path differs in case from a tracked path. Refresh before discarding changes."));
            }
        }
    }
    Ok(())
}

pub fn discard_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let paths: Vec<String> = paths
        .iter()
        .map(|path| to_git_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    let root = workdir(repo)?;
    let canonical_root = root.canonicalize()?;
    let entries = paths
        .iter()
        .map(|rel| discard_entry_path(&canonical_root, rel))
        .collect::<AppResult<Vec<_>>>()?;
    let output = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    let head = match output.status.code() {
        Some(0) => Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()),
        Some(1) if output.stderr.is_empty() => None,
        _ => return Err(git_output_error(output)),
    };

    // ls-tree includes tree entries (-t), so selecting a tracked directory
    // restores its tracked contents even if it also contains untracked files.
    let tracked = match &head {
        Some(head) => paths_in_head(root, head, &paths)?,
        None => HashSet::new(),
    };
    let mut in_head = Vec::new();
    let mut not_in_head = Vec::new();
    for (rel, full) in paths.into_iter().zip(entries) {
        if tracked.contains(rel.as_bytes()) {
            clear_readonly(&full)?;
            in_head.push(rel);
        } else {
            if fs::symlink_metadata(&full).is_ok_and(|meta| meta.is_dir())
                && full.join(".git").exists()
            {
                return Err(AppError::msg(
                    "Discard changes inside the nested repository instead.",
                ));
            }
            not_in_head.push(rel);
        }
    }

    if !not_in_head.is_empty() {
        reject_case_aliases(root, head.as_deref(), &not_in_head)?;
        if let Some(head) = &head {
            run_git_pathspecs(root, &["reset", "-q", head], &not_in_head)?;
        } else {
            run_git_pathspecs(
                root,
                &["rm", "-q", "--cached", "--force", "--ignore-unmatch"],
                &not_in_head,
            )?;
        }
        // One force flag lets Git protect nested repositories while still
        // removing ignored files within an explicitly selected directory.
        for chunk in pathspec_chunks(&not_in_head) {
            let mut args = vec!["--literal-pathspecs", "clean", "-fdqx", "--"];
            args.extend(chunk.iter().map(String::as_str));
            run_git_stdout(root, &args)?;
        }
    }

    // `git checkout` resets the index entry too, and applies the same filters as
    // `git status`. Writing the raw blob turns a clean CRLF worktree into LF,
    // which stays listed with an empty diff.
    if let Some(head) = head {
        if !in_head.is_empty() {
            run_git_pathspecs(root, &["checkout", &head], &in_head)?;
        }
    }
    Ok(())
}

/// Splits paths so each git invocation stays under the Windows command-line limit.
pub(super) fn pathspec_chunks(paths: &[String]) -> Vec<&[String]> {
    const MAX_CHARS: usize = 24_000;
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut length = 0;
    for (index, path) in paths.iter().enumerate() {
        if index > start && length + path.len() + 3 > MAX_CHARS {
            chunks.push(&paths[start..index]);
            start = index;
            length = 0;
        }
        length += path.len() + 3;
    }
    if start < paths.len() {
        chunks.push(&paths[start..]);
    }
    chunks
}

/// Appends patterns to the top-level .gitignore, skipping ones it already lists
/// and keeping the file's line endings.
pub fn ignore_patterns(repo: &Repository, patterns: &[String]) -> AppResult<()> {
    append_ignore_patterns(&workdir(repo)?.join(".gitignore"), patterns)
}

fn append_ignore_patterns(path: &Path, patterns: &[String]) -> AppResult<()> {
    use std::io::{ErrorKind, Write};

    let existing = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut listed: HashSet<String> = existing
        .lines()
        .map(|line| line.trim().to_string())
        .collect();
    let mut additions = String::new();
    for pattern in patterns.iter().map(|pattern| pattern.trim()) {
        if pattern.is_empty() || !listed.insert(pattern.to_string()) {
            continue;
        }
        if additions.is_empty() && !existing.is_empty() && !existing.ends_with('\n') {
            additions.push_str(newline);
        }
        additions.push_str(pattern);
        additions.push_str(newline);
    }
    if !additions.is_empty() {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(additions.as_bytes())?;
    }
    Ok(())
}

/// Commits through `git commit` so hooks, signing, and an in-progress merge or
/// cherry-pick (its extra parent and original author) are all honoured.
pub fn commit(repo: &Repository, message: &str, amend: bool) -> AppResult<CommitSummary> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::msg("Commit message cannot be empty"));
    }

    if !identity_configured(repo) {
        return Err(AppError::msg(
            "Set user.name and user.email in Git config before committing",
        ));
    }

    let head = head_oid(repo);
    if amend && head.is_none() {
        return Err(AppError::msg("Nothing to amend"));
    }
    // A merge may legitimately record the same tree as HEAD.
    if !amend && git_operation(repo).is_none() && index_matches_head(repo)? {
        return Err(AppError::msg("Nothing to commit"));
    }

    let mut args = vec!["commit", "--file=-"];
    if amend {
        args.push("--amend");
    }
    run_git_input(workdir(repo)?, &args, message.as_bytes())?;
    let oid = head_oid(repo).ok_or_else(|| AppError::msg("Commit did not move HEAD"))?;
    summarize_oid(repo, &oid)
}

#[cfg(test)]
mod ignore_tests {
    use super::*;

    #[test]
    fn ignore_preserves_existing_rules_when_decoding_fails() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".gitignore");
        let original = b"*.log\n#\xff\n";
        fs::write(&path, original).unwrap();
        assert!(append_ignore_patterns(&path, &["*.tmp".into()]).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn ignore_creates_missing_files_and_appends_without_rewriting_rules() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".gitignore");
        append_ignore_patterns(&path, &["*.log".into()]).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"*.log\n");
        fs::write(&path, b"# rules\r\n*.log").unwrap();
        append_ignore_patterns(&path, &["*.log".into(), "*.tmp".into()]).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"# rules\r\n*.log\r\n*.tmp\r\n");
    }
}
