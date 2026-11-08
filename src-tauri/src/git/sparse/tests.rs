use super::*;

fn fixture() -> (tempfile::TempDir, Repository) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("main");
    fs::create_dir(&root).unwrap();
    run_git_stdout(&root, &["init", "-b", "main"]).unwrap();
    for (path, text) in [
        ("README.md", "Example project\n"),
        (".gitignore", "*.cache\n"),
        ("src/main.rs", "fn main() {}\n"),
        ("src/lib.rs", "pub fn example() {}\n"),
        ("docs/readme.md", "Documentation\n"),
        ("tools/setup.sh", "exit 0\n"),
    ] {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    run_git_stdout(&root, &["add", "."]).unwrap();
    run_git_stdout(
        &root,
        &[
            "-c",
            "user.name=Alice",
            "-c",
            "user.email=alice@example.com",
            "commit",
            "-m",
            "Initial project",
        ],
    )
    .unwrap();
    let repo = open_at(&root).unwrap();
    (directory, repo)
}

fn selection(cone: bool, rules: &[&str]) -> SparseCheckoutRequest {
    SparseCheckoutRequest::Set {
        cone,
        sparse_index: false,
        rules: rules.iter().map(|rule| rule.to_string()).collect(),
    }
}

fn review(repo: &Repository, request: &SparseCheckoutRequest) -> SparseCheckoutPreview {
    preview_sparse_checkout(
        repo,
        request,
        &sparse_checkout_state(repo).unwrap().fingerprint,
    )
    .unwrap()
}

fn apply(repo: &mut Repository, request: &SparseCheckoutRequest) -> SparseCheckoutOutcome {
    let preview = review(repo, request);
    apply_sparse_checkout(repo, request, &preview.fingerprint, false, |_| {}).unwrap()
}

#[test]
fn directory_selection_and_full_checkout_preserve_head_and_root_files() {
    let (_directory, mut repo) = fixture();
    let head = head_oid(&repo).unwrap();
    let request = selection(true, &["src"]);
    let initial = sparse_checkout_state(&repo).unwrap();
    assert!(!initial.enabled);
    let checked = review(&repo, &request);
    assert_eq!(checked.selected, 4);
    assert_eq!(checked.outside, 2);
    assert!(
        repo.workdir().join("docs/readme.md").exists(),
        "Preview must not change the working tree"
    );
    let result = apply(&mut repo, &request);
    assert!(result.update.state.enabled && result.update.state.cone);
    assert_eq!(result.update.state.rules, ["src"]);
    assert!(repo.workdir().join("README.md").exists());
    assert!(repo.workdir().join("src/main.rs").exists());
    assert!(!repo.workdir().join("docs/readme.md").exists());
    let expanded = SparseCheckoutRequest::Set {
        cone: true,
        sparse_index: true,
        rules: vec!["src".into(), "docs".into()],
    };
    let result = apply(&mut repo, &expanded);
    assert!(result.update.state.sparse_index);
    assert!(repo.workdir().join("docs/readme.md").exists());
    assert!(!repo.workdir().join("tools/setup.sh").exists());
    let result = apply(&mut repo, &SparseCheckoutRequest::Disable);
    assert!(!result.update.state.enabled);
    assert!(repo.workdir().join("tools/setup.sh").exists());
    assert_eq!(head_oid(&repo).unwrap(), head);
}

#[test]
fn arbitrary_patterns_are_matched_by_git_and_comments_survive_round_trips() {
    let (_directory, mut repo) = fixture();
    let request = selection(
        false,
        &["# Source entry point", "/src/*.rs", "!/src/lib.rs"],
    );
    let preview = review(&repo, &request);
    assert_eq!(preview.selected_paths, ["src/main.rs"]);
    let result = apply(&mut repo, &request);
    assert!(!result.update.state.cone);
    assert_eq!(
        result.update.state.rules,
        ["# Source entry point", "/src/*.rs", "!/src/lib.rs"]
    );
    assert!(repo.workdir().join("src/main.rs").exists());
    assert!(!repo.workdir().join("src/lib.rs").exists());
    assert!(!repo.workdir().join("README.md").exists());
    apply(&mut repo, &SparseCheckoutRequest::Disable);
    assert!(repo.workdir().join("src/lib.rs").exists());
}

#[test]
fn ignored_paths_require_review_and_new_ignored_files_invalidate_approval() {
    let (_directory, mut repo) = fixture();
    fs::write(
        repo.workdir().join("docs/local.cache"),
        "Important ignored data",
    )
    .unwrap();
    let request = selection(true, &["src"]);
    let checked = review(&repo, &request);
    assert_eq!(checked.ignored_paths, ["docs/local.cache"]);
    assert!(
        apply_sparse_checkout(&mut repo, &request, &checked.fingerprint, false, |_| {}).is_err()
    );
    assert!(!sparse_checkout_state(&repo).unwrap().enabled);
    assert_eq!(
        fs::read_to_string(repo.workdir().join("docs/local.cache")).unwrap(),
        "Important ignored data"
    );
    fs::write(
        repo.workdir().join("docs/another.cache"),
        "New ignored data",
    )
    .unwrap();
    assert!(
        apply_sparse_checkout(&mut repo, &request, &checked.fingerprint, true, |_| {}).is_err()
    );
    assert!(repo.workdir().join("docs/readme.md").exists());
    let checked = review(&repo, &request);
    assert_eq!(checked.ignored_count, 2);
    let result =
        apply_sparse_checkout(&mut repo, &request, &checked.fingerprint, true, |_| {}).unwrap();
    assert!(result.update.state.enabled);
    assert!(!repo.workdir().join("docs/readme.md").exists());
}

