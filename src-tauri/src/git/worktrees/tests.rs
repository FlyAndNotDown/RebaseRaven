use super::*;

fn repository(path: &Path) -> Repository {
    fs::create_dir_all(path).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "Alice"],
        vec!["config", "user.email", "alice@example.com"],
        vec!["config", "core.autocrlf", "false"],
    ] {
        run_git_stdout(path, &args).unwrap();
    }
    fs::write(path.join("file.txt"), "base\n").unwrap();
    run_git_stdout(path, &["add", "file.txt"]).unwrap();
    run_git_stdout(path, &["-c", "core.hooksPath=", "commit", "-qm", "base"]).unwrap();
    open_at(path).unwrap()
}

fn linked(repo: &Repository, path: &Path, branch: &str) -> String {
    add_worktree(repo, path.to_str().unwrap(), None, Some(branch), None).unwrap()
}

fn request(kind: WorktreeAction, path: &str, destination: &Path) -> WorktreeRequest {
    WorktreeRequest {
        kind,
        path: path.into(),
        destination: destination.to_string_lossy().into_owned(),
        reason: String::new(),
    }
}

fn apply(repo: &Repository, request: &WorktreeRequest) -> WorktreeChange {
    let preview = preview_worktree_change(repo, request).unwrap();
    change_worktree(&mut repo.clone(), request, &preview.fingerprint).unwrap()
}

#[test]
fn locking_preserves_reasons_and_keeps_unavailable_worktrees_out_of_prune() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let mut lock = request(WorktreeAction::Lock, &path, Path::new(""));
    lock.reason = "Removable drive".into();
    apply(&repo, &lock);
    let tree = list_worktrees(&repo)
        .unwrap()
        .into_iter()
        .find(|tree| tree.path == path)
        .unwrap();
    assert!(tree.locked);
    assert_eq!(tree.lock_reason.as_deref(), Some("Removable drive"));
    assert!(!tree.missing);
    fs::rename(&path, temp.path().join("offline")).unwrap();
    prune_worktrees(&repo).unwrap();
    let trees = list_worktrees(&repo).unwrap();
    assert_eq!(trees.len(), 2);
    assert!(trees[1].locked && trees[1].missing && !trees[1].prunable);
    apply(
        &repo,
        &request(WorktreeAction::Unlock, &path, Path::new("")),
    );
    let trees = list_worktrees(&repo).unwrap();
    assert!(!trees[1].locked && trees[1].prunable && trees[1].missing);
}

#[test]
fn moves_keep_dirty_and_untracked_contents_and_literal_destination_names() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    fs::write(Path::new(&path).join("file.txt"), "local work\n").unwrap();
    fs::write(Path::new(&path).join("untracked.txt"), "keep untracked\n").unwrap();
    let destination = temp.path().join("-moved [ab] worktree");
    let change = request(WorktreeAction::Move, &path, &destination);
    let preview = preview_worktree_change(&repo, &change).unwrap();
    fs::write(temp.path().join("unrelated sibling.txt"), "Keep sibling\n").unwrap();
    fs::write(
        Path::new(&path).join("later.txt"),
        "Created after preview\n",
    )
    .unwrap();
    let result = change_worktree(&mut repo.clone(), &change, &preview.fingerprint).unwrap();
    assert_eq!(result.previous_path.as_deref(), Some(path.as_str()));
    assert!(same_folder(result.path.as_deref().unwrap(), &destination));
    assert!(!Path::new(&path).exists());
    assert_eq!(
        fs::read_to_string(destination.join("later.txt")).unwrap(),
        "Created after preview\n"
    );
    assert_eq!(
        fs::read_to_string(destination.join("file.txt")).unwrap(),
        "local work\n"
    );
    assert_eq!(
        fs::read_to_string(destination.join("untracked.txt")).unwrap(),
        "keep untracked\n"
    );
    let moved = open_at(&destination).unwrap();
    assert_eq!(head_oid(&moved).unwrap(), head_oid(&repo).unwrap());
    assert_eq!(symbolic_branch(&moved).as_deref(), Some("side"));
    assert!(same_folder(
        &list_worktrees(&repo).unwrap()[1].path,
        &destination
    ));
}

#[test]
fn previews_refuse_main_current_locked_occupied_nested_and_foreign_targets() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let destination = temp.path().join("moved");
    let mut change = request(WorktreeAction::Move, &path, &destination);
    let current = open_at(Path::new(&path)).unwrap();
    assert!(preview_worktree_change(&current, &change).is_err());
    change.path = repo.workdir().to_string_lossy().into_owned();
    assert!(preview_worktree_change(&repo, &change).is_err());
    change.path = path.clone();
    for target in [
        PathBuf::from(&path).join("inside"),
        repo.path().join("worktree"),
        temp.path().join("missing/child"),
        temp.path().join("main"),
    ] {
        change.destination = target.to_string_lossy().into_owned();
        assert!(preview_worktree_change(&repo, &change).is_err());
    }
    change.destination = destination.to_string_lossy().into_owned();
    apply(&repo, &request(WorktreeAction::Lock, &path, Path::new("")));
    assert!(preview_worktree_change(&repo, &change).is_err());
    apply(
        &repo,
        &request(WorktreeAction::Unlock, &path, Path::new("")),
    );
    fs::rename(&path, temp.path().join("retained")).unwrap();
    let _foreign = repository(Path::new(&path));
    assert!(preview_worktree_change(&repo, &change).is_err());
    assert!(Path::new(&path).join("file.txt").exists());
}

