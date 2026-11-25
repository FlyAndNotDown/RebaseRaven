use super::*;

pub(super) struct RefRecord {
    pub(super) name: String,
    pub(super) oid: String,
    pub(super) peeled: String,
    short: String,
    target: String,
    upstream: String,
    upstream_short: String,
    head: bool,
}

pub(super) struct RefCatalog {
    pub(super) entries: Vec<RefRecord>,
    pub(super) remotes: Vec<String>,
    include_remote: bool,
}

impl RefCatalog {
    pub(super) fn read(repo: &Repository, include_remote: bool) -> AppResult<Self> {
        let mut args = vec![
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(symref)%00%(upstream)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
            "refs/tags",
        ];
        if include_remote {
            args.push("refs/remotes");
        }
        let stdout = run_git_stdout(workdir(repo)?, &args)?;
        let entries = String::from_utf8_lossy(&stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\0');
                Some(RefRecord {
                    name: fields.next()?.into(),
                    short: fields.next()?.into(),
                    oid: fields.next()?.into(),
                    peeled: fields.next()?.into(),
                    target: fields.next()?.into(),
                    upstream: fields.next()?.into(),
                    upstream_short: fields.next()?.into(),
                    head: fields.next()? == "*",
                })
            })
            .collect();
        let remotes = if include_remote {
            remote_names(repo).unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Self {
            entries,
            remotes,
            include_remote,
        })
    }

    fn current(&self) -> Option<&RefRecord> {
        self.entries
            .iter()
            .find(|entry| entry.head && entry.name.starts_with("refs/heads/"))
    }

    pub(super) fn head(&self, repo: &Repository) -> Option<String> {
        self.current()
            .map(|entry| entry.oid.clone())
            .or_else(|| head_oid(repo))
    }

    pub(super) fn upstream_oid(&self, repo: &Repository) -> Option<String> {
        if let Some(current) = self.current() {
            return self
                .entries
                .iter()
                .find(|entry| entry.name == current.upstream)
                .map(|entry| entry.oid.clone())
                .or_else(|| {
                    (!current.upstream.is_empty())
                        .then(|| rev_parse(repo, "@{upstream}"))
                        .flatten()
                });
        }
        // Detached HEAD has no upstream. Symbolic HEAD may be unborn.
        None
    }

    pub(super) fn current_branch(
        &self,
        repo: &Repository,
        head: Option<&str>,
    ) -> (Option<String>, bool) {
        let branch = self
            .current()
            .and_then(|entry| entry.name.strip_prefix("refs/heads/"))
            .map(str::to_owned)
            .or_else(|| symbolic_branch(repo));
        let detached = branch.is_none() && head.is_some();
        (
            if detached {
                Some("HEAD".to_string())
            } else {
                branch
            },
            detached,
        )
    }

    pub(super) fn branch_list(&self, current: Option<String>, is_detached: bool) -> BranchList {
        let mut local = Vec::new();
        let mut remote = Vec::new();
        let mut tags = Vec::new();
        for entry in &self.entries {
            if entry.name.starts_with("refs/tags/") {
                tags.push(TagInfo {
                    name: entry.short.clone(),
                    oid: entry.oid.clone(),
                });
                continue;
            }
            let is_remote = entry.name.starts_with("refs/remotes/");
            if is_remote
                && (!entry.target.is_empty()
                    || !is_remote_branch_name(
                        entry.name.trim_start_matches("refs/remotes/"),
                        &self.remotes,
                    )
                    || !is_remote_branch_name(&entry.short, &self.remotes))
            {
                continue;
            }
            let branch = BranchInfo {
                full_ref: entry.name.clone(),
                name: entry.short.clone(),
                oid: entry.oid.clone(),
                is_head: entry.head && !is_remote,
                is_remote,
                upstream: (!entry.upstream_short.is_empty()).then(|| entry.upstream_short.clone()),
            };
            if is_remote {
                remote.push(branch);
            } else {
                local.push(branch);
            }
        }
        local.sort_by_cached_key(|branch| branch.name.to_lowercase());
        remote.sort_by_cached_key(|branch| branch.name.to_lowercase());
        tags.sort_by_cached_key(|tag| tag.name.to_lowercase());
        BranchList {
            current,
            is_detached,
            local,
            remote,
            tags,
            remote_loaded: self.include_remote,
        }
    }
}

