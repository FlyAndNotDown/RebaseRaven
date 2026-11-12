mod askpass;
mod avatars;
mod diagnostics;
mod editor;
mod error;
mod file_tools;
mod fsutil;
mod git;
mod locate;
mod network;
mod p4;
mod platform;
mod prefs;
mod recents;
mod session;
mod sshkeys;
mod terminal;
mod updater;
mod watch;
mod window_state;

use std::path::Path;
use std::sync::Once;

use serde::Serialize;
#[cfg(not(windows))]
use tauri::image::Image;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(not(windows))]
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

use error::{AppError, AppResult};
use git::{
    BlameHunk, BranchList, CommitDetails, CommitFile, CommitSummary, DirEntry, FileDiff, FileText,
    GitIdentity, RebaseCommit, RebaseStep, RemoteProbe, StashDetails, WorkspaceSnapshot,
};
use prefs::AppPrefs;
use recents::RecentRepo;
use session::AppSession;
use terminal::TerminalOption;
use watch::WatchState;

fn with_repo<T>(path: &str, f: impl FnOnce(&mut git::Repository) -> AppResult<T>) -> AppResult<T> {
    let path = git::strip_verbatim_prefix(path);
    let mut repo = git::open_at(Path::new(&path))?;
    f(&mut repo)
}

/// Synchronous commands run on the main thread, so anything that touches the
/// disk or spawns processes goes through here instead.
async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|err| AppError::msg(err.to_string()))?
}

async fn with_repo_async<T, F>(path: String, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut git::Repository) -> AppResult<T> + Send + 'static,
{
    let started = std::time::Instant::now();
    let result = blocking(move || with_repo(&path, f)).await;
    diagnostics::record_slow_or_failed(diagnostics::Code::GitOperation, started, &result);
    result
}

async fn with_repo_diagnostic<T, F>(path: String, code: diagnostics::Code, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut git::Repository) -> AppResult<T> + Send + 'static,
{
    let started = std::time::Instant::now();
    diagnostics::record(code, diagnostics::Status::Started, None);
    let result = blocking(move || with_repo(&path, f)).await;
    diagnostics::record(
        code,
        diagnostics::Status::of(&result),
        Some(started.elapsed()),
    );
    result
}

#[tauri::command]
async fn initialize_repository(path: String, branch: String) -> AppResult<String> {
    blocking(move || git::initialize_repository(&path, &branch)).await
}

#[tauri::command]
async fn list_recents(app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    blocking(move || recents::load_recents(&app)).await
}

#[tauri::command]
async fn forget_recent(path: String, app: AppHandle) -> AppResult<Vec<RecentRepo>> {
    blocking(move || recents::forget_repo(&app, &path)).await
}

#[tauri::command]
async fn load_session(app: AppHandle) -> AppResult<AppSession> {
    blocking(move || session::load_session(&app)).await
}

#[tauri::command]
async fn get_diagnostic_summary(app: AppHandle) -> AppResult<diagnostics::Summary> {
    blocking(move || diagnostics::summary(&app)).await
}

#[tauri::command]
async fn clear_diagnostic_logs(app: AppHandle) -> AppResult<()> {
    blocking(move || diagnostics::clear(&app)).await
}

#[tauri::command]
async fn export_diagnostic_logs(
    destination: String,
    app: AppHandle,
) -> AppResult<diagnostics::ExportResult> {
    blocking(move || diagnostics::export(&app, Path::new(&destination))).await
}

#[tauri::command]
async fn open_diagnostic_directory(app: AppHandle) -> AppResult<()> {
    blocking(move || diagnostics::open_directory(&app)).await
}

#[tauri::command]
async fn open_diagnostic_issues() -> AppResult<()> {
    blocking(diagnostics::open_issues).await
}

#[tauri::command]
async fn get_author_avatar(
    email: String,
    provider: prefs::AvatarProvider,
    repo_path: String,
    app: AppHandle,
) -> AppResult<Option<String>> {
    let (prefs, selected) = blocking(move || {
        let prefs = prefs::load_prefs(&app)?;
        let remotes = if prefs.git_avatar_provider == prefs::GitAvatarProvider::Auto {
            with_repo(&repo_path, |repo| git::list_remotes(repo))?
        } else {
            Vec::new()
        };
        let provider = avatars::provider_for_remotes(prefs.git_avatar_provider, &remotes);
        Ok((prefs, provider))
    })
    .await?;
    if selected != provider {
        return Ok(None);
    }
    Ok(avatars::lookup(prefs, selected, email).await)
}

// Kept synchronous so rapid saves land in the order they were sent.
#[tauri::command]
fn save_session(session: AppSession, app: AppHandle) -> AppResult<AppSession> {
    session::save_session(&app, session)
}