#[test]
fn stale_catalog_and_changed_destination_parent_reject_the_apply() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let mut change = request(WorktreeAction::Lock, &path, Path::new(""));
    let preview = preview_worktree_change(&repo, &change).unwrap();
    run_git_stdout(
        repo.workdir(),
        &[
            "worktree",
            "lock",
            "--reason",
            "External change",
            "--",
            &path,
        ],
    )
    .unwrap();
    assert!(change_worktree(&mut repo.clone(), &change, &preview.fingerprint).is_err());
    assert_eq!(
        list_worktrees(&repo).unwrap()[1].lock_reason.as_deref(),
        Some("External change")
    );
    apply(
        &repo,
        &request(WorktreeAction::Unlock, &path, Path::new("")),
    );
    let parent = temp.path().join("destination-parent");
    fs::create_dir(&parent).unwrap();
    change = request(WorktreeAction::Move, &path, &parent.join("moved"));
    let preview = preview_worktree_change(&repo, &change).unwrap();
    fs::rename(&parent, temp.path().join("replaced-parent")).unwrap();
    fs::create_dir(&parent).unwrap();
    assert!(change_worktree(&mut repo.clone(), &change, &preview.fingerprint).is_err());
    assert!(Path::new(&path).is_dir());
}

#[test]
fn repairs_a_manually_relocated_worktree_without_touching_its_local_work() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let destination = temp.path().join("manually moved");
    fs::write(Path::new(&path).join("file.txt"), "uncommitted\n").unwrap();
    fs::rename(&path, &destination).unwrap();
    let result = apply(&repo, &request(WorktreeAction::Repair, &path, &destination));
    assert!(same_folder(result.path.as_deref().unwrap(), &destination));
    assert!(same_folder(
        &list_worktrees(&repo).unwrap()[1].path,
        &destination
    ));
    assert_eq!(
        fs::read_to_string(destination.join("file.txt")).unwrap(),
        "uncommitted\n"
    );
    assert_eq!(
        symbolic_branch(&open_at(&destination).unwrap()).as_deref(),
        Some("side")
    );
}

#[test]
fn repairs_links_after_the_main_worktree_is_relocated() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let repo = repository(&main);
    let path = linked(&repo, &temp.path().join("side"), "side");
    let destination = temp.path().join("relocated main");
    drop(repo);
    fs::rename(&main, &destination).unwrap();
    let moved = open_at(&destination).unwrap();
    assert!(open_at(Path::new(&path)).is_err());
    apply(
        &moved,
        &request(WorktreeAction::RepairAll, "", Path::new("")),
    );
    verify_connection(&moved, &path).unwrap();
}

#[test]
fn repairs_when_both_main_and_linked_worktree_folders_moved() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let repo = repository(&main);
    let path = linked(&repo, &temp.path().join("side"), "side");
    let destination = temp.path().join("relocated side");
    let new_main = temp.path().join("relocated main");
    drop(repo);
    fs::rename(&main, &new_main).unwrap();
    fs::rename(&path, &destination).unwrap();
    let moved = open_at(&new_main).unwrap();
    apply(
        &moved,
        &request(WorktreeAction::Repair, &path, &destination),
    );
    verify_connection(&moved, destination.to_str().unwrap()).unwrap();
}

#[test]
fn repair_does_not_adopt_another_worktree_or_repository() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let other = linked(&repo, &temp.path().join("other"), "other");
    let foreign = repository(&temp.path().join("foreign"));
    let foreign_link = linked(&foreign, &temp.path().join("foreign side"), "foreign-side");
    let untouched = fs::read(Path::new(&foreign_link).join(".git")).unwrap();
    for target in [
        Path::new(&other),
        Path::new(&foreign_link),
        foreign.workdir(),
        temp.path(),
    ] {
        assert!(
            preview_worktree_change(&repo, &request(WorktreeAction::Repair, &path, target))
                .is_err()
        );
    }
    assert_eq!(
        untouched,
        fs::read(Path::new(&foreign_link).join(".git")).unwrap()
    );
}

#[test]
fn administrative_changes_serialize_across_linked_worktrees_and_existing_operations() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let linked_repo = open_at(Path::new(&path)).unwrap();
    let change = request(WorktreeAction::Lock, &path, Path::new(""));
    let preview = preview_worktree_change(&repo, &change).unwrap();
    let lock = WorktreeLock::acquire(&linked_repo).unwrap();
    assert!(change_worktree(&mut repo.clone(), &change, &preview.fingerprint).is_err());
    assert!(remove_worktree(&repo, &path, true).is_err());
    assert!(prune_worktrees(&repo).is_err());
    assert!(add_worktree(
        &repo,
        temp.path().join("new").to_str().unwrap(),
        None,
        Some("new"),
        None
    )
    .is_err());
    drop(lock);
    change_worktree(&mut repo.clone(), &change, &preview.fingerprint).unwrap();
}

