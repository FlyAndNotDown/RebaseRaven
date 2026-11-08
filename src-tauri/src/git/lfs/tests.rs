use super::*;
use std::io::Write;

fn fixture() -> Option<(tempfile::TempDir, Repository)> {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    if !run_git(&root, &["lfs", "version"])
        .unwrap()
        .status
        .success()
    {
        eprintln!("Git LFS is not installed; skipping the integration fixture.");
        return None;
    }
    run_git_stdout(&root, &["-c", "init.templateDir=", "init", "-b", "main"]).unwrap();
    run_git_stdout(&root, &["config", "core.hooksPath", ".git/hooks"]).unwrap();
    fs::write(root.join("README.md"), "Example project\n").unwrap();
    commit(&root, "Initial project");
    Some((directory, open_at(&root).unwrap()))
}

fn commit(root: &Path, message: &str) {
    run_git_stdout(root, &["add", "."]).unwrap();
    run_git_stdout(
        root,
        &[
            "-c",
            "user.name=Alice",
            "-c",
            "user.email=alice@example.com",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            message,
        ],
    )
    .unwrap();
}

fn apply(repo: &mut Repository, action: LfsAction) -> LfsOutcome {
    let state = lfs_state(repo).unwrap();
    lfs_action(repo, &action, &state.fingerprint, |_| {}).unwrap()
}

fn track(pattern: &str) -> LfsAction {
    LfsAction::Track {
        pattern: pattern.into(),
        literal: false,
        lockable: false,
    }
}

#[test]
fn local_setup_tracking_and_untracking_keep_history_and_index_untouched() {
    let Some((_dir, mut repo)) = fixture() else {
        return;
    };
    let head = head_oid(&repo);
    let _ = lfs_state(&repo).unwrap();
    assert!(!repo.commondir().join("hooks/pre-push").exists());
    let setup = apply(&mut repo, LfsAction::Install);
    assert!(setup.update.state.filters_configured);
    assert!(config_get_local(&repo, "filter.lfs.clean")
        .unwrap()
        .contains("git-lfs"));
    assert!(repo.commondir().join("hooks/pre-push").is_file());
    let result = apply(&mut repo, track("*.bin"));
    let rule = result
        .update
        .state
        .patterns
        .iter()
        .find(|p| p.pattern == "*.bin")
        .unwrap();
    assert!(rule.tracked && rule.editable);
    assert_eq!(rule.source, ".gitattributes");
    assert!(result.snapshot.status.staged.is_empty());
    assert!(result
        .snapshot
        .status
        .unstaged
        .iter()
        .any(|p| p.path == ".gitattributes"));
    let result = apply(
        &mut repo,
        LfsAction::Untrack {
            pattern: "*.bin".into(),
            source: ".gitattributes".into(),
        },
    );
    assert!(!result
        .update
        .state
        .patterns
        .iter()
        .any(|p| p.pattern == "*.bin" && p.tracked));
    assert_eq!(head_oid(&repo), head);
}

#[test]
fn nested_rules_and_literal_filenames_round_trip_without_changing_other_rules() {
    let Some((_dir, mut repo)) = fixture() else {
        return;
    };
    apply(&mut repo, LfsAction::Install);
    fs::create_dir(repo.workdir().join("media")).unwrap();
    fs::write(
        repo.workdir().join("media/.gitattributes"),
        "# Keep this comment\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text\n",
    )
    .unwrap();
    let result = apply(
        &mut repo,
        LfsAction::Track {
            pattern: "project [1].bin".into(),
            literal: true,
            lockable: true,
        },
    );
    assert!(result
        .update
        .state
        .patterns
        .iter()
        .any(|p| p.pattern == r"project[[:space:]]\[1\].bin" && p.lockable));
    let nested = result
        .update
        .state
        .patterns
        .iter()
        .find(|p| p.source == "media/.gitattributes" && p.tracked)
        .unwrap();
    assert!(nested.editable);
    apply(
        &mut repo,
        LfsAction::Untrack {
            pattern: nested.pattern.clone(),
            source: nested.source.clone(),
        },
    );
    let source = fs::read_to_string(repo.workdir().join("media/.gitattributes")).unwrap();
    assert!(source.contains("# Keep this comment") && source.contains("*.txt text"));
    assert!(!source.contains("filter=lfs"));
    assert!(fs::read_to_string(repo.workdir().join(".gitattributes"))
        .unwrap()
        .contains("filter=lfs"));
    apply(
        &mut repo,
        LfsAction::Untrack {
            pattern: r"project[[:space:]]\[1\].bin".into(),
            source: ".gitattributes".into(),
        },
    );
    assert!(!fs::read_to_string(repo.workdir().join(".gitattributes"))
        .unwrap()
        .contains("filter=lfs"));
}