pub fn branches(repo: &Repository, include_remote: bool) -> AppResult<BranchList> {
    let catalog = RefCatalog::read(repo, include_remote)?;
    let head = catalog.head(repo);
    let (current, detached) = catalog.current_branch(repo, head.as_deref());
    Ok(catalog.branch_list(current, detached))
}

pub(super) fn is_remote_branch_name(name: &str, remotes: &[String]) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower == "head" || lower.ends_with("/head") {
        return false;
    }
    if !name.contains('/') {
        return false;
    }
    !remotes
        .iter()
        .any(|remote| name.eq_ignore_ascii_case(remote))
}

/// Switching goes through `git switch` so smudge filters such as Git LFS,
/// sparse checkout, and the post-checkout hook all apply.
fn switch(repo: &Repository, args: &[&str]) -> AppResult<()> {
    let mut argv = vec!["switch", "--quiet"];
    argv.extend_from_slice(args);
    run_git_stdout(workdir(repo)?, &argv)?;
    Ok(())
}

pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        return switch(repo, &["--", name]);
    }

    let tag_ref = format!("refs/tags/{name}");
    if ref_exists(repo, &tag_ref) {
        return switch(repo, &["--detach", &tag_ref]);
    }

    if !ref_exists(repo, &format!("refs/remotes/{name}")) {
        return Err(AppError::msg(format!("Branch not found: {name}")));
    }
    let local_name = split_remote_branch(repo, name)
        .map(|(_, branch)| branch)
        .unwrap_or_else(|_| {
            name.split_once('/')
                .map(|(_, rest)| rest)
                .unwrap_or(name)
                .to_string()
        });
    if local_name.is_empty() || local_name == "HEAD" {
        return Err(AppError::msg("Cannot check out that remote ref"));
    }
    if ref_exists(repo, &format!("refs/heads/{local_name}")) {
        return switch(repo, &["--", &local_name]);
    }
    let remote_ref = format!("refs/remotes/{name}");
    switch(repo, &["--create", &local_name, "--track", &remote_ref])
}

pub fn create_tag(
    repo: &Repository,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Tag name cannot be empty"));
    }
    let target = if let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) {
        peel_commit(repo, target)?.id().to_string()
    } else {
        head_oid(repo)
            .ok_or_else(|| AppError::msg("Cannot create a tag before the first commit"))?
    };
    let root = workdir(repo)?;
    // Git handles the configured signing backend and validates the tag name.
    match message.map(str::trim).filter(|value| !value.is_empty()) {
        Some(message) => {
            if !identity_configured(repo) {
                return Err(AppError::msg(
                    "Set user.name and user.email in Git config before tagging",
                ));
            }
            let mut args = vec!["tag", "--annotate", "--file=-"];
            args.extend(["--", name, &target]);
            run_git_input(root, &args, message.as_bytes())?;
        }
        None => {
            // An empty annotation explicitly requests a lightweight tag, even
            // when tag.gpgSign would otherwise invoke an editor for a signed tag.
            run_git_stdout(root, &["tag", "--no-sign", "--", name, &target])?;
        }
    }
    Ok(())
}

pub fn delete_tag(repo: &Repository, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Tag name cannot be empty"));
    }
    run_git_stdout(workdir(repo)?, &["tag", "-d", "--", name])?;
    Ok(())
}