#[test]
fn nul_delimited_reasons_and_empty_flags_remain_distinct() {
    let trees = parse_worktree_list("worktree /repo\0HEAD abc\0\0worktree /side\0locked reason\nsecond line\0\0worktree /missing\0prunable stale connection\0\0");
    assert!(!trees[0].locked && trees[0].lock_reason.is_none());
    assert_eq!(trees[1].lock_reason.as_deref(), Some("reason\nsecond line"));
    assert_eq!(trees[2].prune_reason.as_deref(), Some("stale connection"));
}

#[test]
fn repairs_relative_links_after_the_linked_folder_is_relocated() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    run_git_stdout(
        repo.workdir(),
        &["config", "worktree.useRelativePaths", "true"],
    )
    .unwrap();
    let path = linked(&repo, &temp.path().join("side"), "side");
    if config_get_local(&repo, "extensions.relativeWorktrees").is_none() {
        eprintln!("Relative worktree connections require Git 2.48 or newer.");
        return;
    }
    let destination = temp.path().join("relative moved");
    fs::rename(&path, &destination).unwrap();
    apply(&repo, &request(WorktreeAction::Repair, &path, &destination));
    verify_connection(&repo, destination.to_str().unwrap()).unwrap();
}

#[test]
fn native_submodule_move_restrictions_are_visible_before_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    run_git_stdout(
        Path::new(&path),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--",
            source.workdir().to_str().unwrap(),
            "module",
        ],
    )
    .unwrap();
    let destination = temp.path().join("moved");
    let error = preview_worktree_change(&repo, &request(WorktreeAction::Move, &path, &destination))
        .unwrap_err();
    assert!(error.to_string().contains("submodules"));
    assert!(Path::new(&path).join("module/file.txt").exists());
    assert!(!destination.exists());
}

#[test]
fn staging_in_another_worktree_does_not_invalidate_administrative_changes() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let other = linked(&repo, &temp.path().join("other"), "other");
    let change = request(WorktreeAction::Lock, &path, Path::new(""));
    let preview = preview_worktree_change(&repo, &change).unwrap();
    fs::write(
        Path::new(&other).join("new.txt"),
        "Independent staged work\n",
    )
    .unwrap();
    run_git_stdout(Path::new(&other), &["add", "new.txt"]).unwrap();
    change_worktree(&mut repo.clone(), &change, &preview.fingerprint).unwrap();
    assert!(list_worktrees(&repo)
        .unwrap()
        .iter()
        .any(|tree| tree.path == path && tree.locked));
    assert_eq!(
        fs::read_to_string(Path::new(&other).join("new.txt")).unwrap(),
        "Independent staged work\n"
    );
}

#[test]
fn a_copy_can_reconnect_from_another_worktree_without_retargeting_the_command_owner() {
    let temp = tempfile::tempdir().unwrap();
    let repo = repository(&temp.path().join("main"));
    let path = linked(&repo, &temp.path().join("side"), "side");
    let copy = temp.path().join("copy");
    fs::create_dir(&copy).unwrap();
    for name in [".git", "file.txt"] {
        fs::copy(Path::new(&path).join(name), copy.join(name)).unwrap();
    }
    let current = open_at(Path::new(&path)).unwrap();
    let change = request(WorktreeAction::Repair, &path, &copy);
    assert!(preview_worktree_change(&current, &change).is_err());
    apply(&repo, &change);
    verify_connection(&repo, copy.to_str().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(copy.join("file.txt")).unwrap(), "base\n");
    assert!(Path::new(&path).join("file.txt").is_file());
}

#[test]
fn linked_worktrees_from_a_bare_repository_keep_the_primary_entry_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let source = repository(&temp.path().join("source"));
    let bare = temp.path().join("store.git");
    run_git_stdout(
        temp.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "clone",
            "--bare",
            "--",
            source.workdir().to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    )
    .unwrap();
    let checkout = temp.path().join("checkout");
    run_git_stdout(
        &bare,
        &[
            "worktree",
            "add",
            "--detach",
            "--",
            checkout.to_str().unwrap(),
            "HEAD",
        ],
    )
    .unwrap();
    let repo = open_at(&checkout).unwrap();
    let path = linked(&repo, &temp.path().join("side"), "side");
    let trees = list_worktrees(&repo).unwrap();
    assert!(trees[0].bare && trees[0].main && !trees[0].current);
    assert!(trees
        .iter()
        .any(|tree| tree.current && !tree.bare && tree.detached));
    apply(&repo, &request(WorktreeAction::Lock, &path, Path::new("")));
    apply(
        &repo,
        &request(WorktreeAction::Unlock, &path, Path::new("")),
    );
    let destination = temp.path().join("moved");
    apply(&repo, &request(WorktreeAction::Move, &path, &destination));
    verify_connection(&repo, destination.to_str().unwrap()).unwrap();
}
