//! Push URL lists are edited atomically under Git's normal configuration lock.
use std::hash::{Hash, Hasher};
use std::io::Write;

use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushSettings {
    pub urls: Vec<String>,
    pub fallback_urls: Vec<String>,
    pub inherited: bool,
    pub fingerprint: String,
}

fn remote_exists(repo: &Repository, name: &str) -> AppResult<()> {
    if remote_names(repo)?.iter().any(|remote| remote == name) {
        Ok(())
    } else {
        Err(AppError::msg(format!("Remote `{name}` no longer exists")))
    }
}

fn config_values(repo: &Repository, key: &str, origins: bool) -> AppResult<Vec<String>> {
    let mut args = vec!["config", "--null"];
    if origins {
        args.push("--show-origin");
    }
    args.extend(["--get-all", "--", key]);
    let output = run_git(repo.workdir(), &args)?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(git_output_error(output));
    }
    if output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    Ok(output
        .stdout
        .strip_suffix(&[0])
        .unwrap_or(&output.stdout)
        .split(|byte| *byte == 0)
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect())
}

fn config_path(repo: &Repository) -> PathBuf {
    repo.commondir().join("config")
}

fn own_origin(repo: &Repository, origin: &str, config: &Path) -> bool {
    let Some(origin) = origin.strip_prefix("file:") else {
        return false;
    };
    let origin = Path::new(origin);
    let origin = if origin.is_absolute() {
        origin.to_path_buf()
    } else {
        repo.workdir().join(origin)
    };
    match (origin.canonicalize(), config.canonicalize()) {
        (Ok(origin), Ok(config)) => origin == config,
        _ => false,
    }
}