#[tauri::command]
async fn clone_repository(
    url: String,
    destination: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<String> {
    blocking(move || {
        git::with_cancel(activity_id.as_deref(), || {
            git::clone_repository(
                &url,
                &destination,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
fn cancel_activity(id: String) -> bool {
    git::cancel_activity(&id)
}

#[tauri::command]
fn answer_askpass(id: u64, answer: Option<String>) -> AppResult<()> {
    askpass::answer(id, answer)
}

/// Runs the askpass helper mode when git or ssh launched this executable for a
/// credential prompt.
pub fn askpass_client() -> Option<i32> {
    askpass::run_client()
}

#[tauri::command]
async fn open_repository(path: String, app: AppHandle) -> AppResult<WorkspaceSnapshot> {
    let started = std::time::Instant::now();
    diagnostics::record(
        diagnostics::Code::GitOpen,
        diagnostics::Status::Started,
        None,
    );
    let result = blocking(move || {
        let mut repo = git::discover(&path)?;
        let snapshot = git::snapshot(&mut repo)?;
        recents::remember_repo(&app, &snapshot.repo.path, &snapshot.repo.name, "git")?;
        Ok(snapshot)
    })
    .await;
    diagnostics::record(
        diagnostics::Code::GitOpen,
        diagnostics::Status::of(&result),
        Some(started.elapsed()),
    );
    result
}

#[tauri::command]
async fn refresh_workspace(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_diagnostic(repo_path, diagnostics::Code::GitSnapshot, git::snapshot).await
}

#[tauri::command]
async fn get_commits(
    repo_path: String,
    limit: Option<usize>,
    skip: Option<usize>,
    query: Option<String>,
    rev: Option<Vec<String>>,
) -> AppResult<Vec<CommitSummary>> {
    with_repo_diagnostic(repo_path, diagnostics::Code::GitHistory, move |repo| {
        git::commits(
            repo,
            limit.unwrap_or(80),
            skip.unwrap_or(0),
            query.as_deref(),
            rev.as_deref().unwrap_or(&[]),
        )
    })
    .await
}

#[tauri::command]
async fn get_branches(repo_path: String) -> AppResult<BranchList> {
    with_repo_diagnostic(repo_path, diagnostics::Code::GitMetadata, move |repo| {
        git::branches(repo, true)
    })
    .await
}

#[tauri::command]
async fn get_workdir_diff(
    repo_path: String,
    path: String,
    staged: bool,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::workdir_diff(repo, &path, staged, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn list_directory(repo_path: String, path: String) -> AppResult<Vec<DirEntry>> {
    with_repo_async(repo_path, move |repo| git::list_directory(repo, &path)).await
}

#[tauri::command]
async fn search_files(repo_path: String, query: String) -> AppResult<git::FileSearch> {
    with_repo_async(repo_path, move |repo| git::search_files(repo, &query)).await
}

#[tauri::command]
async fn read_file(repo_path: String, path: String) -> AppResult<FileText> {
    with_repo_async(repo_path, move |repo| git::read_file(repo, &path)).await
}

#[tauri::command]
async fn file_blame(repo_path: String, path: String) -> AppResult<Vec<BlameHunk>> {
    with_repo_async(repo_path, move |repo| git::file_blame(repo, &path)).await
}

#[tauri::command]
async fn file_commits(
    repo_path: String,
    path: String,
    limit: usize,
    skip: usize,
) -> AppResult<Vec<CommitSummary>> {
    with_repo_async(repo_path, move |repo| {
        git::file_commits(repo, &path, limit, skip)
    })
    .await
}

#[tauri::command]
async fn get_commit_details(repo_path: String, oid: String) -> AppResult<CommitDetails> {
    with_repo_async(repo_path, move |repo| git::commit_details(repo, &oid)).await
}

#[tauri::command]
async fn get_commit_message(repo_path: String, oid: String) -> AppResult<String> {
    with_repo_async(repo_path, move |repo| git::commit_message(repo, &oid)).await
}

#[tauri::command]
async fn get_git_repository_settings(repo_path: String) -> AppResult<git::GitRepositorySettings> {
    with_repo_async(repo_path, |repo| git::repository_settings(repo)).await
}

#[tauri::command]
async fn set_git_repository_settings(
    repo_path: String,
    changes: Vec<git::GitRepositoryChange>,
    fingerprint: String,
) -> AppResult<git::GitRepositorySettings> {
    with_repo_async(repo_path, move |repo| {
        git::set_repository_settings(repo, &changes, &fingerprint)
    })
    .await
}

#[tauri::command]
async fn get_commit_diff(
    repo_path: String,
    oid: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::commit_file_diff(repo, &oid, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn get_image_pair(repo_path: String, source: git::FileSource) -> AppResult<git::ImagePair> {
    with_repo_async(repo_path, move |repo| git::image_pair(repo, &source)).await
}

#[tauri::command]
async fn compare_revisions(
    repo_path: String,
    base: String,
    head: String,
) -> AppResult<Vec<CommitFile>> {
    with_repo_async(repo_path, move |repo| {
        git::compare_files(repo, &base, &head)
    })
    .await
}

#[tauri::command]
async fn compare_file_diff(
    repo_path: String,
    base: String,
    head: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::compare_file_diff(repo, &base, &head, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn stage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn unstage_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::unstage_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn apply_lines(
    repo_path: String,
    path: String,
    staged: bool,
    action: String,
    lines: Vec<git::LineRef>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::apply_lines(repo, &path, staged, &action, &lines)
    })
    .await
}

#[tauri::command]
async fn discard_paths(repo_path: String, paths: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::discard_paths(repo, &paths)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn commit_changes(
    repo_path: String,
    message: String,
    amend: Option<bool>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::commit(repo, &message, amend.unwrap_or(false))?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn list_submodules(repo_path: String) -> AppResult<Vec<git::SubmoduleInfo>> {
    with_repo_async(repo_path, |repo| git::list_submodules(repo)).await
}

#[tauri::command]
async fn submodule_catalog(repo_path: String) -> AppResult<git::SubmoduleCatalog> {
    with_repo_async(repo_path, |repo| git::submodule_catalog(repo)).await
}

#[tauri::command]
async fn submodule_settings(repo_path: String, path: String) -> AppResult<git::SubmoduleSettings> {
    with_repo_async(repo_path, move |repo| git::submodule_settings(repo, &path)).await
}

#[tauri::command]
async fn add_submodule(
    repo_path: String,
    request: git::SubmoduleAdd,
    fingerprint: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::add_submodule(
                repo,
                &request,
                &fingerprint,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn edit_submodule(
    repo_path: String,
    path: String,
    url: String,
    branch: Option<String>,
    fingerprint: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::edit_submodule(repo, &path, &url, branch.as_deref(), &fingerprint)
    })
    .await
}

#[tauri::command]
async fn sync_submodules(
    repo_path: String,
    paths: Vec<String>,
    recursive: bool,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::sync_submodules(repo, &paths, recursive)
    })
    .await
}

#[tauri::command]
async fn preview_submodule_removal(
    repo_path: String,
    path: String,
    kind: git::SubmoduleRemovalKind,
    force: bool,
) -> AppResult<git::SubmoduleRemovalPreview> {
    with_repo_async(repo_path, move |repo| {
        git::preview_submodule_removal(repo, &path, &kind, force)
    })
    .await
}

#[tauri::command]
async fn remove_submodule(
    repo_path: String,
    path: String,
    kind: git::SubmoduleRemovalKind,
    force: bool,
    fingerprint: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::remove_submodule(repo, &path, &kind, force, &fingerprint)
    })
    .await
}

#[tauri::command]
async fn update_submodules(
    repo_path: String,
    paths: Option<Vec<String>>,
    activity_id: Option<String>,
    options: Option<git::SubmoduleUpdateOptions>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            if options.is_some() {
                git::update_submodules_with_options(
                    repo,
                    paths.as_deref().unwrap_or(&[]),
                    options.as_ref(),
                    progress_sink(&app, activity_id.as_deref()),
                )
            } else {
                git::update_submodules(
                    repo,
                    paths.as_deref().unwrap_or(&[]),
                    progress_sink(&app, activity_id.as_deref()),
                )
            }
        })
    })
    .await
}

#[tauri::command]
async fn list_worktrees(repo_path: String) -> AppResult<Vec<git::WorktreeInfo>> {
    with_repo_async(repo_path, |repo| git::list_worktrees(repo)).await
}

#[tauri::command]
async fn preview_worktree_change(
    repo_path: String,
    request: git::WorktreeRequest,
) -> AppResult<git::WorktreePreview> {
    with_repo_async(repo_path, move |repo| {
        git::preview_worktree_change(repo, &request)
    })
    .await
}

#[tauri::command]
async fn change_worktree(
    app: AppHandle,
    repo_path: String,
    request: git::WorktreeRequest,
    fingerprint: String,
) -> AppResult<git::WorktreeChange> {
    let result = with_repo_async(repo_path, move |repo| {
        git::change_worktree(repo, &request, &fingerprint)
    })
    .await?;
    if let (Some(previous), Some(path)) = (&result.previous_path, &result.path) {
        if let Err(error) = recents::relocate_repo(&app, previous, path) {
            log::warn!("Could not update recent repositories after relocating a worktree: {error}");
        }
    }
    Ok(result)
}

#[tauri::command]
async fn add_worktree(
    repo_path: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<String>,
    start: Option<String>,
) -> AppResult<String> {
    with_repo_async(repo_path, move |repo| {
        git::add_worktree(
            repo,
            &path,
            branch.as_deref(),
            new_branch.as_deref(),
            start.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn remove_worktree(repo_path: String, path: String, force: Option<bool>) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| {
        git::remove_worktree(repo, &path, force.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn prune_worktrees(repo_path: String) -> AppResult<()> {
    with_repo_async(repo_path, |repo| git::prune_worktrees(repo)).await
}

#[tauri::command]
async fn head_reflog(repo_path: String, limit: Option<usize>) -> AppResult<Vec<git::ReflogEntry>> {
    with_repo_async(repo_path, move |repo| {
        git::head_reflog(repo, limit.unwrap_or(200))
    })
    .await
}

#[tauri::command]
async fn undo_last_commit(repo_path: String) -> AppResult<git::UndoneCommit> {
    with_repo_async(repo_path, git::undo_last_commit).await
}

#[tauri::command]
async fn checkout_detached(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::checkout_detached(repo, &oid)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn checkout_branch(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::checkout_branch(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn fetch_remote(
    repo_path: String,
    activity_id: Option<String>,
    remote: Option<String>,
    all: Option<bool>,
    prune: Option<bool>,
    background: Option<bool>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_background(background.unwrap_or(false), || {
            git::with_cancel(activity_id.as_deref(), || {
                git::fetch_remote(
                    repo,
                    remote.as_deref(),
                    all.unwrap_or(false),
                    prune.unwrap_or(false),
                    progress_sink(&app, activity_id.as_deref()),
                )
            })
        })
    })
    .await
}

#[tauri::command]
async fn pull_remote(
    repo_path: String,
    remote: Option<String>,
    rebase: Option<bool>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let rebase = rebase.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::pull_remote(
                repo,
                remote.as_deref(),
                rebase,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn push_remote(
    repo_path: String,
    remote: Option<String>,
    force: Option<bool>,
    set_upstream: Option<bool>,
    expected_branch: Option<String>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let force = force.unwrap_or(false);
    let set_upstream = set_upstream.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::push_remote(
                repo,
                remote.as_deref(),
                force,
                set_upstream,
                expected_branch.as_deref(),
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[derive(Clone, Serialize)]
struct GitProgressEvent {
    id: String,
    line: String,
}

fn progress_sink(app: &AppHandle, activity_id: Option<&str>) -> impl FnMut(&str) + Send + 'static {
    let app = app.clone();
    let activity_id = activity_id.map(str::to_string);
    move |line: &str| {
        let Some(id) = activity_id.clone() else {
            return;
        };
        let _ = app.emit(
            "git-progress",
            GitProgressEvent {
                id,
                line: line.to_string(),
            },
        );
    }
}

#[tauri::command]
async fn create_tag(
    repo_path: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::create_tag(repo, &name, message.as_deref(), target.as_deref())?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_tag(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::delete_tag(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn push_tag(
    repo_path: String,
    remote: String,
    name: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::push_tag(
                repo,
                &remote,
                &name,
                progress_sink(&app, activity_id.as_deref()),
            )
        })?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_remote_tag(
    repo_path: String,
    remote: String,
    name: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::delete_remote_tag(
                repo,
                &remote,
                &name,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn create_branch(
    repo_path: String,
    name: String,
    switch: bool,
    start: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::create_branch(repo, &name, switch, start.as_deref())?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn rename_branch(
    repo_path: String,
    name: String,
    new_name: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::rename_branch(repo, &name, &new_name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn set_branch_upstream(
    repo_path: String,
    name: String,
    upstream: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::set_branch_upstream(repo, &name, upstream.as_deref())?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_branch(
    repo_path: String,
    name: String,
    force: Option<bool>,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<WorkspaceSnapshot> {
    let force = force.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::delete_branch(
                repo,
                &name,
                force,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn revert_commit(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::revert_commit(repo, &oid)).await
}

#[tauri::command]
async fn cherry_pick_commit(repo_path: String, oid: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::cherry_pick_commit(repo, &oid)).await
}

#[tauri::command]
async fn rebase_plan(repo_path: String, onto: String) -> AppResult<Vec<RebaseCommit>> {
    with_repo_async(repo_path, move |repo| git::rebase_plan(repo, &onto)).await
}

#[tauri::command]
async fn rebase_onto(repo_path: String, onto: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::rebase_onto(repo, &onto)).await
}

#[tauri::command]
async fn rebase_interactive(
    repo_path: String,
    onto: String,
    steps: Vec<RebaseStep>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::rebase_interactive(repo, &onto, &steps)
    })
    .await
}

#[tauri::command]
async fn rebase_continue(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_continue).await
}

#[tauri::command]
async fn rebase_skip(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_skip).await
}

#[tauri::command]
async fn rebase_abort(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::rebase_abort).await
}

#[tauri::command]
async fn merge_ref(repo_path: String, onto: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::merge_ref(repo, &onto)).await
}

#[tauri::command]
async fn operation_continue(
    repo_path: String,
    message: Option<String>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::operation_continue(repo, message.as_deref())
    })
    .await
}

#[tauri::command]
async fn operation_abort(repo_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, git::operation_abort).await
}

#[tauri::command]
async fn sparse_checkout_state(repo_path: String) -> AppResult<git::SparseCheckoutState> {
    with_repo_async(repo_path, move |repo| git::sparse_checkout_state(repo)).await
}

#[tauri::command]
async fn git_lfs_state(repo_path: String) -> AppResult<git::LfsState> {
    with_repo_async(repo_path, move |repo| git::lfs_state(repo)).await
}

#[tauri::command]
async fn git_lfs_action(
    repo_path: String,
    action: git::LfsAction,
    fingerprint: String,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<git::LfsOutcome> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::lfs_action(
                repo,
                &action,
                &fingerprint,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn preview_sparse_checkout(
    repo_path: String,
    request: git::SparseCheckoutRequest,
    fingerprint: String,
) -> AppResult<git::SparseCheckoutPreview> {
    with_repo_async(repo_path, move |repo| {
        git::preview_sparse_checkout(repo, &request, &fingerprint)
    })
    .await
}

#[tauri::command]
async fn apply_sparse_checkout(
    repo_path: String,
    request: git::SparseCheckoutRequest,
    fingerprint: String,
    allow_ignored_removal: bool,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<git::SparseCheckoutOutcome> {
    with_repo_async(repo_path, move |repo| {
        git::with_cancel(activity_id.as_deref(), || {
            git::apply_sparse_checkout(
                repo,
                &request,
                &fingerprint,
                allow_ignored_removal,
                progress_sink(&app, activity_id.as_deref()),
            )
        })
    })
    .await
}

#[tauri::command]
async fn resolve_conflict(
    repo_path: String,
    path: String,
    side: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::resolve_conflict(repo, &path, &side)
    })
    .await
}

#[tauri::command]
async fn conflict_view(repo_path: String, path: String) -> AppResult<git::ConflictView> {
    with_repo_async(repo_path, move |repo| git::conflict_view(repo, &path)).await
}

#[tauri::command]
async fn save_conflict(
    repo_path: String,
    path: String,
    text: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::save_conflict(repo, &path, &text)
    })
    .await
}

#[tauri::command]
async fn reset_to_commit(
    repo_path: String,
    oid: String,
    mode: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::reset_to_commit(repo, &oid, &mode)
    })
    .await
}

#[tauri::command]
async fn write_commit_patch(repo_path: String, oid: String, dest: String) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| {
        git::write_commit_patch(repo, &oid, &dest)
    })
    .await
}

#[tauri::command]
async fn apply_patch(repo_path: String, patch_path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::apply_patch(repo, &patch_path)).await
}

#[tauri::command]
async fn add_remote(repo_path: String, name: String, url: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::add_remote(repo, &name, &url)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn probe_remote_url(repo_path: String, url: String) -> AppResult<RemoteProbe> {
    with_repo_async(repo_path, move |repo| git::probe_remote_url(repo, &url)).await
}

#[tauri::command]
async fn set_remote_url(
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::set_remote_url(repo, &name, &url)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn remote_push_settings(
    repo_path: String,
    name: String,
) -> AppResult<git::RemotePushSettings> {
    with_repo_async(repo_path, move |repo| {
        git::remote_push_settings(repo, &name)
    })
    .await
}

#[tauri::command]
async fn set_remote_push_urls(
    repo_path: String,
    name: String,
    urls: Vec<String>,
    fingerprint: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::set_remote_push_urls(repo, &name, &urls, &fingerprint)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn rename_remote(
    repo_path: String,
    name: String,
    new_name: String,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::rename_remote(repo, &name, &new_name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn delete_remote(repo_path: String, name: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::delete_remote(repo, &name)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_save(
    repo_path: String,
    message: String,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_save(
            repo,
            &message,
            include_untracked,
            paths.as_deref().unwrap_or(&[]),
        )?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_apply(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_apply(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_pop(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_pop(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn stash_drop(repo_path: String, id: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::stash_drop(repo, &id)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn get_stash_details(repo_path: String, oid: String) -> AppResult<StashDetails> {
    with_repo_async(repo_path, move |repo| git::stash_details(repo, &oid)).await
}

#[tauri::command]
async fn get_stash_diff(
    repo_path: String,
    oid: String,
    path: String,
    ignore_whitespace: Option<bool>,
) -> AppResult<FileDiff> {
    let ignore_whitespace = ignore_whitespace.unwrap_or(false);
    with_repo_async(repo_path, move |repo| {
        git::stash_file_diff(repo, &oid, &path, ignore_whitespace)
    })
    .await
}

#[tauri::command]
async fn get_git_identity() -> AppResult<GitIdentity> {
    blocking(git::read_git_identity).await
}

#[tauri::command]
async fn set_git_identity(identity: GitIdentity) -> AppResult<GitIdentity> {
    blocking(move || {
        git::write_git_identity(&identity.name, &identity.email)?;
        git::read_git_identity()
    })
    .await
}

#[tauri::command]
async fn get_local_git_identity(repo_path: String) -> AppResult<GitIdentity> {
    with_repo_async(repo_path, |repo| git::read_local_git_identity(repo)).await
}

#[tauri::command]
async fn set_local_git_identity(
    repo_path: String,
    identity: GitIdentity,
) -> AppResult<GitIdentity> {
    with_repo_async(repo_path, move |repo| {
        git::write_local_git_identity(repo, &identity.name, &identity.email)?;
        git::read_local_git_identity(repo)
    })
    .await
}

#[tauri::command]
async fn open_in_file_manager(path: String) -> AppResult<()> {
    blocking(move || git::open_in_file_manager(&path)).await
}

#[tauri::command]
async fn open_mailto(email: String) -> AppResult<()> {
    blocking(move || editor::open_mailto(&email)).await
}

#[tauri::command]
async fn open_external_url(url: String) -> AppResult<()> {
    blocking(move || platform::open_url(&url)).await
}

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> AppResult<()> {
    blocking(move || git::reveal_in_file_manager(&path)).await
}

#[tauri::command]
async fn ignore_patterns(repo_path: String, patterns: Vec<String>) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| {
        git::ignore_patterns(repo, &patterns)?;
        git::snapshot(repo)
    })
    .await
}

#[tauri::command]
async fn list_terminals() -> AppResult<Vec<TerminalOption>> {
    blocking(|| Ok(terminal::list_terminals())).await
}

#[tauri::command]
async fn list_editors() -> AppResult<Vec<editor::EditorOption>> {
    blocking(|| Ok(editor::list_editors())).await
}

#[tauri::command]
async fn open_in_editor(path: String, line: Option<u32>, app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let prefs = prefs::load_prefs(&app)?;
        editor::open_in_editor(&path, line, &prefs.editor_id)
    })
    .await
}

#[tauri::command]
async fn open_git_file_in_editor(
    repo_path: String,
    source: git::FileSource,
    line: Option<u32>,
    app: AppHandle,
    files: State<'_, file_tools::ExternalFiles>,
) -> AppResult<()> {
    let files = files.inner().clone();
    with_repo_async(repo_path, move |repo| {
        let path = git::editor_file(repo, &source, &files)?;
        let prefs = prefs::load_prefs(&app)?;
        file_tools::open_editor(&path, line, &prefs.editor_id)
    })
    .await
}

#[tauri::command]
async fn diff_document_text(source: file_tools::DocumentSource) -> AppResult<file_tools::TextPair> {
    blocking(move || source.text()).await
}

#[tauri::command]
async fn open_diff_document(
    source: file_tools::DocumentSource,
    line: Option<u32>,
    external_diff: bool,
    app: AppHandle,
    files: State<'_, file_tools::ExternalFiles>,
) -> AppResult<()> {
    let files = files.inner().clone();
    blocking(move || {
        let pair = source.files(file_tools::FILE_LIMIT)?;
        let prefs = prefs::load_prefs(&app)?;
        if external_diff {
            file_tools::external_diff(pair, Some(&prefs.p4_diff_tool), move |message| {
                let _ = app.emit(
                    "tool-error",
                    ToolError {
                        message: error::redact_credentials(&message),
                    },
                );
            })
        } else {
            let path = files.editor(&pair)?;
            file_tools::open_editor(&path, line, &prefs.editor_id)
        }
    })
    .await
}

#[tauri::command]
async fn get_tool_config(repo_path: Option<String>) -> AppResult<git::ToolConfig> {
    blocking(move || match repo_path {
        Some(path) => with_repo(&path, |repo| Ok(git::read_tool_config(Some(repo)))),
        None => Ok(git::read_tool_config(None)),
    })
    .await
}

#[tauri::command]
async fn set_tool_config(config: git::ToolConfig) -> AppResult<git::ToolConfig> {
    blocking(move || git::write_tool_config(&config)).await
}

#[tauri::command]
async fn list_gui_tools() -> AppResult<Vec<git::GuiToolOption>> {
    blocking(|| Ok(git::list_gui_tools())).await
}

#[tauri::command]
async fn gui_tool_found(value: String) -> AppResult<bool> {
    blocking(move || Ok(git::gui_tool_found(&value))).await
}

#[derive(Clone, Serialize)]
struct ToolError {
    message: String,
}

#[tauri::command]
async fn open_difftool(
    repo_path: String,
    source: git::FileSource,
    app: AppHandle,
) -> AppResult<()> {
    with_repo_async(repo_path, move |repo| {
        git::launch_difftool(repo, &source, move |message| {
            let _ = app.emit(
                "tool-error",
                ToolError {
                    message: error::redact_credentials(&message),
                },
            );
        })
    })
    .await
}

#[tauri::command]
async fn run_mergetool(repo_path: String, path: String) -> AppResult<WorkspaceSnapshot> {
    with_repo_async(repo_path, move |repo| git::run_mergetool(repo, &path)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitExecutables {
    path_git: Option<String>,
    active: Option<String>,
}

#[tauri::command]
async fn git_executables() -> AppResult<GitExecutables> {
    blocking(|| {
        Ok(GitExecutables {
            path_git: git::git_on_path(),
            active: git::active_git(),
        })
    })
    .await
}

#[tauri::command]
async fn check_git_executable(path: String) -> AppResult<()> {
    blocking(move || git::check_git_executable(&path)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct P4Executables {
    path_p4: Option<String>,
    active: Option<String>,
}

#[tauri::command]
async fn detect_repository(path: String) -> AppResult<p4::RepoDetection> {
    blocking(move || p4::detect_repository(&path)).await
}

#[tauri::command]
async fn p4_open(path: String, app: AppHandle) -> AppResult<p4::P4Open> {
    blocking(move || {
        let opened = p4::open_workspace(&path)?;
        if let p4::P4Open::Ready { connection, .. } = &opened {
            let name = if connection.client.is_empty() {
                connection.root.clone()
            } else {
                connection.client.clone()
            };
            recents::remember_repo(&app, &connection.root, &name, "perforce")?;
        }
        Ok(opened)
    })
    .await
}

#[tauri::command]
async fn p4_refresh_pending(connection: p4::P4Connection) -> AppResult<Vec<p4::P4Changelist>> {
    blocking(move || p4::refresh_pending(&connection)).await
}

#[tauri::command]
async fn p4_submitted(
    connection: p4::P4Connection,
    user: Option<String>,
    client: Option<String>,
    limit: Option<usize>,
    before: Option<i64>,
) -> AppResult<p4::P4ChangePage> {
    blocking(move || {
        p4::submitted(
            &connection,
            user.as_deref().unwrap_or(""),
            client.as_deref().unwrap_or(""),
            limit.unwrap_or(50),
            before,
        )
    })
    .await
}

#[tauri::command]
async fn p4_list_users(connection: p4::P4Connection) -> AppResult<Vec<String>> {
    blocking(move || p4::list_users(&connection)).await
}

#[tauri::command]
async fn p4_list_clients(connection: p4::P4Connection, user: String) -> AppResult<Vec<String>> {
    blocking(move || p4::list_user_clients(&connection, &user)).await
}

#[tauri::command]
async fn p4_describe(connection: p4::P4Connection, change_id: String) -> AppResult<p4::P4Describe> {
    blocking(move || p4::describe(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_opened_diff(connection: p4::P4Connection, path: String) -> AppResult<git::FileDiff> {
    blocking(move || p4::opened_diff(&connection, &path)).await
}

#[tauri::command]
async fn p4_shelf_diff(
    connection: p4::P4Connection,
    depot_path: String,
    change_id: String,
) -> AppResult<git::FileDiff> {
    blocking(move || p4::shelf_diff(&connection, &depot_path, &change_id)).await
}

#[tauri::command]
async fn p4_revision_diff(
    connection: p4::P4Connection,
    depot_path: String,
    rev: String,
) -> AppResult<git::FileDiff> {
    blocking(move || p4::revision_diff(&connection, &depot_path, &rev)).await
}

#[tauri::command]
async fn p4_image_pair(
    connection: p4::P4Connection,
    source: p4::P4FileSource,
) -> AppResult<git::ImagePair> {
    blocking(move || p4::image_pair(&connection, &source)).await
}

#[tauri::command]
async fn p4_annotate(
    connection: p4::P4Connection,
    depot_path: String,
    revision: String,
) -> AppResult<Vec<p4::P4BlameLine>> {
    blocking(move || p4::annotate(&connection, &depot_path, &revision)).await
}

#[tauri::command]
async fn p4_compare_files(
    connection: p4::P4Connection,
    request: p4::P4CompareRequest,
) -> AppResult<p4::P4Comparison> {
    blocking(move || p4::compare_files(&connection, &request)).await
}

#[tauri::command]
async fn p4_path_history(
    connection: p4::P4Connection,
    path: String,
    request: p4::P4PathHistoryRequest,
) -> AppResult<p4::P4ChangePage> {
    blocking(move || p4::path_history(&connection, &path, &request)).await
}

#[tauri::command]
async fn p4_filelog(
    connection: p4::P4Connection,
    path: String,
    cursor: Option<p4::P4HistoryCursor>,
) -> AppResult<p4::P4RevisionPage> {
    blocking(move || p4::filelog(&connection, &path, cursor.as_ref())).await
}

#[tauri::command]
async fn p4_locate(connection: p4::P4Connection, path: String) -> AppResult<p4::P4Location> {
    blocking(move || p4::locate(&connection, &path)).await
}

#[tauri::command]
async fn p4_list_dir(
    connection: p4::P4Connection,
    relative: String,
) -> AppResult<Vec<p4::P4DirEntry>> {
    blocking(move || p4::list_dir(&connection, &relative)).await
}

#[tauri::command]
async fn p4_list_depot(
    connection: p4::P4Connection,
    path: String,
) -> AppResult<Vec<p4::P4DirEntry>> {
    blocking(move || p4::list_depot(&connection, &path)).await
}

#[tauri::command]
async fn p4_listing_status(
    connection: p4::P4Connection,
    directory: String,
    depot: bool,
) -> AppResult<Vec<p4::P4EntryStatus>> {
    blocking(move || p4::listing_status(&connection, &directory, depot)).await
}

#[tauri::command]
async fn p4_search_depot(
    connection: p4::P4Connection,
    query: String,
) -> AppResult<p4::P4FileSearch> {
    blocking(move || p4::search_depot(&connection, &query)).await
}

#[tauri::command]
async fn p4_cancel_depot_search(connection: p4::P4Connection) -> AppResult<()> {
    blocking(move || {
        p4::cancel_depot_search(&connection);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn p4_search_files(
    connection: p4::P4Connection,
    query: String,
) -> AppResult<p4::P4FileSearch> {
    blocking(move || p4::search_files(&connection, &query)).await
}

#[tauri::command]
async fn p4_search_submitted(
    connection: p4::P4Connection,
    user: Option<String>,
    client: Option<String>,
    query: String,
    before: Option<i64>,
    match_limit: Option<usize>,
    scan_limit: Option<usize>,
) -> AppResult<p4::P4ChangePage> {
    blocking(move || {
        p4::search_submitted(
            &connection,
            user.as_deref().unwrap_or(""),
            client.as_deref().unwrap_or(""),
            &query,
            before,
            match_limit.unwrap_or(40),
            scan_limit.unwrap_or(400),
        )
    })
    .await
}

#[tauri::command]
async fn p4_preview_integration(
    connection: p4::P4Connection,
    request: p4::P4IntegrationRequest,
) -> AppResult<p4::P4IntegrationPreview> {
    blocking(move || p4::preview_integration(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_integration(
    connection: p4::P4Connection,
    request: p4::P4IntegrationRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_integration(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_new_stream_spec(
    connection: p4::P4Connection,
    setup: p4::P4StreamSetup,
) -> AppResult<p4::P4StreamSpec> {
    blocking(move || p4::new_stream_spec(&connection, &setup)).await
}

#[tauri::command]
async fn p4_read_stream_spec(
    connection: p4::P4Connection,
    path: String,
) -> AppResult<p4::P4StreamSpec> {
    blocking(move || p4::read_stream_spec(&connection, &path)).await
}

#[tauri::command]
async fn p4_save_stream_spec(
    connection: p4::P4Connection,
    edit: p4::P4StreamSpecEdit,
    fingerprint: Option<String>,
) -> AppResult<p4::P4StreamSpec> {
    blocking(move || p4::save_stream_spec(&connection, &edit, fingerprint.as_deref())).await
}

#[tauri::command]
async fn p4_delete_stream_spec(
    connection: p4::P4Connection,
    path: String,
    fingerprint: String,
) -> AppResult<()> {
    blocking(move || p4::delete_stream_spec(&connection, &path, &fingerprint)).await
}

#[tauri::command]
async fn p4_stream_work(connection: p4::P4Connection) -> AppResult<p4::P4StreamWork> {
    blocking(move || p4::stream_work(&connection)).await
}

#[tauri::command]
async fn p4_preview_stream_work(
    connection: p4::P4Connection,
    request: p4::P4StreamWorkRequest,
) -> AppResult<p4::P4StreamWorkPreview> {
    blocking(move || p4::preview_stream_work(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_stream_work(
    connection: p4::P4Connection,
    request: p4::P4StreamWorkRequest,
    fingerprint: String,
) -> AppResult<p4::P4StreamWork> {
    blocking(move || p4::apply_stream_work(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_stream_change_diff(
    connection: p4::P4Connection,
    request: p4::P4StreamDiffRequest,
) -> AppResult<git::FileDiff> {
    blocking(move || p4::stream_change_diff(&connection, &request)).await
}

#[tauri::command]
async fn p4_list_specs(
    connection: p4::P4Connection,
    kind: p4::P4SpecKind,
    query: String,
    owner: String,
) -> AppResult<p4::P4SpecPage> {
    blocking(move || p4::list_specs(&connection, kind, &query, &owner)).await
}

#[tauri::command]
async fn p4_read_spec(
    connection: p4::P4Connection,
    kind: p4::P4SpecKind,
    name: String,
) -> AppResult<p4::P4Spec> {
    blocking(move || p4::read_spec(&connection, kind, &name)).await
}

#[tauri::command]
async fn p4_save_spec(
    connection: p4::P4Connection,
    edit: p4::P4SpecEdit,
    fingerprint: Option<String>,
) -> AppResult<p4::P4Spec> {
    blocking(move || p4::save_spec(&connection, &edit, fingerprint.as_deref())).await
}

#[tauri::command]
async fn p4_delete_spec(
    connection: p4::P4Connection,
    kind: p4::P4SpecKind,
    name: String,
    fingerprint: String,
) -> AppResult<()> {
    blocking(move || p4::delete_spec(&connection, kind, &name, &fingerprint)).await
}

#[tauri::command]
async fn p4_label_files(connection: p4::P4Connection, name: String) -> AppResult<p4::P4LabelFiles> {
    blocking(move || p4::label_files(&connection, &name)).await
}

#[tauri::command]
async fn p4_preview_label_tag(
    connection: p4::P4Connection,
    request: p4::P4LabelTagRequest,
) -> AppResult<p4::P4LabelTagPreview> {
    blocking(move || p4::preview_label_tag(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_label_tag(
    connection: p4::P4Connection,
    request: p4::P4LabelTagRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_label_tag(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_preview_switch(
    connection: p4::P4Connection,
    request: p4::P4SwitchRequest,
) -> AppResult<p4::P4SwitchPreview> {
    blocking(move || p4::preview_switch(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_switch(
    connection: p4::P4Connection,
    request: p4::P4SwitchRequest,
    fingerprint: String,
) -> AppResult<p4::P4SwitchOutcome> {
    blocking(move || p4::apply_switch(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_workspace_settings(connection: p4::P4Connection) -> AppResult<p4::P4WorkspaceSettings> {
    blocking(move || p4::workspace_settings(&connection)).await
}

#[tauri::command]
async fn p4_save_workspace(
    connection: p4::P4Connection,
    edit: p4::P4WorkspaceEdit,
    fingerprint: String,
) -> AppResult<p4::P4Connection> {
    blocking(move || p4::save_workspace(&connection, &edit, &fingerprint)).await
}

#[tauri::command]
async fn p4_submit(
    connection: p4::P4Connection,
    change_id: String,
    description: String,
) -> AppResult<()> {
    blocking(move || p4::submit(&connection, &change_id, &description)).await
}

#[tauri::command]
async fn p4_save_change(
    connection: p4::P4Connection,
    change_id: String,
    description: String,
) -> AppResult<String> {
    blocking(move || p4::save_change(&connection, &change_id, &description)).await
}

#[tauri::command]
async fn p4_new_change(connection: p4::P4Connection, description: String) -> AppResult<String> {
    blocking(move || p4::new_change(&connection, &description)).await
}

#[tauri::command]
async fn p4_delete_change(connection: p4::P4Connection, change_id: String) -> AppResult<()> {
    blocking(move || p4::delete_change(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_move_file(
    connection: p4::P4Connection,
    source: String,
    destination: String,
) -> AppResult<()> {
    blocking(move || p4::move_file(&connection, &source, &destination)).await
}

#[tauri::command]
async fn p4_reopen(
    connection: p4::P4Connection,
    change_id: String,
    files: Vec<String>,
) -> AppResult<()> {
    blocking(move || p4::reopen(&connection, &change_id, &files)).await
}

#[tauri::command]
async fn p4_revert(
    connection: p4::P4Connection,
    files: Vec<String>,
    wipe: Option<Vec<String>>,
) -> AppResult<()> {
    blocking(move || p4::revert(&connection, &files, wipe.as_deref().unwrap_or(&[]))).await
}

#[tauri::command]
async fn p4_revert_unchanged(
    connection: p4::P4Connection,
    change_id: Option<String>,
    paths: Vec<String>,
) -> AppResult<()> {
    blocking(move || p4::revert_unchanged(&connection, change_id.as_deref(), &paths)).await
}

#[tauri::command]
async fn p4_submit_shelf(
    connection: p4::P4Connection,
    change_id: String,
    description: String,
) -> AppResult<()> {
    blocking(move || p4::submit_shelf(&connection, &change_id, &description)).await
}

#[tauri::command]
async fn p4_shelve(
    connection: p4::P4Connection,
    change_id: String,
    files: Option<Vec<String>>,
) -> AppResult<()> {
    let files = files.unwrap_or_default();
    blocking(move || p4::shelve(&connection, &change_id, &files)).await
}

#[tauri::command]
async fn p4_unshelve(
    connection: p4::P4Connection,
    change_id: String,
    target: Option<String>,
    files: Option<Vec<String>>,
) -> AppResult<()> {
    let files = files.unwrap_or_default();
    blocking(move || p4::unshelve(&connection, &change_id, target.as_deref(), &files)).await
}

#[tauri::command]
async fn p4_delete_shelf(connection: p4::P4Connection, change_id: String) -> AppResult<()> {
    blocking(move || p4::delete_shelf(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_resolve_view(
    connection: p4::P4Connection,
    path: String,
) -> AppResult<p4::P4ResolveView> {
    blocking(move || p4::resolve_view(&connection, &path)).await
}

#[tauri::command]
async fn p4_resolve_accept(
    connection: p4::P4Connection,
    path: String,
    mode: String,
) -> AppResult<()> {
    blocking(move || {
        let started = std::time::Instant::now();
        let result = p4::resolve_accept(&connection, &path, &mode);
        diagnostics::record_slow_or_failed(diagnostics::Code::PerforceResolve, started, &result);
        result
    })
    .await
}

#[tauri::command]
async fn p4_manual_resolve_view(
    connection: p4::P4Connection,
    path: String,
) -> AppResult<p4::P4ManualResolve> {
    blocking(move || p4::manual_resolve_view(&connection, &path)).await
}

#[tauri::command]
async fn p4_manual_resolve_external(
    connection: p4::P4Connection,
    path: String,
    text: String,
    fingerprint: String,
    tool: String,
) -> AppResult<String> {
    blocking(move || p4::manual_resolve_external(&connection, &path, &text, &fingerprint, &tool))
        .await
}

#[tauri::command]
async fn p4_manual_resolve_apply(
    connection: p4::P4Connection,
    path: String,
    text: String,
    fingerprint: String,
) -> AppResult<()> {
    blocking(move || p4::manual_resolve_apply(&connection, &path, &text, &fingerprint)).await
}

#[tauri::command]
async fn p4_revision_targets(
    connection: p4::P4Connection,
    change_id: String,
) -> AppResult<Vec<String>> {
    blocking(move || p4::revision_targets(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_get_revision(
    connection: p4::P4Connection,
    request: p4::P4GetRevision,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<String> {
    blocking(move || {
        p4::get_revision(
            &connection,
            &request,
            progress_sink(&app, activity_id.as_deref()),
        )
    })
    .await
}

#[tauri::command]
async fn p4_sync(
    connection: p4::P4Connection,
    paths: Vec<String>,
    activity_id: Option<String>,
    auto_resolve: bool,
    app: AppHandle,
) -> AppResult<p4::P4SyncResult> {
    blocking(move || {
        p4::sync(
            &connection,
            &paths,
            auto_resolve,
            progress_sink(&app, activity_id.as_deref()),
        )
    })
    .await
}

#[tauri::command]
async fn p4_preview_reconcile(connection: p4::P4Connection) -> AppResult<p4::P4ReconcilePreview> {
    blocking(move || p4::preview_reconcile(&connection)).await
}

#[tauri::command]
async fn p4_preview_clean(
    connection: p4::P4Connection,
    request: p4::P4CleanRequest,
) -> AppResult<p4::P4CleanPreview> {
    blocking(move || p4::preview_clean(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_clean(
    connection: p4::P4Connection,
    request: p4::P4CleanRequest,
    paths: Vec<String>,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_clean(&connection, &request, &paths, &fingerprint)).await
}

#[tauri::command]
async fn p4_apply_reconcile(
    connection: p4::P4Connection,
    paths: Vec<String>,
    change_id: String,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_reconcile(&connection, &paths, &change_id, &fingerprint)).await
}

#[tauri::command]
async fn p4_list_shelves(
    connection: p4::P4Connection,
    user: String,
    client: String,
    before: Option<u64>,
) -> AppResult<p4::P4ChangePage> {
    blocking(move || p4::list_shelves(&connection, &user, &client, before)).await
}

#[tauri::command]
async fn p4_shelf_detail(
    connection: p4::P4Connection,
    change_id: String,
) -> AppResult<p4::P4Changelist> {
    blocking(move || p4::shelf_detail(&connection, &change_id)).await
}

#[tauri::command]
async fn p4_preview_unshelve(
    connection: p4::P4Connection,
    request: p4::P4UnshelveRequest,
) -> AppResult<p4::P4OperationPreview> {
    blocking(move || p4::preview_unshelve(&connection, &request)).await
}

#[tauri::command]
async fn p4_restore_shelf(
    connection: p4::P4Connection,
    request: p4::P4UnshelveRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::restore_shelf(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_preview_stream(
    connection: p4::P4Connection,
    request: p4::P4StreamRequest,
) -> AppResult<p4::P4StreamPreview> {
    blocking(move || p4::preview_stream(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_stream(
    connection: p4::P4Connection,
    request: p4::P4StreamRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_stream(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_preview_integrate(
    connection: p4::P4Connection,
    request: p4::P4IntegrateRequest,
) -> AppResult<p4::P4OperationPreview> {
    blocking(move || p4::preview_integrate(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_integrate(
    connection: p4::P4Connection,
    request: p4::P4IntegrateRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_integrate(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_preview_undo(
    connection: p4::P4Connection,
    request: p4::P4UndoRequest,
) -> AppResult<p4::P4OperationPreview> {
    blocking(move || p4::preview_undo(&connection, &request)).await
}

#[tauri::command]
async fn p4_apply_undo(
    connection: p4::P4Connection,
    request: p4::P4UndoRequest,
    fingerprint: String,
) -> AppResult<String> {
    blocking(move || p4::apply_undo(&connection, &request, &fingerprint)).await
}

#[tauri::command]
async fn p4_file_action(
    connection: p4::P4Connection,
    action: String,
    paths: Vec<String>,
    change_id: Option<String>,
) -> AppResult<()> {
    blocking(move || p4::file_action(&connection, &action, &paths, change_id.as_deref())).await
}

#[tauri::command]
async fn p4_login(connection: p4::P4Connection, password: String) -> AppResult<()> {
    blocking(move || p4::login(&connection, &password)).await
}

#[tauri::command]
async fn p4_check_connection(auth: p4::P4Auth) -> AppResult<p4::P4CheckedConnection> {
    blocking(move || p4::check_connection(&auth)).await
}

#[tauri::command]
async fn p4_list_streams(auth: p4::P4Auth) -> AppResult<Vec<p4::P4StreamOption>> {
    blocking(move || p4::list_streams(&auth)).await
}

#[tauri::command]
async fn p4_list_depot_dirs(auth: p4::P4Auth, path: String) -> AppResult<Vec<p4::P4DepotEntry>> {
    blocking(move || p4::list_depot_dirs(&auth, &path)).await
}

#[tauri::command]
async fn p4_prepare_client(auth: p4::P4Auth, client: String) -> AppResult<String> {
    blocking(move || p4::prepare_client(&auth, &client)).await
}

#[tauri::command]
async fn p4_create_workspace(
    request: p4::P4CreateRequest,
    activity_id: Option<String>,
    app: AppHandle,
) -> AppResult<p4::P4Connection> {
    blocking(move || p4::create_workspace(request, progress_sink(&app, activity_id.as_deref())))
        .await
}

#[tauri::command]
async fn p4_executables() -> AppResult<P4Executables> {
    blocking(|| {
        Ok(P4Executables {
            path_p4: p4::p4_on_path(),
            active: p4::active_p4(),
        })
    })
    .await
}

#[tauri::command]
async fn check_p4_executable(path: String) -> AppResult<()> {
    blocking(move || p4::check_p4_executable(&path)).await
}

#[tauri::command]
async fn list_ssh_keys() -> AppResult<sshkeys::SshKeyList> {
    blocking(sshkeys::list).await
}

#[tauri::command]
async fn preview_ssh_key(path: String) -> AppResult<sshkeys::SshKeyPreview> {
    blocking(move || sshkeys::preview(&path)).await
}

#[tauri::command]
async fn generate_ssh_key(
    name: String,
    algorithm: String,
    comment: String,
    passphrase: String,
) -> AppResult<sshkeys::SshKeyInfo> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    blocking(move || sshkeys::generate(&name, &algorithm, &comment, &passphrase)).await
}

#[tauri::command]
async fn import_ssh_key(path: String, passphrase: String) -> AppResult<sshkeys::SshKeyInfo> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    blocking(move || sshkeys::import(&path, &passphrase)).await
}

#[tauri::command]
async fn delete_ssh_key(name: String) -> AppResult<()> {
    blocking(move || sshkeys::delete(&name)).await
}

#[tauri::command]
async fn get_prefs(app: AppHandle) -> AppResult<AppPrefs> {
    blocking(move || prefs::load_prefs(&app)).await
}

// Kept synchronous so rapid saves land in the order they were sent.
#[tauri::command]
fn set_prefs(mut prefs: AppPrefs, app: AppHandle) -> AppResult<AppPrefs> {
    let extras = std::mem::take(&mut prefs.extra_git_paths);
    let (git_path, extra_git_paths) = git::prepare_git_prefs(&prefs.git_path, extras)?;
    prefs.git_path = git_path;
    prefs.extra_git_paths = extra_git_paths;
    let p4_extras = std::mem::take(&mut prefs.extra_p4_paths);
    let (p4_path, extra_p4_paths) = p4::prepare_p4_prefs(&prefs.p4_path, p4_extras)?;
    prefs.p4_path = p4_path;
    prefs.extra_p4_paths = extra_p4_paths;
    prefs.p4_port = clean_setting(&prefs.p4_port);
    prefs.p4_user = clean_setting(&prefs.p4_user);
    prefs.p4_charset = p4::normalize_charset(&prefs.p4_charset);
    let saved = prefs::save_prefs(&app, prefs)?;
    avatars::preferences_changed(&saved);
    git::set_git_executable(&saved.git_path);
    p4::set_p4_executable(&saved.p4_path);
    Ok(saved)
}

fn clean_setting(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| *ch != '\n' && *ch != '\r')
        .collect()
}

#[tauri::command]
async fn open_in_terminal(path: String, app: AppHandle) -> AppResult<()> {
    blocking(move || {
        let prefs = prefs::load_prefs(&app)?;
        terminal::open_in_terminal(&path, &prefs.terminal_id)
    })
    .await
}

#[tauri::command]
fn sync_watches(paths: Vec<String>, app: AppHandle, state: State<WatchState>) -> AppResult<()> {
    git::retain_log_streams(&paths);
    watch::sync_watches(&app, &state, paths)
}

#[tauri::command]
fn sync_window_chrome(theme: String, app: AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::msg("main window missing"))?;
    apply_window_chrome(&window, theme != "light");
    Ok(())
}

fn apply_window_chrome(window: &tauri::WebviewWindow, dark: bool) {
    let _ = window.set_theme(Some(if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }));
    #[cfg(windows)]
    apply_caption_color(window, dark);
}

#[cfg(windows)]
fn apply_caption_color(window: &tauri::WebviewWindow, dark: bool) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // COLORREF 0x00BBGGRR matching --background in index.css
    let caption: u32 = if dark { 0x00_17_17_17 } else { 0x00_FB_FB_FB };
    let text: u32 = if dark { 0x00_FF_FF_FF } else { 0x00_00_00_00 };
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    unsafe {
        let handle = hwnd.0;
        dwm_set_color(handle, DWMWA_CAPTION_COLOR, caption);
        dwm_set_color(handle, DWMWA_BORDER_COLOR, caption);
        dwm_set_color(handle, DWMWA_TEXT_COLOR, text);
    }
}

#[cfg(windows)]
unsafe fn dwm_set_color(hwnd: *mut std::ffi::c_void, attr: u32, color: u32) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            dw_attribute: u32,
            pv_attribute: *const std::ffi::c_void,
            cb_attribute: u32,
        ) -> i32;
    }
    unsafe {
        DwmSetWindowAttribute(hwnd, attr, (&color as *const u32).cast(), 4);
    }
}

#[cfg(target_os = "macos")]
fn macos_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    // Close Window is omitted. Command-W closes the repository tab.
    let app_menu = Submenu::with_items(
        app,
        "RebaseRaven",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

fn reveal_main_window(show: impl FnOnce()) {
    static ONCE: Once = Once::new();
    ONCE.call_once(show);
}

/// WebView2 opens its own find, print, and reload UI for Ctrl+F, Ctrl+P, F5,
/// and the other browser accelerators. Those never reach the page, so the
/// setting has to be turned off on the webview itself.
#[cfg(windows)]
fn silence_browser_shortcuts(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}

#[cfg(not(windows))]
fn silence_browser_shortcuts(_window: &tauri::WebviewWindow) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    platform::configure_main_webview(context.config_mut());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WatchState::default())
        .manage(file_tools::ExternalFiles::default())
        .manage(updater::UpdateManager::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu);
    builder
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished || payload.url().scheme() == "about" {
                return;
            }
            let window = webview.window();
            reveal_main_window(|| {
                diagnostics::record(
                    diagnostics::Code::UiReady,
                    diagnostics::Status::Success,
                    None,
                );
                let _ = window.show();
                let _ = window.set_focus();
                let _ = webview.set_focus();
            });
        })
        .setup(|app| {
            let _ = diagnostics::initialize(app.handle());
            if let Ok(prefs) = prefs::load_prefs(app.handle()) {
                git::set_git_executable(&prefs.git_path);
                p4::set_p4_executable(&prefs.p4_path);
            }
            askpass::start(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                apply_window_chrome(&window, true);
                #[cfg(not(windows))]
                if let Ok(icon) = Image::from_bytes(APP_ICON_PNG) {
                    let _ = window.set_icon(icon);
                }
                window_state::restore(&window, app.handle());
                window_state::watch(&window, app.handle());
                #[cfg(target_os = "macos")]
                platform::watch_main_titlebar(&window);
                silence_browser_shortcuts(&window);
                // The page normally reveals the window. This covers a load that never finishes.
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(12));
                    if let Some(window) = app_handle.get_webview_window("main") {
                        reveal_main_window(|| {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let webview: &tauri::Webview = window.as_ref();
                            let _ = webview.set_focus();
                        });
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_repository,
            get_author_avatar,
            get_diagnostic_summary,
            clear_diagnostic_logs,
            export_diagnostic_logs,
            open_diagnostic_directory,
            open_diagnostic_issues,
            updater::get_update_state,
            updater::check_for_update,
            updater::install_update,
            updater::restart_after_update,
            list_recents,
            forget_recent,
            load_session,
            save_session,
            clone_repository,
            cancel_activity,
            answer_askpass,
            open_repository,
            refresh_workspace,
            get_commits,
            get_branches,
            get_workdir_diff,
            get_commit_details,
            get_commit_message,
            get_git_repository_settings,
            set_git_repository_settings,
            list_directory,
            search_files,
            read_file,
            file_blame,
            file_commits,
            get_commit_diff,
            compare_revisions,
            compare_file_diff,
            get_image_pair,
            stage_paths,
            unstage_paths,
            discard_paths,
            apply_lines,
            commit_changes,
            checkout_branch,
            checkout_detached,
            head_reflog,
            undo_last_commit,
            list_submodules,
            submodule_catalog,
            submodule_settings,
            add_submodule,
            edit_submodule,
            sync_submodules,
            preview_submodule_removal,
            remove_submodule,
            update_submodules,
            list_worktrees,
            preview_worktree_change,
            change_worktree,
            add_worktree,
            remove_worktree,
            prune_worktrees,
            fetch_remote,
            pull_remote,
            push_remote,
            create_branch,
            rename_branch,
            set_branch_upstream,
            create_tag,
            delete_tag,
            push_tag,
            delete_remote_tag,
            delete_branch,
            revert_commit,
            cherry_pick_commit,
            rebase_plan,
            rebase_onto,
            rebase_interactive,
            rebase_continue,
            rebase_skip,
            rebase_abort,
            merge_ref,
            operation_continue,
            operation_abort,
            sparse_checkout_state,
            git_lfs_state,
            git_lfs_action,
            preview_sparse_checkout,
            apply_sparse_checkout,
            resolve_conflict,
            conflict_view,
            save_conflict,
            reset_to_commit,
            write_commit_patch,
            apply_patch,
            add_remote,
            probe_remote_url,
            set_remote_url,
            rename_remote,
            remote_push_settings,
            set_remote_push_urls,
            delete_remote,
            stash_save,
            stash_apply,
            stash_pop,
            stash_drop,
            get_stash_details,
            get_stash_diff,
            get_git_identity,
            set_git_identity,
            get_local_git_identity,
            set_local_git_identity,
            open_in_file_manager,
            open_mailto,
            open_external_url,
            reveal_in_file_manager,
            ignore_patterns,
            list_terminals,
            list_editors,
            open_in_editor,
            open_git_file_in_editor,
            open_diff_document,
            diff_document_text,
            get_tool_config,
            set_tool_config,
            list_gui_tools,
            gui_tool_found,
            open_difftool,
            run_mergetool,
            git_executables,
            check_git_executable,
            detect_repository,
            p4_open,
            p4_refresh_pending,
            p4_submitted,
            p4_list_users,
            p4_list_clients,
            p4_describe,
            p4_opened_diff,
            p4_shelf_diff,
            p4_revision_diff,
            p4_filelog,
            p4_path_history,
            p4_compare_files,
            p4_annotate,
            p4_image_pair,
            p4_locate,
            p4_list_dir,
            p4_list_depot,
            p4_listing_status,
            p4_search_depot,
            p4_cancel_depot_search,
            p4_search_files,
            p4_search_submitted,
            p4_save_workspace,
            p4_workspace_settings,
            p4_preview_integration,
            p4_apply_integration,
            p4_stream_work,
            p4_preview_stream_work,
            p4_apply_stream_work,
            p4_stream_change_diff,
            p4_list_specs,
            p4_new_stream_spec,
            p4_read_stream_spec,
            p4_save_stream_spec,
            p4_delete_stream_spec,
            p4_read_spec,
            p4_save_spec,
            p4_delete_spec,
            p4_label_files,
            p4_preview_label_tag,
            p4_apply_label_tag,
            p4_preview_switch,
            p4_apply_switch,
            p4_submit,
            p4_save_change,
            p4_new_change,
            p4_delete_change,
            p4_move_file,
            p4_reopen,
            p4_revert,
            p4_revert_unchanged,
            p4_submit_shelf,
            p4_shelve,
            p4_unshelve,
            p4_delete_shelf,
            p4_resolve_view,
            p4_manual_resolve_view,
            p4_manual_resolve_apply,
            p4_manual_resolve_external,
            p4_resolve_accept,
            p4_get_revision,
            p4_revision_targets,
            p4_sync,
            p4_preview_reconcile,
            p4_preview_clean,
            p4_apply_clean,
            p4_apply_reconcile,
            p4_file_action,
            p4_preview_integrate,
            p4_list_shelves,
            p4_shelf_detail,
            p4_preview_unshelve,
            p4_restore_shelf,
            p4_preview_stream,
            p4_apply_stream,
            p4_apply_integrate,
            p4_preview_undo,
            p4_apply_undo,
            p4_login,
            p4_check_connection,
            p4_list_streams,
            p4_list_depot_dirs,
            p4_prepare_client,
            p4_create_workspace,
            p4_executables,
            check_p4_executable,
            list_ssh_keys,
            preview_ssh_key,
            generate_ssh_key,
            import_ssh_key,
            delete_ssh_key,
            get_prefs,
            set_prefs,
            open_in_terminal,
            sync_watches,
            sync_window_chrome
        ])
        .build(context)
        .expect("error while building RebaseRaven")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<file_tools::ExternalFiles>().clear();
            }
        });
}
