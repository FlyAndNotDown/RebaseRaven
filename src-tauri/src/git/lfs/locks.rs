use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
struct Owner {
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
pub struct LfsLock {
    id: String,
    path: String,
    owner: Option<Owner>,
    locked_at: String,
    #[serde(default)]
    ours: bool,
}

#[derive(Debug, Serialize)]
pub struct LfsLocks {
    remote: String,
    pub locks: Vec<LfsLock>,
    pub fingerprint: String,
}

fn output(
    repo: &Repository,
    args: &[&str],
    progress: &mut (impl FnMut(&str) + Send),
) -> AppResult<Vec<u8>> {
    let file = tempfile::NamedTempFile::new()?;
    run_git_progress_output(repo.workdir(), args, file.reopen()?, progress)?;
    let mut bytes = Vec::new();
    fs::File::open(file.path())?
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err(AppError::msg("Git LFS lock data exceeds 32 MiB."));
    }
    Ok(bytes)
}

fn verify_output(locks: &[LfsLock]) -> Vec<u8> {
    let max_path = locks.iter().map(|lock| lock.path.len()).max().unwrap_or(0);
    let max_owner = locks
        .iter()
        .map(|lock| lock.owner.as_ref().map_or(0, |owner| owner.name.len()))
        .max()
        .unwrap_or(0);
    let mut text = String::new();
    for lock in locks {
        let owner = lock.owner.as_ref().map_or("", |owner| owner.name.as_str());
        text.push_str(&format!(
            "{}{}{}\t{}{}\tID:{}\n",
            if lock.ours { "O " } else { "  " },
            lock.path,
            " ".repeat(max_path - lock.path.len()),
            owner,
            " ".repeat(max_owner - owner.len()),
            lock.id
        ));
    }
    text.into_bytes()
}

fn read(
    repo: &Repository,
    state: &LfsState,
    remote: &str,
    progress: &mut (impl FnMut(&str) + Send),
) -> AppResult<LfsLocks> {
    transfer_args(state, "locks", remote, "", "")?;
    let remote_arg = format!("--remote={remote}");
    // The native JSON command can exit successfully after a failed server query.
    // Check its regular exit status, then verify the cached JSON against that output.
    let verified = output(repo, &["lfs", "locks", "--verify", &remote_arg], progress)?;
    let bytes = output(
        repo,
        &[
            "lfs",
            "locks",
            "--verify",
            "--cached",
            "--json",
            &remote_arg,
        ],
        progress,
    )?;
    #[derive(Deserialize)]
    struct Response {
        ours: Option<Vec<LfsLock>>,
        theirs: Option<Vec<LfsLock>>,
    }
    let response: Response = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::msg("Could not read Git LFS lock data."))?;
    let mut locks = response.ours.unwrap_or_default();
    for lock in &mut locks {
        lock.ours = true;
    }
    locks.extend(
        response
            .theirs
            .unwrap_or_default()
            .into_iter()
            .map(|mut lock| {
                lock.ours = false;
                lock
            }),
    );
    locks.sort_by(|a, b| (&a.path, &a.id).cmp(&(&b.path, &b.id)));
    if verify_output(&locks) != verified {
        return Err(AppError::msg(
            "Git LFS lock data changed while being read. Refresh locks and try again.",
        ));
    }
    if super::lfs_state(repo)?.fingerprint != state.fingerprint {
        return Err(AppError::msg(STALE));
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (&state.fingerprint, remote, &locks).hash(&mut hash);
    Ok(LfsLocks {
        remote: remote.into(),
        locks,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn checked_path(repo: &Repository, path: &str) -> AppResult<PathBuf> {
    if path.is_empty()
        || path.contains(['\0', '\n', '\r'])
        || Path::new(path).is_absolute()
        || safe_repo_path(path)? != path
    {
        return Err(AppError::msg("Choose one file inside this repository."));
    }
    work_file_path(repo, path)
}

pub(super) fn action(
    repo: &Repository,
    state: &LfsState,
    action: &LfsAction,
    progress: &mut (impl FnMut(&str) + Send),
) -> AppResult<LfsLocks> {
    let remote = match action {
        LfsAction::Locks { remote }
        | LfsAction::Lock { remote, .. }
        | LfsAction::Unlock { remote, .. } => remote,
        _ => unreachable!(),
    };
    transfer_args(state, "locks", remote, "", "")?;
    if matches!(action, LfsAction::Locks { .. }) {
        return read(repo, state, remote, progress);
    }
    let remote_arg = format!("--remote={remote}");
    match action {
        LfsAction::Lock { path, .. } => {
            let file = checked_path(repo, path)?;
            if !file.is_file() {
                return Err(AppError::msg("Choose an existing file to lock."));
            }
            run_git_stdout(
                repo.workdir(),
                &[
                    "--literal-pathspecs",
                    "ls-files",
                    "--error-unmatch",
                    "--",
                    path,
                ],
            )?;
            run_git_progress(
                Some(repo.workdir()),
                &["lfs", "lock", &remote_arg, "--", path],
                &mut *progress,
            )?;
        }
        LfsAction::Unlock {
            id,
            path,
            force,
            confirmation,
            lock_fingerprint,
            ..
        } => {
            let _ = checked_path(repo, path)?;
            let current = read(repo, state, remote, progress)?;
            if &current.fingerprint != lock_fingerprint
                || !current
                    .locks
                    .iter()
                    .any(|lock| &lock.id == id && &lock.path == path)
            {
                return Err(AppError::msg(
                    "Git LFS locks changed. Refresh locks before unlocking.",
                ));
            }
            if *force && confirmation != path {
                return Err(AppError::msg(
                    "Type the locked path to confirm a forced unlock.",
                ));
            }
            if !*force {
                if !current.locks.iter().any(|lock| &lock.id == id && lock.ours) {
                    return Err(AppError::msg("This Git LFS lock belongs to another user."));
                }
                let status = status_snapshot(repo)?;
                if status
                    .staged
                    .iter()
                    .chain(&status.unstaged)
                    .any(|file| &file.path == path || file.old_path.as_ref() == Some(path))
                {
                    return Err(AppError::msg(
                        "Commit or discard local changes before unlocking this file.",
                    ));
                }
            }
            let id_arg = format!("--id={id}");
            let mut args = vec!["lfs", "unlock", &remote_arg, &id_arg];
            if *force {
                args.push("--force");
            }
            run_git_progress(Some(repo.workdir()), &args, &mut *progress)?;
        }
        _ => unreachable!(),
    }
    let latest = super::lfs_state(repo)?;
    read(repo,&latest,remote,progress).map_err(|error|AppError::msg(format!("The Git LFS lock operation completed, but its lock list could not be refreshed. Refresh locks to confirm the result.\n{error}")))
}

#[cfg(test)]
mod tests;