pub fn remote_push_settings(repo: &Repository, name: &str) -> AppResult<RemotePushSettings> {
    remote_exists(repo, name)?;
    let config = config_path(repo);
    let bytes = fs::read(&config)?;
    if bytes.len() > 4_194_304 {
        return Err(AppError::msg(
            "Repository configuration is too large to edit here.",
        ));
    }
    let records = config_values(repo, &format!("remote.{name}.pushurl"), true)?;
    if records.len() % 2 != 0 {
        return Err(AppError::msg(
            "Git returned incomplete remote configuration.",
        ));
    }
    let mut urls = Vec::new();
    let mut inherited = !fs::symlink_metadata(&config)?.file_type().is_file();
    for pair in records.as_chunks::<2>().0 {
        inherited |= !own_origin(repo, &pair[0], &config);
        urls.push(pair[1].clone());
    }
    let fallback_urls = config_values(repo, &format!("remote.{name}.url"), false)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        &config,
        name,
        bytes,
        &urls,
        &fallback_urls,
        &records,
        inherited,
    )
        .hash(&mut hash);
    Ok(RemotePushSettings {
        urls,
        fallback_urls,
        inherited,
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

struct ConfigLock(PathBuf);
impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn set_remote_push_urls(
    repo: &Repository,
    name: &str,
    urls: &[String],
    fingerprint: &str,
) -> AppResult<()> {
    if urls.len() > 64
        || urls
            .iter()
            .any(|url| url.is_empty() || url.len() > 8192 || url.chars().any(char::is_control))
    {
        return Err(AppError::msg(
            "Enter at most 64 non-empty push URLs, one per line.",
        ));
    }
    let settings = remote_push_settings(repo, name)?;
    if settings.inherited {
        return Err(AppError::msg("Push URLs are defined outside the repository configuration. Edit their source configuration instead."));
    }
    if settings.fingerprint != fingerprint {
        return Err(AppError::msg(
            "Remote configuration changed. Reload it before saving.",
        ));
    }
    let config = config_path(repo);
    let original = fs::read(&config)?;
    let lock_path = config.with_extension("lock");
    let lock_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| {
            AppError::msg(
                "Repository configuration is locked. Finish the other Git operation and retry.",
            )
        })?;
    let _lock = ConfigLock(lock_path);
    drop(lock_file);
    // Other Git writers honor config.lock. Recheck changes made while acquiring it.
    if remote_push_settings(repo, name)?.fingerprint != fingerprint {
        return Err(AppError::msg(
            "Remote configuration changed. Reload it before saving.",
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(repo.commondir())?;
    temporary.write_all(&original)?;
    temporary.as_file().sync_all()?;
    let temporary = temporary.into_temp_path();
    let file = temporary
        .to_str()
        .ok_or_else(|| AppError::msg("Repository configuration requires a UTF-8 path."))?;
    let key = format!("remote.{name}.pushurl");
    if let Some(first) = urls.first() {
        run_git_stdout(
            repo.workdir(),
            &["config", "--file", file, "--replace-all", "--", &key, first],
        )?;
        for url in &urls[1..] {
            run_git_stdout(
                repo.workdir(),
                &["config", "--file", file, "--add", "--", &key, url],
            )?;
        }
    } else {
        let output = run_git(
            repo.workdir(),
            &["config", "--file", file, "--unset-all", "--", &key],
        )?;
        if !output.status.success() && output.status.code() != Some(5) {
            return Err(git_output_error(output));
        }
    }
    if fs::read(&config)? != original {
        return Err(AppError::msg(
            "Remote configuration changed. Reload it before saving.",
        ));
    }
    {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)?;
        file.set_permissions(fs::metadata(&config)?.permissions())?;
        file.sync_all()?;
    }
    temporary
        .persist(&config)
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> (tempfile::TempDir, Repository) {
        let temp = tempfile::tempdir().unwrap();
        run_git_stdout(temp.path(), &["init", "-q"]).unwrap();
        let repo = open_at(temp.path()).unwrap();
        add_remote(&repo, "origin", "https://git.example.com/read/project.git").unwrap();
        (temp, repo)
    }

    #[test]
    fn multiple_push_destinations_round_trip_and_clearing_restores_fetch_fallbacks() {
        let (_temp, repo) = repository();
        run_git_stdout(
            repo.workdir(),
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://mirror.example.com/read/project.git",
            ],
        )
        .unwrap();
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(config_path(&repo))
            .unwrap();
        file.write_all(b"\n# Retain unrelated configuration\n[custom]\n\tmarker = untouched\n")
            .unwrap();
        drop(file);
        let before = remote_push_settings(&repo, "origin").unwrap();
        assert!(before.urls.is_empty());
        assert!(!before.inherited);
        assert_eq!(before.fallback_urls.len(), 2);
        let urls = vec![
            "ssh://git@git.example.com/write/project.git".into(),
            "https://mirror.example.com/write/project.git".into(),
        ];
        set_remote_push_urls(&repo, "origin", &urls, &before.fingerprint).unwrap();
        let after = remote_push_settings(&repo, "origin").unwrap();
        assert_eq!(after.urls, urls);
        assert_eq!(
            config_get(&repo, "custom.marker").as_deref(),
            Some("untouched")
        );
        assert!(fs::read_to_string(config_path(&repo))
            .unwrap()
            .contains("# Retain unrelated configuration"));
        assert!(!config_path(&repo).with_extension("lock").exists());
        let remote = list_remotes(&repo).unwrap().remove(0);
        assert_eq!(
            remote.url.as_deref(),
            Some("https://git.example.com/read/project.git")
        );
        assert_eq!(remote.push_url.as_deref(), Some(urls[0].as_str()));
        let actual = String::from_utf8(
            run_git_stdout(
                repo.workdir(),
                &["remote", "get-url", "--push", "--all", "origin"],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            actual.lines().collect::<Vec<_>>(),
            urls.iter().map(String::as_str).collect::<Vec<_>>()
        );
        set_remote_push_urls(&repo, "origin", &[], &after.fingerprint).unwrap();
        let cleared = remote_push_settings(&repo, "origin").unwrap();
        assert!(cleared.urls.is_empty());
        let actual = String::from_utf8(
            run_git_stdout(
                repo.workdir(),
                &["remote", "get-url", "--push", "--all", "origin"],
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            actual.lines().collect::<Vec<_>>(),
            cleared
                .fallback_urls
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inherited_push_urls_are_visible_and_never_rewritten_in_another_config_file() {
        let (temp, repo) = repository();
        let include = temp.path().join("included.config");
        let content =
            b"[remote \"origin\"]\n\tpushurl = https://git.example.com/inherited/project.git\n";
        fs::write(&include, content).unwrap();
        run_git_stdout(
            repo.workdir(),
            &["config", "include.path", include.to_str().unwrap()],
        )
        .unwrap();
        let before = fs::read(config_path(&repo)).unwrap();
        let settings = remote_push_settings(&repo, "origin").unwrap();
        assert!(settings.inherited);
        assert_eq!(
            settings.urls,
            ["https://git.example.com/inherited/project.git"]
        );
        assert!(set_remote_push_urls(&repo, "origin", &[], &settings.fingerprint).is_err());
        assert_eq!(fs::read(config_path(&repo)).unwrap(), before);
        assert_eq!(fs::read(&include).unwrap(), content);
    }

    #[test]
    fn stale_and_locked_configurations_and_invalid_lists_leave_the_original_intact() {
        let (_temp, repo) = repository();
        let settings = remote_push_settings(&repo, "origin").unwrap();
        let before = fs::read(config_path(&repo)).unwrap();
        for urls in [
            vec![String::new()],
            vec!["https://git.example.com/one\nother".into()],
            vec!["https://git.example.com/project.git".into(); 65],
        ] {
            assert!(set_remote_push_urls(&repo, "origin", &urls, &settings.fingerprint).is_err());
            assert_eq!(fs::read(config_path(&repo)).unwrap(), before);
        }
        let lock = config_path(&repo).with_extension("lock");
        fs::write(&lock, b"other writer").unwrap();
        assert!(
            set_remote_push_urls(&repo, "origin", &[], &settings.fingerprint)
                .unwrap_err()
                .to_string()
                .contains("locked")
        );
        assert_eq!(fs::read(&lock).unwrap(), b"other writer");
        assert_eq!(fs::read(config_path(&repo)).unwrap(), before);
        fs::remove_file(lock).unwrap();
        run_git_stdout(repo.workdir(), &["config", "custom.concurrent", "keep"]).unwrap();
        let newer = fs::read(config_path(&repo)).unwrap();
        assert!(
            set_remote_push_urls(&repo, "origin", &[], &settings.fingerprint)
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
        assert_eq!(fs::read(config_path(&repo)).unwrap(), newer);
        assert!(remote_push_settings(&repo, "missing").is_err());
    }

    #[test]
    fn explicit_empty_config_values_keep_their_origin_and_can_be_cleared() {
        let (_temp, repo) = repository();
        run_git_stdout(repo.workdir(), &["config", "remote.origin.pushurl", ""]).unwrap();
        let settings = remote_push_settings(&repo, "origin").unwrap();
        assert_eq!(settings.urls, [""]);
        assert!(!settings.inherited);
        set_remote_push_urls(&repo, "origin", &[], &settings.fingerprint).unwrap();
        assert!(remote_push_settings(&repo, "origin")
            .unwrap()
            .urls
            .is_empty());
    }

    #[test]
    fn linked_worktrees_edit_the_shared_repository_config() {
        let (temp, repo) = repository();
        run_git_stdout(
            repo.workdir(),
            &[
                "-c",
                "user.name=Alice",
                "-c",
                "user.email=alice@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "--allow-empty",
                "-qm",
                "base",
            ],
        )
        .unwrap();
        let root = temp.path().join("linked");
        run_git_stdout(
            repo.workdir(),
            &["worktree", "add", "-b", "linked", root.to_str().unwrap()],
        )
        .unwrap();
        let linked = open_at(&root).unwrap();
        let settings = remote_push_settings(&linked, "origin").unwrap();
        assert!(!settings.inherited);
        let urls = vec!["ssh://git@git.example.com/project.git".into()];
        set_remote_push_urls(&linked, "origin", &urls, &settings.fingerprint).unwrap();
        assert_eq!(remote_push_settings(&repo, "origin").unwrap().urls, urls);
        assert_eq!(head_oid(&repo), head_oid(&linked));
    }

    #[test]
    fn real_pushes_reach_every_explicit_destination_and_clearing_uses_fetch_urls() {
        let (temp, repo) = repository();
        run_git_stdout(
            repo.workdir(),
            &[
                "-c",
                "user.name=Alice",
                "-c",
                "user.email=alice@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "--allow-empty",
                "-qm",
                "base",
            ],
        )
        .unwrap();
        let tip = head_oid(&repo).unwrap();
        let reader = temp.path().join("read.git");
        let first = temp.path().join("write-one.git");
        let second = temp.path().join("write-two.git");
        for path in [&reader, &first, &second] {
            run_git_stdout(
                repo.workdir(),
                &["init", "--bare", "-q", path.to_str().unwrap()],
            )
            .unwrap();
        }
        set_remote_url(&repo, "origin", reader.to_str().unwrap()).unwrap();
        let settings = remote_push_settings(&repo, "origin").unwrap();
        set_remote_push_urls(
            &repo,
            "origin",
            &[
                first.to_str().unwrap().into(),
                second.to_str().unwrap().into(),
            ],
            &settings.fingerprint,
        )
        .unwrap();
        run_git_stdout(
            repo.workdir(),
            &["push", "origin", "HEAD:refs/heads/explicit"],
        )
        .unwrap();
        for path in [&first, &second] {
            assert_eq!(
                String::from_utf8(
                    run_git_stdout(path, &["rev-parse", "refs/heads/explicit"]).unwrap()
                )
                .unwrap()
                .trim(),
                tip
            );
        }
        assert!(
            !run_git(&reader, &["show-ref", "--verify", "refs/heads/explicit"])
                .unwrap()
                .status
                .success()
        );
        let settings = remote_push_settings(&repo, "origin").unwrap();
        set_remote_push_urls(&repo, "origin", &[], &settings.fingerprint).unwrap();
        run_git_stdout(
            repo.workdir(),
            &["push", "origin", "HEAD:refs/heads/fallback"],
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(
                run_git_stdout(&reader, &["rev-parse", "refs/heads/fallback"]).unwrap()
            )
            .unwrap()
            .trim(),
            tip
        );
        for path in [&first, &second] {
            assert!(
                !run_git(path, &["show-ref", "--verify", "refs/heads/fallback"])
                    .unwrap()
                    .status
                    .success()
            );
        }
    }
}
