use std::hash::{Hash, Hasher};
use std::io::Write;

use super::*;

const CANDIDATE_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectRevision {
    pub id: String,
    pub short_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectState {
    pub active: bool,
    pub original: Option<String>,
    pub current: Option<BisectRevision>,
    pub bad: Option<BisectRevision>,
    pub good_term: String,
    pub bad_term: String,
    pub good_count: usize,
    pub skipped_count: usize,
    pub remaining_count: Option<usize>,
    pub truncated: bool,
    pub found: bool,
    pub first_bad: Option<BisectRevision>,
    pub ambiguous: bool,
    pub candidates: Vec<BisectRevision>,
    pub no_checkout: bool,
    pub first_parent: bool,
    pub fingerprint: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum BisectAction {
    Start {
        bad: String,
        good: Vec<String>,
        paths: Vec<String>,
        first_parent: bool,
    },
    Mark {
        verdict: BisectVerdict,
        revision: Option<String>,
    },
    Checkout {
        revision: String,
    },
    Reset,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BisectVerdict {
    Good,
    Bad,
    Skip,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectOutcome {
    pub snapshot: WorkspaceSnapshot,
    pub state: BisectState,
    pub report: String,
}

pub(super) fn bisect_active(repo: &Repository) -> bool {
    repo.path().join("BISECT_START").is_file()
}

fn resolve_revision(repo: &Repository, revision: &str) -> AppResult<String> {
    let revision = revision.trim();
    if revision.is_empty() || revision.len() > 8192 || revision.chars().any(char::is_control) {
        return Err(AppError::msg("Enter a valid commit revision"));
    }
    let commit = format!("{revision}^{{commit}}");
    let output = run_git(
        repo.workdir(),
        &["rev-parse", "--verify", "--end-of-options", &commit],
    )?;
    if !output.status.success() {
        return Err(git_output_error(output));
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !matches!(id.len(), 40 | 64) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::msg("Git did not return a commit object"));
    }
    Ok(id)
}

fn revision_info(repo: &Repository, id: &str) -> AppResult<BisectRevision> {
    let commit = commit_info(repo, id)?;
    Ok(BisectRevision {
        short_id: commit.id.chars().take(8).collect(),
        id: commit.id,
        summary: commit.summary,
    })
}

fn bisect_files(repo: &Repository) -> AppResult<Vec<(String, Vec<u8>)>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(repo.path())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("BISECT_") || !entry.file_type()?.is_file() {
            continue;
        }
        if entry.metadata()?.len() > 4_194_304 {
            return Err(AppError::msg("Bisect session data is too large to load"));
        }
        files.push((name, fs::read(entry.path())?));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn bisect_paths(bytes: &[u8]) -> AppResult<Vec<String>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::msg("Bisect paths use an unsupported encoding"))?;
    let mut paths = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = text.chars();
    // BISECT_NAMES uses Git's single-quote format. Decode literal arguments;
    // never evaluate the file as shell code or expand pathspecs ourselves.
    while let Some(character) = chars.next() {
        if quoted {
            if character == '\'' {
                quoted = false;
            } else {
                value.push(character);
            }
        } else {
            match character {
                '\'' => {
                    quoted = true;
                    started = true;
                }
                '\\' => {
                    value.push(
                        chars
                            .next()
                            .ok_or_else(|| AppError::msg("Invalid bisect path quoting"))?,
                    );
                    started = true;
                }
                c if c.is_ascii_whitespace() => {
                    if started {
                        paths.push(std::mem::take(&mut value));
                        started = false;
                    }
                }
                _ => return Err(AppError::msg("Invalid bisect path quoting")),
            }
        }
    }
    if quoted {
        return Err(AppError::msg("Invalid bisect path quoting"));
    }
    if started {
        paths.push(value);
    }
    if paths.first().is_some_and(|path| path == "--") {
        paths.remove(0);
    }
    Ok(paths)
}

pub fn bisect_state(repo: &Repository) -> AppResult<BisectState> {
    let files = bisect_files(repo)?;
    let file = |name: &str| {
        files
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    };
    let active = file("BISECT_START").is_some();
    let original =
        file("BISECT_START").map(|value| String::from_utf8_lossy(value).trim().to_string());
    let terms = file("BISECT_TERMS").map(|value| String::from_utf8_lossy(value));
    let mut terms = terms.as_deref().unwrap_or("bad\ngood").lines();
    let bad_term = terms.next().unwrap_or("bad").to_string();
    let good_term = terms.next().unwrap_or("good").to_string();
    let refs = run_git_stdout(
        repo.workdir(),
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/bisect/",
        ],
    )?;
    let refs_text = String::from_utf8_lossy(&refs);
    let refs: Vec<(&str, &str)> = refs_text
        .lines()
        .filter_map(|line| line.split_once(' '))
        .collect();
    let bad_ref = format!("refs/bisect/{bad_term}");
    let good_prefix = format!("refs/bisect/{good_term}-");
    let bad_id = refs
        .iter()
        .find(|(name, _)| *name == bad_ref)
        .map(|(_, id)| *id);
    let good_count = refs
        .iter()
        .filter(|(name, _)| name.starts_with(&good_prefix))
        .count();
    let skipped: HashSet<&str> = refs
        .iter()
        .filter(|(name, _)| name.starts_with("refs/bisect/skip-"))
        .map(|(_, id)| *id)
        .collect();
    let bisect_head = active.then(|| rev_parse(repo, "BISECT_HEAD")).flatten();
    let head = head_oid(repo);
    let current_id = if active {
        bisect_head.as_ref().or(head.as_ref())
    } else {
        head.as_ref()
    };
    let current = current_id.map(|id| revision_info(repo, id)).transpose()?;
    let mut candidates = Vec::new();
    let mut remaining_count = None;
    let mut truncated = false;
    let mut found = false;
    let mut ambiguous = false;
    if let (true, Ok(paths)) = (
        active && bad_id.is_some() && good_count > 0,
        bisect_paths(file("BISECT_NAMES").map(Vec::as_slice).unwrap_or_default()),
    ) {
        // Pass the stored pathspecs and traversal mode explicitly: visualize
        // with custom log arguments does not retain these session filters.
        let limit = format!("--max-count={}", CANDIDATE_LIMIT + 1);
        let mut args = vec![
            "-c",
            "log.showSignature=false",
            "log",
            "--bisect",
            "--format=%H",
            "--no-patch",
            "--no-notes",
            "--no-decorate",
            "--no-color",
            &limit,
        ];
        if file("BISECT_FIRST_PARENT").is_some() {
            args.push("--first-parent");
        }
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        let output = run_git_env(
            repo.workdir(),
            &args,
            &[("GIT_PAGER", "cat"), ("GIT_OPTIONAL_LOCKS", "0")],
        )?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let ids: Vec<&str> = text
                .lines()
                .filter(|id| {
                    matches!(id.len(), 40 | 64) && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .collect();
            truncated = ids.len() > CANDIDATE_LIMIT;
            remaining_count = Some(ids.len().min(CANDIDATE_LIMIT));
            let ancestors_ok = file("BISECT_ANCESTORS_OK").is_some();
            found = ancestors_ok
                && ids.len() == 1
                && ids.first().copied() == bad_id
                && !skipped.contains(ids[0]);
            ambiguous = ancestors_ok
                && !truncated
                && !found
                && !ids.is_empty()
                && ids
                    .iter()
                    .all(|id| Some(*id) == bad_id || skipped.contains(id));
            if ambiguous || found {
                candidates = ids
                    .iter()
                    .map(|id| revision_info(repo, id))
                    .collect::<AppResult<_>>()?;
            }
        }
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        repo.path(),
        &files,
        &refs,
        &head,
        symbolic_branch(repo),
        &bisect_head,
    )
        .hash(&mut hash);
    Ok(BisectState {
        active,
        original,
        current,
        bad: bad_id.map(|id| revision_info(repo, id)).transpose()?,
        good_term,
        bad_term,
        good_count,
        skipped_count: skipped.len(),
        remaining_count,
        truncated,
        found,
        first_bad: if found {
            candidates.first().cloned()
        } else {
            None
        },
        ambiguous,
        candidates,
        no_checkout: bisect_head.is_some(),
        first_parent: file("BISECT_FIRST_PARENT").is_some(),
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

pub fn bisect_action(
    repo: &mut Repository,
    action: &BisectAction,
    fingerprint: &str,
) -> AppResult<BisectOutcome> {
    let _lock = BisectLock::acquire(repo)?;
    let before = bisect_state(repo)?;
    if before.fingerprint != fingerprint {
        return Err(AppError::msg(
            "The bisect session or checked-out revision changed. Reload before continuing.",
        ));
    }
    super::operations::ensure_clean_for_replay(repo)?;
    if super::operations::git_operation(repo).is_some_and(|operation| operation.kind != "bisect") {
        return Err(AppError::msg(
            "Finish the current operation before changing the bisect session",
        ));
    }
    let mut args = vec!["bisect".to_string()];
    let mut retest = None;
    match action {
        BisectAction::Start {
            bad,
            good,
            paths,
            first_parent,
        } => {
            if before.active || super::operations::git_operation(repo).is_some() {
                return Err(AppError::msg(
                    "Finish the current operation before starting bisect",
                ));
            }
            if good.is_empty() || good.len() > 64 || paths.len() > 64 {
                return Err(AppError::msg(
                    "Choose one to 64 good revisions and at most 64 path filters",
                ));
            }
            let bad = resolve_revision(repo, bad)?;
            let good = good
                .iter()
                .map(|revision| resolve_revision(repo, revision))
                .collect::<AppResult<Vec<_>>>()?;
            if good.contains(&bad) {
                return Err(AppError::msg(
                    "Good and bad revisions must be different commits",
                ));
            }
            if paths.iter().any(|path| {
                path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control)
            }) {
                return Err(AppError::msg("Enter a valid path filter on each line"));
            }
            args.push("start".to_string());
            if *first_parent {
                args.push("--first-parent".to_string());
            }
            args.push(bad);
            args.extend(good);
            args.push("--".to_string());
            args.extend(paths.iter().cloned());
        }
        BisectAction::Mark { verdict, revision } => {
            if !before.active {
                return Err(AppError::msg("No bisect session is in progress"));
            }
            let term = match verdict {
                BisectVerdict::Good => &before.good_term,
                BisectVerdict::Bad => &before.bad_term,
                BisectVerdict::Skip => "skip",
            };
            if term.is_empty()
                || term.starts_with('-')
                || term.chars().any(|c| c.is_control() || c.is_whitespace())
            {
                return Err(AppError::msg("The bisect session has an invalid term"));
            }
            let revision = match revision {
                Some(revision) => resolve_revision(repo, revision)?,
                None => before
                    .current
                    .as_ref()
                    .ok_or_else(|| AppError::msg("No revision is available to classify"))?
                    .id
                    .clone(),
            };
            if !matches!(verdict, BisectVerdict::Skip) {
                retest = Some(revision.clone());
            }
            args.extend([term.to_string(), revision]);
        }
        BisectAction::Checkout { revision } => {
            if !before.active || before.no_checkout {
                return Err(AppError::msg(
                    "This bisect session does not check out revisions",
                ));
            }
            args = vec![
                "checkout".to_string(),
                "--detach".to_string(),
                resolve_revision(repo, revision)?,
                "--".to_string(),
            ];
        }
        BisectAction::Reset => {
            if !before.active {
                return Err(AppError::msg("No bisect session is in progress"));
            }
            args.push("reset".to_string());
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if bisect_state(repo)?.fingerprint != before.fingerprint {
        return Err(AppError::msg(
            "The bisect session changed. Reload before continuing.",
        ));
    }
    super::operations::ensure_clean_for_replay(repo)?;
    if let Some(revision) = retest {
        clear_skip(repo, &revision)?;
    }
    let output = run_git_env(
        repo.workdir(),
        &refs,
        &[("LC_ALL", "C"), ("LANGUAGE", "C"), ("GIT_PAGER", "cat")],
    )?;
    let state = bisect_state(repo)?;
    if !output.status.success() && !(output.status.code() == Some(2) && state.ambiguous) {
        return Err(git_output_error(output));
    }
    let report = [
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    ]
    .join("\n")
    .chars()
    .take(16384)
    .collect();
    Ok(BisectOutcome {
        snapshot: snapshot(repo)?,
        state,
        report,
    })
}

struct BisectLock(fs::File);

impl BisectLock {
    fn acquire(repo: &Repository) -> AppResult<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(repo.path().join("rebaseraven-bisect.lock"))?;
        file.try_lock()
            .map_err(|_| AppError::msg("Another bisect action is still running"))?;
        Ok(Self(file))
    }
}

impl Drop for BisectLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn clear_skip(repo: &Repository, revision: &str) -> AppResult<()> {
    let reference = format!("refs/bisect/skip-{revision}");
    let path = repo.path().join("BISECT_LOG");
    let before = fs::read(&path)?;
    let command = format!("git bisect skip {revision}");
    let after: Vec<u8> = before
        .split_inclusive(|byte| *byte == b'\n')
        .filter(|line| line.trim_ascii() != command.as_bytes())
        .flatten()
        .copied()
        .collect();
    // Git retains skip refs when a revision is later marked good/bad. Clear
    // that mark explicitly, and keep the replay log from restoring it.
    let mut pending = if after != before {
        let mut file = tempfile::NamedTempFile::new_in(repo.path())?;
        file.as_file()
            .set_permissions(fs::metadata(&path)?.permissions())?;
        file.write_all(&after)?;
        file.as_file().sync_all()?;
        Some(file)
    } else {
        None
    };
    if rev_parse(repo, &reference).as_deref() == Some(revision) {
        run_git_stdout(repo.workdir(), &["update-ref", "-d", &reference, revision])?;
    }
    if let Some(file) = pending.take() {
        if fs::read(&path)? != before {
            return Err(AppError::msg(
                "The bisect log changed. Reload before continuing.",
            ));
        }
        file.persist(path)
            .map_err(|error| AppError::msg(error.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_git_single_quotes_without_shell_evaluation() {
        assert_eq!(
            super::bisect_paths(b" '--' 'source code/' 'it'\\''s!' '$(touch nope)' '--name' ''\n")
                .unwrap(),
            vec!["source code/", "it's!", "$(touch nope)", "--name", ""]
        );
        assert!(super::bisect_paths(b"'unterminated").is_err());
        assert!(super::bisect_paths(b"$(touch nope)").is_err());
        assert!(super::bisect_paths(&[255]).is_err());
    }
}