pub fn push_tag(
    repo: &Repository,
    remote: &str,
    name: &str,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<()> {
    let remote = remote.trim();
    let name = name.trim();
    if remote.is_empty() || name.is_empty() {
        return Err(AppError::msg("A remote and tag name are required"));
    }
    let spec = format!("refs/tags/{name}");
    run_git_ok_progress(
        workdir(repo)?,
        &["push", "--progress", "--", remote, &spec],
        on_progress,
    )?;
    Ok(())
}

pub fn create_branch(
    repo: &Repository,
    name: &str,
    switch: bool,
    start: Option<&str>,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    let start = if let Some(start) = start.map(str::trim).filter(|value| !value.is_empty()) {
        Some(peel_commit(repo, start)?.id().to_string())
    } else if head_oid(repo).is_none() {
        return Err(AppError::msg(
            "Cannot create a branch before the first commit",
        ));
    } else {
        None
    };
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        return Err(AppError::msg(format!("Branch `{name}` already exists")));
    }
    let root = workdir(repo)?;
    if let Some(start) = &start {
        run_git_stdout(root, &["branch", "--", name, start])?;
    } else {
        run_git_stdout(root, &["branch", "--", name])?;
    }
    if switch {
        checkout_branch(repo, name)?;
    }
    Ok(())
}

pub(super) fn split_remote_branch(repo: &Repository, name: &str) -> AppResult<(String, String)> {
    let remotes = remote_names(repo)?;
    let mut best: Option<(String, String)> = None;
    for remote in &remotes {
        let prefix = format!("{remote}/");
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() || rest == "HEAD" {
            continue;
        }
        if best.as_ref().map(|(current, _)| current.len()).unwrap_or(0) < remote.len() {
            best = Some((remote.to_string(), rest.to_string()));
        }
    }
    best.ok_or_else(|| AppError::msg(format!("Not a remote branch: {name}")))
}

pub fn rename_branch(repo: &Repository, name: &str, new_name: &str) -> AppResult<()> {
    let name = name.trim();
    let new_name = new_name.trim();
    if !ref_exists(repo, &format!("refs/heads/{name}")) {
        return Err(AppError::msg(format!("Local branch not found: {name}")));
    }
    if new_name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    let root = workdir(repo)?;
    run_git_stdout(root, &["check-ref-format", "--branch", new_name])?;
    // Do not force: Git must reject an existing destination or a branch that
    // cannot safely be renamed, and preserve its config and reflog itself.
    run_git_stdout(root, &["branch", "--move", "--", name, new_name])?;
    Ok(())
}

pub fn set_branch_upstream(repo: &Repository, name: &str, upstream: Option<&str>) -> AppResult<()> {
    let name = name.trim();
    if !ref_exists(repo, &format!("refs/heads/{name}")) {
        return Err(AppError::msg(format!("Local branch not found: {name}")));
    }
    let root = workdir(repo)?;
    if let Some(upstream) = upstream {
        let upstream = upstream.trim();
        let remote_ref = format!("refs/remotes/{upstream}");
        if upstream.is_empty()
            || split_remote_branch(repo, upstream).is_err()
            || !ref_exists(repo, &remote_ref)
        {
            return Err(AppError::msg(format!(
                "Remote branch not found: {upstream}"
            )));
        }
        let argument = format!("--set-upstream-to={remote_ref}");
        run_git_stdout(root, &["branch", &argument, "--", name])?;
    } else {
        run_git_stdout(root, &["branch", "--unset-upstream", "--", name])?;
    }
    Ok(())
}

pub fn delete_branch(
    repo: &mut Repository,
    name: &str,
    force: bool,
    on_progress: impl FnMut(&str) + Send,
) -> AppResult<WorkspaceSnapshot> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Branch name cannot be empty"));
    }
    if ref_exists(repo, &format!("refs/heads/{name}")) {
        if symbolic_branch(repo).as_deref() == Some(name) {
            return Err(AppError::msg("Cannot delete the current branch"));
        }
        let flag = if force { "-D" } else { "-d" };
        run_git_stdout(workdir(repo)?, &["branch", flag, "--", name])?;
        return snapshot(repo);
    }
    if ref_exists(repo, &format!("refs/remotes/{name}")) {
        let (remote, branch) = split_remote_branch(repo, name)?;
        run_git_ok_progress(
            workdir(repo)?,
            &["push", "--progress", "--delete", "--", &remote, &branch],
            on_progress,
        )?;
        let _ = run_git_stdout(workdir(repo)?, &["branch", "-dr", "--", name]);
        return snapshot(repo);
    }
    Err(AppError::msg(format!("Branch not found: {name}")))
}
