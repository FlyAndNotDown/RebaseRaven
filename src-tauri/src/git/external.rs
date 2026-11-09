use super::*;
use crate::file_tools::{ExternalFiles, FILE_LIMIT};

fn revision_blob(repo: &Repository, spec: &str) -> AppResult<Option<Vec<u8>>> {
    let output = run_git(repo.workdir(), &["cat-file", "-s", spec])?;
    if !output.status.success() {
        return Ok(None);
    }
    let size = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<usize>()
        .map_err(|_| AppError::msg("The selected file revision is unavailable."))?;
    if size > FILE_LIMIT {
        return Err(AppError::msg(
            "External file previews are limited to 64 MiB.",
        ));
    }
    run_git_stdout(repo.workdir(), &["cat-file", "blob", spec]).map(Some)
}

/// A historical editor action opens the displayed revision, including deleted and renamed files.
pub fn editor_file(
    repo: &Repository,
    source: &FileSource,
    files: &ExternalFiles,
) -> AppResult<PathBuf> {
    let (path, specs) = match source {
        FileSource::Workdir { path, .. } => {
            let relative = safe_repo_path(path)?;
            let full = ensure_inside_workdir(repo, &relative)?;
            if full.is_file() {
                return Ok(full);
            }
            (
                path,
                vec![format!(":0:{relative}"), format!("HEAD:{relative}")],
            )
        }
        FileSource::Commit {
            oid,
            path,
            old_path,
        } => {
            let path = safe_repo_path(path)?;
            let old = safe_repo_path(old_path.as_deref().unwrap_or(&path))?;
            let commit = peel_commit(repo, oid)?;
            let mut specs = vec![format!("{}:{path}", commit.id)];
            if let Some(parent) = commit.parents.first() {
                specs.push(format!("{parent}:{old}"));
            }
            return revision_editor_file(repo, &path, &specs, files);
        }
        FileSource::Compare {
            base,
            head,
            path,
            old_path,
        } => {
            let relative = safe_repo_path(path)?;
            let old = safe_repo_path(old_path.as_deref().unwrap_or(path))?;
            (
                path,
                vec![
                    format!("{}:{relative}", peel_commit(repo, head)?.id),
                    format!("{}:{old}", peel_commit(repo, base)?.id),
                ],
            )
        }
        FileSource::Stash { oid, path } => {
            let relative = safe_repo_path(path)?;
            let stash = peel_commit(repo, oid)?;
            let mut specs = vec![format!("{}:{relative}", stash.id)];
            if let Some(parent) = stash.parents.get(2) {
                specs.push(format!("{parent}:{relative}"));
            }
            if let Some(parent) = stash.parents.first() {
                specs.push(format!("{parent}:{relative}"));
            }
            (path, specs)
        }
    };
    revision_editor_file(repo, path, &specs, files)
}

fn revision_editor_file(
    repo: &Repository,
    path: &str,
    specs: &[String],
    files: &ExternalFiles,
) -> AppResult<PathBuf> {
    for spec in specs {
        if let Some(bytes) = revision_blob(repo, spec)? {
            return files.revision(path, &bytes);
        }
    }
    Err(AppError::msg("The selected file revision is unavailable."))
}