#[test]
fn dirty_paths_are_kept_reported_and_removed_only_after_restore_and_reapply() {
    let (_directory, mut repo) = fixture();
    fs::write(repo.workdir().join("docs/readme.md"), "Keep local edits\n").unwrap();
    let request = selection(true, &["src"]);
    let checked = review(&repo, &request);
    assert_eq!(checked.dirty_paths, ["docs/readme.md"]);
    let result = apply(&mut repo, &request);
    assert!(result.update.report.contains("docs/readme.md"));
    assert_eq!(
        fs::read_to_string(repo.workdir().join("docs/readme.md")).unwrap(),
        "Keep local edits\n"
    );
    run_git_stdout(
        repo.workdir(),
        &[
            "restore",
            "--worktree",
            "--ignore-skip-worktree-bits",
            "--",
            "docs/readme.md",
        ],
    )
    .unwrap();
    apply(&mut repo, &SparseCheckoutRequest::Reapply);
    assert!(!repo.workdir().join("docs/readme.md").exists());
}

#[test]
fn external_rule_changes_head_changes_and_invalid_requests_never_use_old_approval() {
    let (_directory, mut repo) = fixture();
    let original = sparse_checkout_state(&repo).unwrap();
    let request = selection(true, &["docs"]);
    let checked = review(&repo, &request);
    run_git_stdout(repo.workdir(), &["sparse-checkout", "set", "--cone", "src"]).unwrap();
    assert!(preview_sparse_checkout(&repo, &request, &original.fingerprint).is_err());
    assert!(
        apply_sparse_checkout(&mut repo, &request, &checked.fingerprint, true, |_| {}).is_err()
    );
    let checked = review(&repo, &request);
    fs::write(repo.workdir().join("README.md"), "New project revision\n").unwrap();
    run_git_stdout(
        repo.workdir(),
        &[
            "-c",
            "user.name=Alice",
            "-c",
            "user.email=alice@example.com",
            "commit",
            "-am",
            "Update project",
        ],
    )
    .unwrap();
    assert!(
        apply_sparse_checkout(&mut repo, &request, &checked.fingerprint, true, |_| {}).is_err()
    );
    let bad = selection(true, &["src\n--disable"]);
    assert!(review_result(&repo, &bad).is_err());
    assert!(repo.workdir().join("src/main.rs").exists());
    assert!(!repo.workdir().join("docs/readme.md").exists());
}

fn review_result(
    repo: &Repository,
    request: &SparseCheckoutRequest,
) -> AppResult<SparseCheckoutPreview> {
    preview_sparse_checkout(repo, request, &sparse_checkout_state(repo)?.fingerprint)
}

#[test]
fn linked_worktrees_keep_independent_sparse_settings() {
    let (directory, repo) = fixture();
    let linked = directory.path().join("linked");
    run_git_stdout(
        repo.workdir(),
        &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
    )
    .unwrap();
    let mut other = open_at(&linked).unwrap();
    apply(&mut other, &selection(true, &["src"]));
    assert!(sparse_checkout_state(&other).unwrap().enabled);
    assert!(!sparse_checkout_state(&repo).unwrap().enabled);
    assert!(repo.workdir().join("docs/readme.md").exists());
    assert!(!other.workdir().join("docs/readme.md").exists());
    apply(&mut other, &SparseCheckoutRequest::Disable);
    assert!(other.workdir().join("docs/readme.md").exists());
    assert!(!sparse_checkout_state(&repo).unwrap().enabled);
}

#[test]
fn directory_rules_round_trip_git_quoted_spaces_and_utf8_paths() {
    let (_directory, mut repo) = fixture();
    for path in ["feature space/entry.txt", "caf\u{e9}/entry.txt"] {
        let file = repo.workdir().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "Example content\n").unwrap();
    }
    run_git_stdout(repo.workdir(), &["add", "."]).unwrap();
    run_git_stdout(
        repo.workdir(),
        &[
            "-c",
            "user.name=Alice",
            "-c",
            "user.email=alice@example.com",
            "commit",
            "-m",
            "Add named folders",
        ],
    )
    .unwrap();
    let request = selection(true, &[r#""feature space""#, r#""caf\303\251""#]);
    let checked = review(&repo, &request);
    assert!(checked
        .selected_paths
        .contains(&"feature space/entry.txt".into()));
    assert!(checked
        .selected_paths
        .contains(&"caf\u{e9}/entry.txt".into()));
    let saved = apply(&mut repo, &request);
    let reloaded = SparseCheckoutRequest::Set {
        cone: true,
        sparse_index: false,
        rules: saved.update.state.rules,
    };
    apply(&mut repo, &reloaded);
    assert!(repo.workdir().join("feature space/entry.txt").exists());
    assert!(repo.workdir().join("caf\u{e9}/entry.txt").exists());
    assert!(!repo.workdir().join("src/main.rs").exists());
}