#[test]
fn native_lfs_transfers_fetch_checkout_pull_and_upload_without_changing_refs() {
    let Some((directory, mut repo)) = fixture() else {
        return;
    };
    apply(&mut repo, LfsAction::Install);
    apply(&mut repo, track("*.bin"));
    let content = b"A complete large-file object used by a reproducible fixture.\n";
    fs::write(repo.workdir().join("asset.bin"), content).unwrap();
    commit(repo.workdir(), "Add large file");
    let head = head_oid(&repo);
    let remote = directory.path().join("remote.git");
    run_git_stdout(
        directory.path(),
        &["init", "--bare", remote.to_str().unwrap()],
    )
    .unwrap();
    let url = url::Url::from_file_path(&remote).unwrap().to_string();
    run_git_stdout(repo.workdir(), &["remote", "add", "origin", &url]).unwrap();
    apply(
        &mut repo,
        LfsAction::Push {
            remote: "origin".into(),
        },
    );
    let pointer = run_git_stdout(repo.workdir(), &["show", "HEAD:asset.bin"]).unwrap();
    assert!(pointer.starts_with(b"version https://git-lfs.github.com/spec/v1"));
    fs::remove_dir_all(repo.commondir().join("lfs/objects")).unwrap();
    fs::write(repo.workdir().join("asset.bin"), &pointer).unwrap();
    let state = lfs_state(&repo).unwrap();
    let file = state.files.iter().find(|f| f.name == "asset.bin").unwrap();
    assert!(!file.checkout && !file.downloaded);
    let fetched = apply(
        &mut repo,
        LfsAction::Fetch {
            remote: "origin".into(),
            include: "*.bin".into(),
            exclude: "".into(),
            recent: false,
        },
    );
    assert!(fetched.update.state.files[0].downloaded && !fetched.update.state.files[0].checkout);
    assert_eq!(fs::read(repo.workdir().join("asset.bin")).unwrap(), pointer);
    apply(&mut repo, LfsAction::Checkout);
    assert_eq!(fs::read(repo.workdir().join("asset.bin")).unwrap(), content);
    fs::remove_dir_all(repo.commondir().join("lfs/objects")).unwrap();
    fs::write(repo.workdir().join("asset.bin"), &pointer).unwrap();
    let pulled = apply(
        &mut repo,
        LfsAction::Pull {
            remote: "origin".into(),
            include: "".into(),
            exclude: "".into(),
        },
    );
    assert!(pulled.update.state.files[0].downloaded && pulled.update.state.files[0].checkout);
    assert_eq!(fs::read(repo.workdir().join("asset.bin")).unwrap(), content);
    assert_eq!(head_oid(&repo), head);
    assert!(status_snapshot(&repo).unwrap().unstaged.is_empty());
}

