use super::*;

fn isolated(name: &str) -> bool {
    const FLAG: &str = "REBASERAVEN_SUBMODULE_OPERATIONS_TEST";
    if std::env::var(FLAG).as_deref() == Ok(name) {
        return false;
    }
    let temp = tempfile::tempdir().unwrap();
    let global = temp.path().join("global.config");
    fs::write(&global, "").unwrap();
    let test = format!("git::submodules::tests::{name}");
    let output = crate::platform::background_command(std::env::current_exe().unwrap())
        .args(["--exact", &test, "--nocapture"])
        .current_dir(temp.path())
        .env(FLAG, name)
        .env("REBASERAVEN_GIT_SUBMODULE_TRANSPORT_TEST", "1")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_0", "always")
        .env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn identity(root: &Path) {
    run_git_stdout(root, &["config", "user.name", "Alice"]).unwrap();
    run_git_stdout(root, &["config", "user.email", "alice@example.com"]).unwrap();
}

fn repository(root: &Path) -> Repository {
    fs::create_dir_all(root).unwrap();
    run_git_stdout(root, &["init", "-q", "-b", "main"]).unwrap();
    identity(root);
    commit_file(root, "value.txt", "one\n", "Initial version");
    open_at(root).unwrap()
}

fn commit_file(root: &Path, name: &str, body: &str, message: &str) {
    fs::write(root.join(name), body).unwrap();
    run_git_stdout(root, &["add", "--", name]).unwrap();
    run_git_stdout(root, &["-c", "core.hooksPath=", "commit", "-qm", message]).unwrap();
}

fn add(repo: &mut Repository, source: &Path, path: &str, name: &str) {
    let request = SubmoduleAdd {
        url: source.to_string_lossy().into_owned(),
        path: path.into(),
        name: Some(name.into()),
        branch: Some("main".into()),
        depth: None,
        force: false,
    };
    let fingerprint = submodule_catalog(repo).unwrap().fingerprint;
    add_submodule(repo, &request, &fingerprint, |_| {}).unwrap();
}

fn commit_parent(repo: &Repository) {
    run_git_stdout(
        repo.workdir(),
        &["-c", "core.hooksPath=", "commit", "-qm", "Add dependency"],
    )
    .unwrap();
}

#[test]
fn submodule_configuration_preserves_custom_names_fields_and_staging() {
    if isolated("submodule_configuration_preserves_custom_names_fields_and_staging") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let alternate = temp.path().join("alternate");
    run_git_stdout(
        temp.path(),
        &[
            "clone",
            "--quiet",
            source.workdir().to_str().unwrap(),
            alternate.to_str().unwrap(),
        ],
    )
    .unwrap();
    let mut repo = repository(&temp.path().join("parent"));
    add(
        &mut repo,
        source.workdir(),
        "libraries/core",
        "portable-core",
    );
    let module = list_submodules(&repo).unwrap().remove(0);
    assert_eq!(module.name, "portable-core");
    assert_eq!(module.branch.as_deref(), Some("main"));
    assert_eq!(module.url.as_deref(), source.workdir().to_str());
    commit_parent(&repo);
    run_git_stdout(
        repo.workdir(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.portable-core.ignore",
            "untracked",
        ],
    )
    .unwrap();
    let file = repo.workdir().join(".gitmodules");
    let mut text = fs::read_to_string(&file).unwrap();
    text.push_str("# Preserve this comment\n");
    fs::write(&file, text).unwrap();
    fs::write(repo.workdir().join("local.txt"), "keep local\n").unwrap();
    let settings = submodule_settings(&repo, &module.path).unwrap();
    edit_submodule(
        &mut repo,
        &module.path,
        alternate.to_str().unwrap(),
        Some("."),
        &settings.fingerprint,
    )
    .unwrap();
    let updated = submodule_settings(&repo, &module.path).unwrap();
    assert_eq!(updated.module.branch.as_deref(), Some("."));
    assert_eq!(updated.module.url.as_deref(), alternate.to_str());
    assert_eq!(
        config_get_file(&file, "submodule.portable-core.ignore").as_deref(),
        Some("untracked")
    );
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("# Preserve this comment"));
    assert!(
        run_git_stdout(repo.workdir(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty()
    );
    let child = open_at(&repo.workdir().join(&module.path)).unwrap();
    assert_eq!(
        config_get(&child, "remote.origin.url").as_deref(),
        alternate.to_str()
    );
    assert_eq!(
        config_get(&repo, "submodule.portable-core.url").as_deref(),
        alternate.to_str()
    );
    let before = fs::read(&file).unwrap();
    run_git_stdout(child.workdir(), &["config", "custom.concurrent", "keep"]).unwrap();
    assert!(edit_submodule(
        &mut repo,
        &module.path,
        source.workdir().to_str().unwrap(),
        None,
        &updated.fingerprint
    )
    .is_err());
    assert_eq!(fs::read(&file).unwrap(), before);
    let settings = submodule_settings(&repo, &module.path).unwrap();
    edit_submodule(
        &mut repo,
        &module.path,
        alternate.to_str().unwrap(),
        None,
        &settings.fingerprint,
    )
    .unwrap();
    assert!(submodule_settings(&repo, &module.path)
        .unwrap()
        .module
        .branch
        .is_none());
    run_git_stdout(
        child.workdir(),
        &[
            "config",
            "remote.origin.url",
            source.workdir().to_str().unwrap(),
        ],
    )
    .unwrap();
    let before = fs::read(&file).unwrap();
    sync_submodules(&mut repo, std::slice::from_ref(&module.path), true).unwrap();
    assert_eq!(
        config_get(&child, "remote.origin.url").as_deref(),
        alternate.to_str()
    );
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(
        fs::read_to_string(repo.workdir().join("local.txt")).unwrap(),
        "keep local\n"
    );
}

#[test]
fn submodule_updates_distinguish_recorded_remote_merge_rebase_and_literal_paths() {
    if isolated("submodule_updates_distinguish_recorded_remote_merge_rebase_and_literal_paths") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let base = head_oid(&source).unwrap();
    let mut repo = repository(&temp.path().join("parent"));
    add(&mut repo, source.workdir(), "libraries/a", "other-core");
    add(
        &mut repo,
        source.workdir(),
        "libraries/[ab]",
        "literal-core",
    );
    commit_parent(&repo);
    commit_file(source.workdir(), "value.txt", "two\n", "Remote change");
    let remote = head_oid(&source).unwrap();
    let paths: Vec<String> = vec!["libraries/[ab]".into()];
    let child_root = repo.workdir().join(&paths[0]);
    let child = open_at(&child_root).unwrap();
    let other = open_at(&repo.workdir().join("libraries/a")).unwrap();
    let settings = submodule_settings(&repo, &paths[0]).unwrap();
    let quoted_url = "https://example.invalid/team/quoted\"name.git";
    edit_submodule(
        &mut repo,
        &paths[0],
        quoted_url,
        Some("."),
        &settings.fingerprint,
    )
    .unwrap();
    assert_eq!(
        String::from_utf8_lossy(
            &run_git_stdout(child.workdir(), &["remote", "get-url", "origin"]).unwrap()
        )
        .trim(),
        quoted_url
    );
    assert_eq!(
        submodule_settings(&repo, &paths[0])
            .unwrap()
            .module
            .branch
            .as_deref(),
        Some(".")
    );
    assert_eq!(
        submodule_settings(&repo, "libraries/a")
            .unwrap()
            .module
            .branch
            .as_deref(),
        Some("main")
    );
    let settings = submodule_settings(&repo, &paths[0]).unwrap();
    edit_submodule(
        &mut repo,
        &paths[0],
        source.workdir().to_str().unwrap(),
        Some("main"),
        &settings.fingerprint,
    )
    .unwrap();
    let original_url = run_git_stdout(other.workdir(), &["remote", "get-url", "origin"]).unwrap();
    let unrelated_url = "https://example.invalid/unchanged.git";
    for root in [child.workdir(), other.workdir()] {
        run_git_stdout(root, &["config", "remote.origin.url", unrelated_url]).unwrap();
    }
    sync_submodules(&mut repo, &paths, false).unwrap();
    assert_eq!(
        run_git_stdout(child.workdir(), &["remote", "get-url", "origin"]).unwrap(),
        original_url
    );
    assert_eq!(
        String::from_utf8_lossy(
            &run_git_stdout(other.workdir(), &["remote", "get-url", "origin"]).unwrap()
        )
        .trim(),
        unrelated_url
    );
    run_git_stdout(
        other.workdir(),
        &[
            "config",
            "remote.origin.url",
            String::from_utf8_lossy(&original_url).trim(),
        ],
    )
    .unwrap();
    update_submodules(&mut repo, &paths, |_| {}).unwrap();
    assert_eq!(head_oid(&child).as_deref(), Some(base.as_str()));
    let mut options = SubmoduleUpdateOptions {
        remote: true,
        recursive: true,
        fetch: true,
        strategy: SubmoduleUpdateStrategy::Checkout,
    };
    update_submodules_with_options(&mut repo, &paths, Some(&options), |_| {}).unwrap();
    assert_eq!(head_oid(&child).as_deref(), Some(remote.as_str()));
    assert_eq!(head_oid(&other).as_deref(), Some(base.as_str()));
    assert!(
        run_git_stdout(repo.workdir(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty()
    );
    update_submodules(&mut repo, &paths, |_| {}).unwrap();
    assert_eq!(head_oid(&child).as_deref(), Some(base.as_str()));
    fs::write(child_root.join("value.txt"), "uncommitted local data\n").unwrap();
    assert!(update_submodules_with_options(&mut repo, &paths, Some(&options), |_| {}).is_err());
    assert_eq!(
        fs::read_to_string(child_root.join("value.txt")).unwrap(),
        "uncommitted local data\n"
    );
    run_git_stdout(&child_root, &["restore", "value.txt"]).unwrap();
    identity(&child_root);
    run_git_stdout(&child_root, &["switch", "-c", "local-merge"]).unwrap();
    commit_file(&child_root, "local.txt", "local commit\n", "Local change");
    let local = head_oid(&child).unwrap();
    options.strategy = SubmoduleUpdateStrategy::Merge;
    update_submodules_with_options(&mut repo, &paths, Some(&options), |_| {}).unwrap();
    assert!(run_git(
        &child_root,
        &["merge-base", "--is-ancestor", &local, "HEAD"]
    )
    .unwrap()
    .status
    .success());
    assert!(run_git(
        &child_root,
        &["merge-base", "--is-ancestor", &remote, "HEAD"]
    )
    .unwrap()
    .status
    .success());
    assert_eq!(symbolic_branch(&child).as_deref(), Some("local-merge"));
    run_git_stdout(&child_root, &["switch", "-c", "local-rebase", &base]).unwrap();
    commit_file(
        &child_root,
        "rebase.txt",
        "rebase data\n",
        "Replay local change",
    );
    let previous = head_oid(&child).unwrap();
    options.strategy = SubmoduleUpdateStrategy::Rebase;
    update_submodules_with_options(&mut repo, &paths, Some(&options), |_| {}).unwrap();
    assert_ne!(head_oid(&child).as_deref(), Some(previous.as_str()));
    assert_eq!(symbolic_branch(&child).as_deref(), Some("local-rebase"));
    assert!(run_git(
        &child_root,
        &["merge-base", "--is-ancestor", &remote, "HEAD"]
    )
    .unwrap()
    .status
    .success());
    assert_eq!(
        fs::read_to_string(child_root.join("rebase.txt")).unwrap(),
        "rebase data\n"
    );
    assert!(
        update_submodules_with_options(&mut repo, &["missing".into()], Some(&options), |_| {})
            .is_err()
    );
    assert!(update_submodules(&mut repo, &[String::new()], |_| {}).is_err());
    let preview =
        preview_submodule_removal(&repo, &paths[0], &SubmoduleRemovalKind::Deinit, true).unwrap();
    remove_submodule(
        &mut repo,
        &paths[0],
        &SubmoduleRemovalKind::Deinit,
        true,
        &preview.fingerprint,
    )
    .unwrap();
    assert!(!child_root.join(".git").exists());
    assert!(other.workdir().join(".git").is_file());
    assert_eq!(head_oid(&other).as_deref(), Some(base.as_str()));
}

#[test]
fn submodule_removal_previews_protect_files_and_retain_unpublished_history() {
    if isolated("submodule_removal_previews_protect_files_and_retain_unpublished_history") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let mut repo = repository(&temp.path().join("parent"));
    add(&mut repo, source.workdir(), "libraries/core", "custom-core");
    commit_parent(&repo);
    let child_root = repo.workdir().join("libraries/core");
    identity(&child_root);
    commit_file(
        &child_root,
        "local.txt",
        "unpublished\n",
        "Unpublished local commit",
    );
    let child = open_at(&child_root).unwrap();
    let unpublished = head_oid(&child).unwrap();
    let storage = child.path().to_string_lossy().into_owned();
    fs::write(child_root.join("value.txt"), "edited locally\n").unwrap();
    fs::write(child_root.join("untracked.txt"), "keep me\n").unwrap();
    let preview = preview_submodule_removal(
        &repo,
        "libraries/core",
        &SubmoduleRemovalKind::Deinit,
        false,
    )
    .unwrap();
    assert!(preview.dirty);
    assert!(preview.files >= 3);
    assert!(remove_submodule(
        &mut repo,
        "libraries/core",
        &SubmoduleRemovalKind::Deinit,
        false,
        &preview.fingerprint
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(child_root.join("untracked.txt")).unwrap(),
        "keep me\n"
    );
    let preview =
        preview_submodule_removal(&repo, "libraries/core", &SubmoduleRemovalKind::Deinit, true)
            .unwrap();
    fs::write(
        child_root.join("value.txt"),
        "edited again after preview and longer\n",
    )
    .unwrap();
    assert!(remove_submodule(
        &mut repo,
        "libraries/core",
        &SubmoduleRemovalKind::Deinit,
        true,
        &preview.fingerprint
    )
    .is_err());
    let preview =
        preview_submodule_removal(&repo, "libraries/core", &SubmoduleRemovalKind::Deinit, true)
            .unwrap();
    remove_submodule(
        &mut repo,
        "libraries/core",
        &SubmoduleRemovalKind::Deinit,
        true,
        &preview.fingerprint,
    )
    .unwrap();
    assert_eq!(list_submodules(&repo).unwrap()[0].state, "uninitialized");
    assert!(run_git(
        repo.workdir(),
        &["--git-dir", &storage, "cat-file", "-e", &unpublished]
    )
    .unwrap()
    .status
    .success());
    assert!(
        run_git_stdout(repo.workdir(), &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty()
    );
    update_submodules(&mut repo, &["libraries/core".into()], |_| {}).unwrap();
    fs::write(repo.workdir().join("staged.txt"), "staged work\n").unwrap();
    run_git_stdout(repo.workdir(), &["add", "staged.txt"]).unwrap();
    fs::write(repo.workdir().join("value.txt"), "parent local work\n").unwrap();
    let preview = preview_submodule_removal(
        &repo,
        "libraries/core",
        &SubmoduleRemovalKind::Remove,
        false,
    )
    .unwrap();
    remove_submodule(
        &mut repo,
        "libraries/core",
        &SubmoduleRemovalKind::Remove,
        false,
        &preview.fingerprint,
    )
    .unwrap();
    assert!(list_submodules(&repo).unwrap().is_empty());
    assert!(config_get(&repo, "submodule.custom-core.url").is_none());
    assert!(!child_root.join("value.txt").exists());
    assert!(run_git(
        repo.workdir(),
        &["--git-dir", &storage, "cat-file", "-e", &unpublished]
    )
    .unwrap()
    .status
    .success());
    assert_eq!(
        fs::read_to_string(repo.workdir().join("value.txt")).unwrap(),
        "parent local work\n"
    );
    assert!(String::from_utf8_lossy(
        &run_git_stdout(repo.workdir(), &["diff", "--cached", "--name-only"]).unwrap()
    )
    .contains("staged.txt"));
}

#[test]
fn submodule_addition_rejects_stale_unsafe_and_unstaged_metadata_inputs() {
    if isolated("submodule_addition_rejects_stale_unsafe_and_unstaged_metadata_inputs") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let mut repo = repository(&temp.path().join("parent"));
    let mut request = SubmoduleAdd {
        url: source.workdir().to_string_lossy().into_owned(),
        path: "libraries/core".into(),
        name: None,
        branch: None,
        depth: None,
        force: false,
    };
    let stale = submodule_catalog(&repo).unwrap().fingerprint;
    run_git_stdout(repo.workdir(), &["config", "custom.concurrent", "keep"]).unwrap();
    assert!(add_submodule(&mut repo, &request, &stale, |_| {}).is_err());
    assert!(!repo.workdir().join("libraries/core").exists());
    for path in ["../outside", ".git/modules/wrong", ".", ""] {
        request.path = path.into();
        let fingerprint = submodule_catalog(&repo).unwrap().fingerprint;
        assert!(add_submodule(&mut repo, &request, &fingerprint, |_| {}).is_err());
    }
    request.path = "libraries/core".into();
    request.branch = Some(".".into());
    let fingerprint = submodule_catalog(&repo).unwrap().fingerprint;
    let error = add_submodule(&mut repo, &request, &fingerprint, |_| {}).unwrap_err();
    assert!(error.to_string().contains("Choose a named branch"));
    assert!(!repo.workdir().join("libraries").exists());
    assert!(!repo.workdir().join(".gitmodules").exists());
    assert!(!repo.commondir().join("modules/libraries/core").exists());
    request.branch = None;
    fs::write(
        repo.workdir().join(".gitmodules"),
        "# Unstaged local metadata\n",
    )
    .unwrap();
    let fingerprint = submodule_catalog(&repo).unwrap().fingerprint;
    assert!(add_submodule(&mut repo, &request, &fingerprint, |_| {}).is_err());
    assert_eq!(
        fs::read_to_string(repo.workdir().join(".gitmodules")).unwrap(),
        "# Unstaged local metadata\n"
    );
    fs::remove_file(repo.workdir().join(".gitmodules")).unwrap();
    let fingerprint = submodule_catalog(&repo).unwrap().fingerprint;
    request.url = "--upload-pack=wrong".into();
    assert!(add_submodule(&mut repo, &request, &fingerprint, |_| {}).is_err());
    assert!(!repo.workdir().join("libraries/core").exists());
    #[cfg(unix)]
    {
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, repo.workdir().join("linked")).unwrap();
        request.path = "linked/module".into();
        request.url = source.workdir().to_string_lossy().into_owned();
        assert!(add_submodule(&mut repo, &request, &fingerprint, |_| {}).is_err());
        assert!(!outside.join("module").exists());
    }
}

#[test]
fn submodule_recursive_update_and_sync_follow_nested_relative_urls() {
    if isolated("submodule_recursive_update_and_sync_follow_nested_relative_urls") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let nested = repository(&temp.path().join("nested"));
    let alternate = repository(&temp.path().join("alternate"));
    let mut middle = repository(&temp.path().join("middle"));
    add(&mut middle, nested.workdir(), "nested/core", "nested-name");
    run_git_stdout(
        middle.workdir(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.nested-name.url",
            "../nested",
        ],
    )
    .unwrap();
    run_git_stdout(middle.workdir(), &["add", ".gitmodules"]).unwrap();
    commit_parent(&middle);
    let mut parent = repository(&temp.path().join("parent"));
    add(
        &mut parent,
        middle.workdir(),
        "dependencies/middle",
        "middle-name",
    );
    commit_parent(&parent);
    let outer = parent.workdir().join("dependencies/middle");
    let inner = outer.join("nested/core");
    let options = SubmoduleUpdateOptions {
        remote: false,
        recursive: false,
        fetch: true,
        strategy: SubmoduleUpdateStrategy::Checkout,
    };
    update_submodules_with_options(&mut parent, &[], Some(&options), |_| {}).unwrap();
    assert!(!inner.join(".git").exists());
    update_submodules(&mut parent, &[], |_| {}).unwrap();
    let child = open_at(&inner).unwrap();
    assert_eq!(head_oid(&child), head_oid(&nested));
    run_git_stdout(
        &outer,
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.nested-name.url",
            alternate.workdir().to_str().unwrap(),
        ],
    )
    .unwrap();
    let before = fs::read(outer.join(".gitmodules")).unwrap();
    sync_submodules(&mut parent, &[], false).unwrap();
    assert_eq!(
        config_get(&child, "remote.origin.url").as_deref(),
        nested.workdir().to_str()
    );
    sync_submodules(&mut parent, &[], true).unwrap();
    assert_eq!(
        config_get(&child, "remote.origin.url").as_deref(),
        alternate.workdir().to_str()
    );
    assert_eq!(fs::read(outer.join(".gitmodules")).unwrap(), before);
}

#[test]
fn submodule_old_form_history_survives_deinitialization_and_uninitialized_removal() {
    if isolated("submodule_old_form_history_survives_deinitialization_and_uninitialized_removal") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let mut parent = repository(&temp.path().join("parent"));
    run_git_stdout(
        parent.workdir(),
        &[
            "clone",
            "--quiet",
            source.workdir().to_str().unwrap(),
            "legacy",
        ],
    )
    .unwrap();
    run_git_stdout(
        parent.workdir(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.legacy-name.path",
            "legacy",
        ],
    )
    .unwrap();
    run_git_stdout(
        parent.workdir(),
        &[
            "config",
            "--file",
            ".gitmodules",
            "submodule.legacy-name.url",
            source.workdir().to_str().unwrap(),
        ],
    )
    .unwrap();
    run_git_stdout(parent.workdir(), &["add", ".gitmodules", "legacy"]).unwrap();
    commit_parent(&parent);
    run_git_stdout(parent.workdir(), &["submodule", "init", "--", "legacy"]).unwrap();
    let child_root = parent.workdir().join("legacy");
    identity(&child_root);
    commit_file(
        &child_root,
        "private.txt",
        "local history\n",
        "Private local commit",
    );
    let unpublished = head_oid(&open_at(&child_root).unwrap()).unwrap();
    assert!(child_root.join(".git").is_dir());
    let preview =
        preview_submodule_removal(&parent, "legacy", &SubmoduleRemovalKind::Deinit, true).unwrap();
    remove_submodule(
        &mut parent,
        "legacy",
        &SubmoduleRemovalKind::Deinit,
        true,
        &preview.fingerprint,
    )
    .unwrap();
    let storage = parent.path().join("modules/legacy-name");
    assert!(storage.is_dir());
    assert!(run_git(
        parent.workdir(),
        &[
            "--git-dir",
            storage.to_str().unwrap(),
            "cat-file",
            "-e",
            &unpublished
        ]
    )
    .unwrap()
    .status
    .success());
    let preview =
        preview_submodule_removal(&parent, "legacy", &SubmoduleRemovalKind::Remove, false).unwrap();
    remove_submodule(
        &mut parent,
        "legacy",
        &SubmoduleRemovalKind::Remove,
        false,
        &preview.fingerprint,
    )
    .unwrap();
    assert!(list_submodules(&parent).unwrap().is_empty());
    assert!(run_git(
        parent.workdir(),
        &[
            "--git-dir",
            storage.to_str().unwrap(),
            "cat-file",
            "-e",
            &unpublished
        ]
    )
    .unwrap()
    .status
    .success());
}

#[test]
fn submodule_shallow_add_and_explicit_reactivation_preserve_stored_history() {
    if isolated("submodule_shallow_add_and_explicit_reactivation_preserve_stored_history") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    commit_file(source.workdir(), "value.txt", "two\n", "Second version");
    commit_file(source.workdir(), "value.txt", "three\n", "Third version");
    let mut parent = repository(&temp.path().join("parent"));
    let mut request = SubmoduleAdd {
        url: url::Url::from_file_path(source.workdir())
            .unwrap()
            .to_string(),
        path: "shallow".into(),
        name: Some("shallow-name".into()),
        branch: Some("main".into()),
        depth: Some(1),
        force: false,
    };
    let fingerprint = submodule_catalog(&parent).unwrap().fingerprint;
    add_submodule(&mut parent, &request, &fingerprint, |_| {}).unwrap();
    let child_root = parent.workdir().join("shallow");
    assert_eq!(
        String::from_utf8_lossy(
            &run_git_stdout(&child_root, &["rev-parse", "--is-shallow-repository"]).unwrap()
        )
        .trim(),
        "true"
    );
    commit_parent(&parent);
    let preview =
        preview_submodule_removal(&parent, "shallow", &SubmoduleRemovalKind::Remove, false)
            .unwrap();
    remove_submodule(
        &mut parent,
        "shallow",
        &SubmoduleRemovalKind::Remove,
        false,
        &preview.fingerprint,
    )
    .unwrap();
    run_git_stdout(
        parent.workdir(),
        &[
            "-c",
            "core.hooksPath=",
            "commit",
            "-qm",
            "Remove dependency",
        ],
    )
    .unwrap();
    let fingerprint = submodule_catalog(&parent).unwrap().fingerprint;
    assert!(add_submodule(&mut parent, &request, &fingerprint, |_| {}).is_err());
    request.force = true;
    let fingerprint = submodule_catalog(&parent).unwrap().fingerprint;
    add_submodule(&mut parent, &request, &fingerprint, |_| {}).unwrap();
    assert_eq!(list_submodules(&parent).unwrap()[0].name, "shallow-name");
    assert_eq!(head_oid(&open_at(&child_root).unwrap()), head_oid(&source));
}
