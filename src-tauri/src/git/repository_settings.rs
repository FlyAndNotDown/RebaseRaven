use super::*;
use serde::Deserialize;
use std::hash::{Hash, Hasher};
use std::io::Write;

const STALE: &str = "Repository configuration changed. Reload it before saving.";
const KEYS: [&str; 2] = ["user.name", "user.email"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryField {
    pub key: String,
    pub value: Option<String>,
    pub inherited: Option<String>,
    pub effective: Option<String>,
    pub origin: Option<String>,
    pub editable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositorySettings {
    pub fields: Vec<GitRepositoryField>,
    pub worktree: bool,
    pub read_only: bool,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryChange {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Hash)]
struct Record {
    scope: String,
    origin: String,
    key: String,
    value: String,
}

fn config_file(repo: &Repository) -> AppResult<(PathBuf, bool)> {
    let output = run_git(
        repo.workdir(),
        &[
            "config",
            "--local",
            "--includes",
            "--type=bool",
            "--get",
            "extensions.worktreeConfig",
        ],
    )?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(git_output_error(output));
    }
    let worktree = output.status.success() && output.stdout.starts_with(b"true");
    Ok((
        if worktree {
            repo.path().join("config.worktree")
        } else {
            repo.commondir().join("config")
        },
        worktree,
    ))
}

fn contents(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 4_194_304 => Ok(Some(bytes)),
        Ok(_) => Err(AppError::msg(
            "Repository configuration is too large to edit here.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn records(repo: &Repository) -> AppResult<Vec<Record>> {
    let output = run_git(
        repo.workdir(),
        &[
            "config",
            "--null",
            "--includes",
            "--show-origin",
            "--show-scope",
            "--get-regexp",
            r"^(user\.name|user\.email)$",
        ],
    )?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(git_output_error(output));
    }
    if output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|_| AppError::msg("Repository configuration requires UTF-8 values."))?;
    let fields: Vec<_> = text
        .strip_suffix('\0')
        .unwrap_or(&text)
        .split('\0')
        .collect();
    if fields.len() % 3 != 0 {
        return Err(AppError::msg(
            "Git returned incomplete repository configuration.",
        ));
    }
    Ok(fields
        .as_chunks::<3>()
        .0
        .iter()
        .map(|parts| {
            let (key, value) = parts[2]
                .split_once('\n')
                .map_or((parts[2], None), |(key, value)| (key, Some(value)));
            Record {
                scope: parts[0].into(),
                origin: parts[1].into(),
                key: key.into(),
                value: value.unwrap_or_default().to_string(),
            }
        })
        .collect())
}

fn own_origin(repo: &Repository, origin: &str, path: &Path) -> bool {
    let Some(origin) = origin.strip_prefix("file:") else {
        return false;
    };
    let origin = Path::new(origin);
    let origin = if origin.is_absolute() {
        origin.to_path_buf()
    } else {
        repo.workdir().join(origin)
    };
    match (origin.canonicalize(), path.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub fn repository_settings(repo: &Repository) -> AppResult<GitRepositorySettings> {
    let (file, worktree) = config_file(repo)?;
    let original = contents(&file)?;
    let read_only = fs::symlink_metadata(&file)
        .is_ok_and(|meta| !meta.file_type().is_file() || meta.permissions().readonly());
    let records = records(repo)?;
    let fields = KEYS
        .iter()
        .map(|key| {
            let matching: Vec<_> = records.iter().filter(|record| record.key == *key).collect();
            let own = matching
                .iter()
                .rev()
                .find(|record| own_origin(repo, &record.origin, &file));
            let inherited = matching
                .iter()
                .rev()
                .find(|record| !own_origin(repo, &record.origin, &file));
            let effective = matching.last();
            GitRepositoryField {
                key: key.to_string(),
                value: own.map(|record| record.value.clone()),
                inherited: inherited.map(|record| record.value.clone()),
                effective: effective.map(|record| record.value.clone()),
                origin: effective.map(|record| record.origin.clone()),
                editable: !read_only
                    && effective.is_none_or(|record| {
                        record.scope != "command"
                            && (own.is_none() || own_origin(repo, &record.origin, &file))
                    }),
            }
        })
        .collect();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (&file, original, worktree, read_only, records).hash(&mut hash);
    Ok(GitRepositorySettings {
        fields,
        worktree,
        read_only,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

struct ConfigLock(PathBuf);
impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn set_repository_settings(
    repo: &Repository,
    changes: &[GitRepositoryChange],
    fingerprint: &str,
) -> AppResult<GitRepositorySettings> {
    let state = repository_settings(repo)?;
    if state.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    if state.read_only {
        return Err(AppError::msg(
            "Edit repository settings in their source configuration file.",
        ));
    }
    let mut seen = HashSet::new();
    for change in changes {
        if !KEYS.contains(&change.key.as_str()) || !seen.insert(&change.key) {
            return Err(AppError::msg(
                "Choose each supported repository setting at most once.",
            ));
        }
        if !state.fields.iter().any(|field| {
            field.key == change.key
                && (field.editable || (change.value.is_none() && field.value.is_some()))
        }) {
            return Err(AppError::msg("This repository setting is overridden by another configuration source. Edit its source instead."));
        }
        if let Some(value) = &change.value {
            let valid = !value.trim().is_empty()
                && value.len() <= 8192
                && !value.chars().any(char::is_control);
            if !valid {
                return Err(AppError::msg(
                    "Enter a valid repository setting, or reset it to inherit.",
                ));
            }
        }
    }
    if changes.is_empty() {
        return Ok(state);
    }
    let (file, _) = config_file(repo)?;
    let mut lock_name = file.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    let lock = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| {
            AppError::msg(
                "Repository configuration is locked. Finish the other Git operation and retry.",
            )
        })?;
    let _guard = ConfigLock(lock_path);
    drop(lock);
    if repository_settings(repo)?.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    let original = contents(&file)?.unwrap_or_default();
    let mut temporary = tempfile::NamedTempFile::new_in(
        file.parent()
            .ok_or_else(|| AppError::msg("Missing Git configuration directory."))?,
    )?;
    temporary.write_all(&original)?;
    temporary.as_file().sync_all()?;
    let temporary = temporary.into_temp_path();
    let path = temporary
        .to_str()
        .ok_or_else(|| AppError::msg("Repository configuration requires a UTF-8 path."))?;
    for change in changes {
        if let Some(value) = &change.value {
            run_git_stdout(
                repo.workdir(),
                &[
                    "config",
                    "--file",
                    path,
                    "--no-includes",
                    "--replace-all",
                    "--",
                    &change.key,
                    value,
                ],
            )?;
            let checked = run_git_stdout(
                repo.workdir(),
                &[
                    "config",
                    "--file",
                    path,
                    "--includes",
                    "--null",
                    "--get",
                    "--",
                    &change.key,
                ],
            )?;
            let text = String::from_utf8_lossy(&checked);
            if text.strip_suffix('\0').unwrap_or(&text) != *value {
                return Err(AppError::msg("An included configuration overrides this repository setting. Edit its source instead."));
            }
        } else {
            let output = run_git(
                repo.workdir(),
                &[
                    "config",
                    "--file",
                    path,
                    "--no-includes",
                    "--unset-all",
                    "--",
                    &change.key,
                ],
            )?;
            if !output.status.success() && output.status.code() != Some(5) {
                return Err(git_output_error(output));
            }
        }
    }
    if repository_settings(repo)?.fingerprint != fingerprint {
        return Err(AppError::msg(STALE));
    }
    {
        let edited = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)?;
        if let Ok(metadata) = fs::metadata(&file) {
            edited.set_permissions(metadata.permissions())?;
        }
        edited.sync_all()?;
    }
    temporary
        .persist(&file)
        .map_err(|error| AppError::Io(error.error))?;
    repository_settings(repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> (tempfile::TempDir, Repository) {
        let root = tempfile::tempdir().unwrap();
        run_git_stdout(root.path(), &["init", "-q"]).unwrap();
        let repo = open_at(root.path()).unwrap();
        (root, repo)
    }
    fn change(key: &str, value: Option<&str>) -> GitRepositoryChange {
        GitRepositoryChange {
            key: key.into(),
            value: value.map(str::to_string),
        }
    }
    fn field<'a>(state: &'a GitRepositorySettings, key: &str) -> &'a GitRepositoryField {
        state.fields.iter().find(|field| field.key == key).unwrap()
    }

    #[test]
    fn identity_overrides_inherit_and_preserve_unrelated_configuration() {
        let (_root, repo) = repository();
        let included = repo.commondir().join("identity.cfg");
        fs::write(
            &included,
            "[user]\n name = Included Author\n email = included@example.com\n",
        )
        .unwrap();
        config_set_local(&repo, "include.path", "identity.cfg").unwrap();
        config_set_local(&repo, "commit.gpgsign", "true").unwrap();
        let original = fs::read(&included).unwrap();
        let state = repository_settings(&repo).unwrap();
        assert_eq!(state.fields.len(), 2);
        assert_eq!(field(&state, "user.name").value, None);
        assert_eq!(
            field(&state, "user.name").inherited.as_deref(),
            Some("Included Author")
        );
        let state = set_repository_settings(
            &repo,
            &[
                change("user.name", Some("Local Author")),
                change("user.email", Some("local@example.com")),
            ],
            &state.fingerprint,
        )
        .unwrap();
        assert_eq!(
            field(&state, "user.name").effective.as_deref(),
            Some("Local Author")
        );
        let state =
            set_repository_settings(&repo, &[change("user.name", None)], &state.fingerprint)
                .unwrap();
        assert_eq!(
            field(&state, "user.name").effective.as_deref(),
            Some("Included Author")
        );
        assert_eq!(
            config_get_local(&repo, "commit.gpgsign").as_deref(),
            Some("true")
        );
        assert_eq!(fs::read(&included).unwrap(), original);
    }

    #[test]
    fn identity_updates_collapse_duplicate_local_values() {
        let (_root, repo) = repository();
        config_set_local(&repo, "user.name", "First").unwrap();
        run_git_stdout(repo.workdir(), &["config", "--add", "user.name", "Second"]).unwrap();
        let state = repository_settings(&repo).unwrap();
        assert_eq!(field(&state, "user.name").value.as_deref(), Some("Second"));
        set_repository_settings(
            &repo,
            &[change("user.name", Some("Updated"))],
            &state.fingerprint,
        )
        .unwrap();
        assert_eq!(
            run_git_stdout(
                repo.workdir(),
                &["config", "--local", "--get-all", "user.name"]
            )
            .unwrap(),
            b"Updated\n"
        );
    }

    #[test]
    fn stale_locked_or_invalid_changes_preserve_configuration() {
        let (_root, repo) = repository();
        let file = repo.commondir().join("config");
        let state = repository_settings(&repo).unwrap();
        let original = fs::read(&file).unwrap();
        for changes in [
            vec![change("gpg.format", Some("ssh"))],
            vec![change("user.name", Some("bad\nname"))],
            vec![change("user.email", Some(""))],
            vec![
                change("user.name", Some("First")),
                change("user.name", None),
            ],
        ] {
            assert!(set_repository_settings(&repo, &changes, &state.fingerprint).is_err());
            assert_eq!(fs::read(&file).unwrap(), original);
        }
        let lock = repo.commondir().join("config.lock");
        fs::write(&lock, "another writer").unwrap();
        assert!(set_repository_settings(
            &repo,
            &[change("user.name", Some("Local"))],
            &state.fingerprint
        )
        .is_err());
        assert_eq!(fs::read_to_string(&lock).unwrap(), "another writer");
        fs::remove_file(lock).unwrap();
        config_set_local(&repo, "unrelated.value", "keep").unwrap();
        let changed = fs::read(&file).unwrap();
        assert!(set_repository_settings(
            &repo,
            &[change("user.name", Some("Local"))],
            &state.fingerprint
        )
        .unwrap_err()
        .to_string()
        .contains("Reload"));
        assert_eq!(fs::read(&file).unwrap(), changed);
    }

    #[test]
    fn later_includes_cannot_make_an_identity_override_a_silent_noop() {
        let (_root, repo) = repository();
        config_set_local(&repo, "user.name", "Original").unwrap();
        let included = repo.commondir().join("identity.cfg");
        fs::write(&included, "[user]\n name = Included\n").unwrap();
        config_set_local(&repo, "include.path", "identity.cfg").unwrap();
        let state = repository_settings(&repo).unwrap();
        assert!(!field(&state, "user.name").editable);
        let original = fs::read(repo.commondir().join("config")).unwrap();
        assert!(set_repository_settings(
            &repo,
            &[change("user.name", Some("Local"))],
            &state.fingerprint
        )
        .is_err());
        assert_eq!(fs::read(repo.commondir().join("config")).unwrap(), original);
        let state =
            set_repository_settings(&repo, &[change("user.name", None)], &state.fingerprint)
                .unwrap();
        assert_eq!(
            field(&state, "user.name").effective.as_deref(),
            Some("Included")
        );
    }

    #[test]
    fn worktree_identity_uses_its_own_configuration_and_lock() {
        let (root, repo) = repository();
        config_set_local(&repo, "user.name", "Example").unwrap();
        config_set_local(&repo, "user.email", "example@example.com").unwrap();
        run_git_stdout(
            repo.workdir(),
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Initial",
            ],
        )
        .unwrap();
        config_set_local(&repo, "extensions.worktreeConfig", "true").unwrap();
        let linked = root.path().join("linked");
        run_git_stdout(
            repo.workdir(),
            &[
                "worktree",
                "add",
                "-b",
                "topic",
                linked.to_str().unwrap(),
                "HEAD",
            ],
        )
        .unwrap();
        let linked = open_at(&linked).unwrap();
        let state = repository_settings(&linked).unwrap();
        assert!(state.worktree);
        let lock = linked.path().join("config.worktree.lock");
        fs::write(&lock, "another writer").unwrap();
        assert!(set_repository_settings(
            &linked,
            &[change("user.name", Some("Worktree Author"))],
            &state.fingerprint
        )
        .is_err());
        fs::remove_file(lock).unwrap();
        let state = set_repository_settings(
            &linked,
            &[change("user.name", Some("Worktree Author"))],
            &state.fingerprint,
        )
        .unwrap();
        assert_eq!(
            field(&state, "user.name").effective.as_deref(),
            Some("Worktree Author")
        );
        assert_eq!(
            field(&repository_settings(&repo).unwrap(), "user.name")
                .effective
                .as_deref(),
            Some("Example")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_configuration_is_readable_but_never_replaced() {
        let (_root, repo) = repository();
        let file = repo.commondir().join("config");
        let source = repo.commondir().join("shared-config");
        fs::rename(&file, &source).unwrap();
        std::os::unix::fs::symlink(&source, &file).unwrap();
        let state = repository_settings(&repo).unwrap();
        let original = fs::read(&source).unwrap();
        assert!(state.read_only);
        assert!(set_repository_settings(
            &repo,
            &[change("user.name", Some("Local"))],
            &state.fingerprint
        )
        .is_err());
        assert_eq!(fs::read(source).unwrap(), original);
        assert!(file.is_symlink());
    }
}