#[test]
fn checkout_preserves_modified_content_and_install_preserves_existing_hooks() {
    let Some((_directory, mut repo)) = fixture() else {
        return;
    };
    apply(&mut repo, LfsAction::Install);
    apply(&mut repo, track("*.bin"));
    fs::write(
        repo.workdir().join("asset.bin"),
        "Original large-file content\n",
    )
    .unwrap();
    commit(repo.workdir(), "Add large file");
    fs::write(repo.workdir().join("asset.bin"), "Keep these local edits\n").unwrap();
    assert!(
        lfs_state(&repo)
            .unwrap()
            .files
            .iter()
            .find(|file| file.name == "asset.bin")
            .unwrap()
            .modified
    );
    apply(&mut repo, LfsAction::Checkout);
    assert_eq!(
        fs::read_to_string(repo.workdir().join("asset.bin")).unwrap(),
        "Keep these local edits\n"
    );
    let hook = repo.commondir().join("hooks/pre-push");
    fs::write(&hook, "#!/bin/sh\n# Existing custom hook\nexit 0\n").unwrap();
    let state = lfs_state(&repo).unwrap();
    assert!(lfs_action(&mut repo, &LfsAction::Install, &state.fingerprint, |_| {}).is_err());
    assert!(fs::read_to_string(hook)
        .unwrap()
        .contains("Existing custom hook"));
}

#[test]
fn external_attribute_and_remote_changes_invalidate_actions_and_unknown_sources_are_refused() {
    let Some((_dir, mut repo)) = fixture() else {
        return;
    };
    apply(&mut repo, LfsAction::Install);
    apply(&mut repo, track("*.bin"));
    let state = lfs_state(&repo).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(repo.workdir().join(".gitattributes"))
        .unwrap()
        .write_all(b"# External edit\n")
        .unwrap();
    assert!(
        lfs_action(&mut repo, &track("*.psd"), &state.fingerprint, |_| {})
            .unwrap_err()
            .to_string()
            .contains(STALE)
    );
    let state = lfs_state(&repo).unwrap();
    assert!(lfs_action(
        &mut repo,
        &LfsAction::Untrack {
            pattern: "*.bin".into(),
            source: "../.gitattributes".into()
        },
        &state.fingerprint,
        |_| {}
    )
    .is_err());
    assert!(lfs_action(
        &mut repo,
        &LfsAction::Push {
            remote: "--all".into()
        },
        &state.fingerprint,
        |_| {}
    )
    .is_err());
    run_git_stdout(
        repo.workdir(),
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/project.git",
        ],
    )
    .unwrap();
    assert!(lfs_action(&mut repo, &LfsAction::Checkout, &state.fingerprint, |_| {}).is_err());
    assert!(fs::read_to_string(repo.workdir().join(".gitattributes"))
        .unwrap()
        .contains("# External edit"));
}

#[test]
fn attribute_sources_and_patterns_reject_invalid_input() {
    let directory = tempfile::tempdir().unwrap();
    run_git_stdout(directory.path(), &["init", "-b", "main"]).unwrap();
    let repo = open_at(directory.path()).unwrap();
    for source in [
        "../.gitattributes",
        "/.gitattributes",
        ".git/info/attributes",
        ".gitattributes\n",
    ] {
        assert!(attribute_directory(&repo, source).is_err());
    }
    assert!(validate_line("*.bin\n*.psd").is_err());
    assert!(validate_line(&"x".repeat(8193)).is_err());
    assert!(validate_line("--include=*.bin").is_ok());
}

#[cfg(unix)]
#[test]
fn linked_attribute_files_and_directories_are_not_editable() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    run_git_stdout(directory.path(), &["init", "-b", "main"]).unwrap();
    let repo = open_at(directory.path()).unwrap();
    fs::write(outside.path().join(".gitattributes"), "*.bin filter=lfs\n").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join(".gitattributes"),
        directory.path().join(".gitattributes"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("media")).unwrap();
    assert!(attribute_directory(&repo, ".gitattributes").is_err());
    assert!(attribute_directory(&repo, "media/.gitattributes").is_err());
}
