//! Git LFS operations retain the native filters, hooks and transfer configuration.
use std::hash::{Hash, Hasher};
use std::io::Write;

use serde::{de::DeserializeOwned, Deserialize};

use super::*;

const STALE: &str = "Git LFS settings changed. Refresh before trying again.";
const JSON_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
pub struct LfsPattern {
    pub pattern: String,
    pub source: String,
    pub lockable: bool,
    pub tracked: bool,
    #[serde(default)]
    pub editable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Hash)]
pub struct LfsFile {
    pub name: String,
    pub size: u64,
    pub checkout: bool,
    pub downloaded: bool,
    pub oid: String,
    #[serde(default)]
    pub modified: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsState {
    pub version: Option<String>,
    pub filters_configured: bool,
    pub patterns: Vec<LfsPattern>,
    pub files: Vec<LfsFile>,
    pub remotes: Vec<String>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LfsAction {
    Install,
    Track {
        pattern: String,
        literal: bool,
        lockable: bool,
    },
    Untrack {
        pattern: String,
        source: String,
    },
    Fetch {
        remote: String,
        include: String,
        exclude: String,
        recent: bool,
    },
    Pull {
        remote: String,
        include: String,
        exclude: String,
    },
    Checkout,
    Push {
        remote: String,
    },
}

#[derive(Debug, Serialize)]
pub struct LfsUpdate {
    pub state: LfsState,
    pub report: String,
}

#[derive(Debug, Serialize)]
pub struct LfsOutcome {
    #[serde(flatten)]
    pub update: LfsUpdate,
    pub snapshot: WorkspaceSnapshot,
}

fn read_json<T: DeserializeOwned>(repo: &Repository, args: &[&str]) -> AppResult<T> {
    let mut child = spawn_git_stdout_env(
        repo.workdir(),
        args,
        &[("GIT_LFS_TRACK_NO_INSTALL_HOOKS", "1")],
    )?;
    let result = (|| {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::msg("Could not read Git LFS data."))?;
        let mut bytes = Vec::new();
        stdout.take(JSON_LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > JSON_LIMIT {
            return Err(AppError::msg("Git LFS data exceeds 32 MiB."));
        }
        if !child.wait()?.success() {
            return Err(AppError::msg(
                "Could not read Git LFS data. Check your Git LFS installation.",
            ));
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            AppError::msg("Could not read Git LFS JSON data. Update Git LFS and try again.")
        })
    })();
    if result.is_err() {
        stop_child(&mut child);
    }
    result
}

fn attribute_directory(repo: &Repository, source: &str) -> AppResult<PathBuf> {
    if source.contains(['\0', '\n', '\r', '\\'])
        || Path::new(source).is_absolute()
        || safe_repo_path(source)? != source
        || Path::new(source).file_name() != Some(std::ffi::OsStr::new(".gitattributes"))
    {
        return Err(AppError::msg(
            "Only repository attribute files can be edited here.",
        ));
    }
    let mut current = repo.workdir().to_path_buf();
    for part in source.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::msg(
                    "Linked attribute files cannot be edited here.",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let parent = current
        .parent()
        .ok_or_else(|| AppError::msg("Only repository attribute files can be edited here."))?;
    if !parent
        .canonicalize()?
        .starts_with(repo.workdir().canonicalize()?)
    {
        return Err(AppError::msg(
            "Only repository attribute files can be edited here.",
        ));
    }
    Ok(parent.to_path_buf())
}

fn hash_file(path: &Path, hash: &mut impl Hasher) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::read_link(path)?.hash(hash),
        Ok(_) => {
            let (bytes, too_large) = files::read_text_prefix(path)?;
            if too_large {
                return Err(AppError::msg(
                    "Git LFS attribute files must be smaller than 2 MiB.",
                ));
            }
            bytes.hash(hash);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None::<u8>.hash(hash),
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn local_pattern<'a>(pattern: &'a str, source: &str) -> AppResult<&'a str> {
    let parent = source
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    if parent.is_empty() {
        return Ok(pattern);
    }
    pattern
        .strip_prefix(parent)
        .and_then(|value| value.strip_prefix('/'))
        .ok_or_else(|| AppError::msg("Refresh and select an editable Git LFS rule."))
}

fn matching_rule(line: &str, pattern: &str) -> bool {
    let mut fields = line.split_whitespace();
    fields.next() == Some(pattern) && fields.any(|value| value == "filter=lfs")
}

fn editable_rule(repo: &Repository, pattern: &LfsPattern) -> bool {
    if !pattern.tracked || attribute_directory(repo, &pattern.source).is_err() {
        return false;
    }
    let Ok(relative) = local_pattern(&pattern.pattern, &pattern.source) else {
        return false;
    };
    let Ok((bytes, truncated)) = files::read_text_prefix(&repo.workdir().join(&pattern.source))
    else {
        return false;
    };
    !truncated
        && String::from_utf8(bytes)
            .is_ok_and(|text| text.lines().any(|line| matching_rule(line, relative)))
}

fn remove_rule(repo: &Repository, pattern: &str, source: &str) -> AppResult<()> {
    let directory = attribute_directory(repo, source)?;
    let relative = local_pattern(pattern, source)?;
    let path = directory.join(".gitattributes");
    let (before, truncated) = files::read_text_prefix(&path)?;
    if truncated {
        return Err(AppError::msg(
            "Git LFS attribute files must be smaller than 2 MiB.",
        ));
    }
    let text = std::str::from_utf8(&before)
        .map_err(|_| AppError::msg("Refresh and select an editable Git LFS rule."))?;
    // Native untrack cannot round-trip literal glob escapes from track --json.
    let after: String = text
        .split_inclusive('\n')
        .filter(|line| !matching_rule(line, relative))
        .collect();
    if after.as_bytes() == before {
        return Err(AppError::msg(
            "Refresh and select an editable Git LFS rule.",
        ));
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.as_file()
        .set_permissions(fs::metadata(&path)?.permissions())?;
    file.write_all(after.as_bytes())?;
    file.flush()?;
    attribute_directory(repo, source)?;
    if fs::read(&path)? != before {
        return Err(AppError::msg(STALE));
    }
    file.persist(&path).map_err(|error| error.error)?;
    Ok(())
}

pub fn lfs_state(repo: &Repository) -> AppResult<LfsState> {
    let output = run_git(repo.workdir(), &["lfs", "version"])?;
    let version = output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let configured = config_get(repo, "filter.lfs.process").is_some_and(|value| !value.is_empty())
        || ["filter.lfs.clean", "filter.lfs.smudge"]
            .iter()
            .all(|key| config_get(repo, key).is_some_and(|value| !value.is_empty()));
    let mut patterns = Vec::new();
    let mut files = Vec::new();
    if version.is_some() {
        #[derive(Deserialize)]
        struct Patterns {
            patterns: Option<Vec<LfsPattern>>,
        }
        #[derive(Deserialize)]
        struct Files {
            files: Option<Vec<LfsFile>>,
        }
        patterns = read_json::<Patterns>(repo, &["lfs", "track", "--json"])?
            .patterns
            .unwrap_or_default();
        for pattern in &mut patterns {
            pattern.editable = editable_rule(repo, pattern);
        }
        patterns.sort_by(|a, b| (&a.source, &a.pattern).cmp(&(&b.source, &b.pattern)));
        files = read_json::<Files>(repo, &["lfs", "ls-files", "--json"])?
            .files
            .unwrap_or_default();
        let status = status_snapshot(repo)?;
        let modified: HashSet<_> = status
            .staged
            .iter()
            .chain(&status.unstaged)
            .flat_map(|file| std::iter::once(file.path.as_str()).chain(file.old_path.as_deref()))
            .collect();
        for file in &mut files {
            file.modified = modified.contains(file.name.as_str());
        }
        files.sort_by(|a, b| (&a.name, &a.oid).cmp(&(&b.name, &b.oid)));
    }
    let remotes = remote_names(repo)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        repo.workdir(),
        repo.path(),
        head_oid(repo),
        symbolic_branch(repo),
        &version,
        configured,
        &patterns,
        &files,
        &remotes,
    )
        .hash(&mut hash);
    let config = run_git(repo.workdir(), &["config", "--null", "--get-regexp", "(^lfs\\.|^filter\\.lfs\\.|^core\\.hookspath$|^remote\\..*\\.(url|pushurl|lfsurl|lfspushurl)$)"])?;
    if !config.status.success() && config.status.code() != Some(1) {
        return Err(git_output_error(config));
    }
    config.stdout.hash(&mut hash);
    for source in std::iter::once(".gitattributes")
        .chain(
            patterns
                .iter()
                .filter(|pattern| pattern.editable)
                .map(|pattern| pattern.source.as_str()),
        )
        .chain(std::iter::once(".lfsconfig"))
    {
        source.hash(&mut hash);
        hash_file(&repo.workdir().join(source), &mut hash)?;
    }
    Ok(LfsState {
        version,
        filters_configured: configured,
        patterns,
        files,
        remotes,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

fn validate_line(value: &str) -> AppResult<()> {
    if value.len() > 8192 || value.contains(['\0', '\n', '\r']) {
        return Err(AppError::msg(
            "Enter a single Git LFS pattern smaller than 8 KiB.",
        ));
    }
    Ok(())
}

fn transfer_args(
    state: &LfsState,
    kind: &str,
    remote: &str,
    include: &str,
    exclude: &str,
) -> AppResult<Vec<String>> {
    if remote.starts_with('-') || !state.remotes.iter().any(|known| known == remote) {
        return Err(AppError::msg("Choose an existing Git remote."));
    }
    validate_line(include)?;
    validate_line(exclude)?;
    let mut args = vec!["lfs".into(), kind.into()];
    if !include.is_empty() {
        args.push(format!("--include={include}"));
    }
    if !exclude.is_empty() {
        args.push(format!("--exclude={exclude}"));
    }
    args.push(remote.into());
    Ok(args)
}

pub fn lfs_action(
    repo: &mut Repository,
    action: &LfsAction,
    expected: &str,
    mut on_progress: impl FnMut(&str) + Send,
) -> AppResult<LfsOutcome> {
    let state = lfs_state(repo)?;
    if state.fingerprint != expected {
        return Err(AppError::msg(STALE));
    }
    if state.version.is_none() {
        return Err(AppError::msg("Git LFS is not installed."));
    }
    let cwd = repo.workdir().to_path_buf();
    let args: Vec<String> =
        match action {
            LfsAction::Install => vec!["lfs".into(), "install".into(), "--local".into()],
            LfsAction::Track {
                pattern,
                literal,
                lockable,
            } => {
                validate_line(pattern)?;
                if pattern.trim().is_empty() {
                    return Err(AppError::msg("Enter a Git LFS pattern."));
                }
                attribute_directory(repo, ".gitattributes")?;
                let mut args = vec!["lfs".into(), "track".into()];
                if *literal {
                    args.push("--filename".into());
                }
                if *lockable {
                    args.push("--lockable".into());
                }
                args.extend(["--".into(), pattern.clone()]);
                args
            }
            LfsAction::Untrack { pattern, source } => {
                if !state.patterns.iter().any(|known| {
                    known.editable && known.pattern == *pattern && known.source == *source
                }) {
                    return Err(AppError::msg(
                        "Refresh and select an editable Git LFS rule.",
                    ));
                }
                remove_rule(repo, pattern, source)?;
                Vec::new()
            }
            LfsAction::Fetch {
                remote,
                include,
                exclude,
                recent,
            } => {
                let mut args = transfer_args(&state, "fetch", remote, include, exclude)?;
                if *recent {
                    args.insert(2, "--recent".into());
                }
                args
            }
            LfsAction::Pull {
                remote,
                include,
                exclude,
            } => transfer_args(&state, "pull", remote, include, exclude)?,
            LfsAction::Checkout => vec!["lfs".into(), "checkout".into()],
            LfsAction::Push { remote } => {
                let mut args = transfer_args(&state, "push", remote, "", "")?;
                args.push("HEAD".into());
                args
            }
        };
    let mut report = String::new();
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    if !refs.is_empty() {
        run_git_progress(Some(&cwd), &refs, |line| {
            on_progress(line);
            if report.len() + line.len() < 65_536 {
                report.push_str(line);
                report.push('\n');
            }
        })?;
    }
    Ok(LfsOutcome {
        update: LfsUpdate {
            state: lfs_state(repo)?,
            report,
        },
        snapshot: snapshot(repo)?,
    })
}

#[cfg(test)]
mod tests;
