use super::*;

/// Reads the complete message rather than reconstructing it from a folded subject.
pub fn commit_message(repo: &Repository, oid: &str) -> AppResult<String> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::msg("Choose one commit from history."));
    }
    let resolved = run_git_stdout(
        workdir(repo)?,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{oid}^{{commit}}"),
        ],
    )?;
    let resolved = String::from_utf8_lossy(&resolved);
    let text = run_git_stdout(
        workdir(repo)?,
        &[
            "-c",
            "i18n.logOutputEncoding=utf-8",
            "-c",
            "log.showSignature=false",
            "show",
            "--no-patch",
            "--no-notes",
            "--format=format:%B",
            resolved.trim(),
            "--",
        ],
    )?;
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::msg(
            "The commit message is too large to load into the editor.",
        ));
    }
    Ok(String::from_utf8_lossy(&text).into_owned())
}

pub(super) fn summarize_oid(repo: &Repository, oid: &str) -> AppResult<CommitSummary> {
    Ok(summary_from_info(&commit_info(repo, oid)?))
}

pub(super) fn summary_from_info(info: &CommitInfo) -> CommitSummary {
    CommitSummary {
        id: info.id.clone(),
        short_id: short_id(&info.id),
        summary: info.summary.clone(),
        body: info.body.clone(),
        author_name: info.author_name.clone(),
        author_email: info.author_email.clone(),
        timestamp: info.timestamp,
        parents: info.parents.clone(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    }
}

pub fn commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: Option<&str>,
    revs: &[String],
    preview: impl FnOnce(&[CommitSummary]),
) -> AppResult<Vec<CommitSummary>> {
    let refs = HistoryRefs::read(repo, revs);
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    if let Some(query) = query {
        return search_commits(repo, limit, skip, query, &refs, preview);
    }
    // Committer-date order, unlike author-date order, lets git stream from
    // the commit-graph instead of sorting all of history first.
    let args = git_history_args(&refs.selected, None);
    let tips = BranchTips::read(repo);
    // With all branch tips in the log, its existing child-before-parent walk
    // can carry both membership bits across pages without a second process.
    let in_log = refs.selected.is_empty()
        && tips.head.iter().chain(&tips.upstream).all(|tip| {
            refs.labels
                .get(tip)
                .is_some_and(|refs| refs.iter().any(|r| r.kind == "branch"))
        });
    let mut items = log_page(repo.workdir(), &args, skip, limit, in_log.then_some(&tips))?;
    apply_ref_labels(&mut items, &refs.labels);
    if !in_log {
        preview(&items);
        mark_on_current_branch(repo, &tips, &mut items)?;
    }
    Ok(items)
}

/// A history search split into filters git applies and free text matched here.
#[derive(Debug, Default, PartialEq)]
pub(super) struct SearchQuery {
    pub text: String,
    pub authors: Vec<String>,
    pub paths: Vec<String>,
    /// `-S`: commits that add or remove this text.
    pub content: Option<String>,
    /// `-G`: commits whose diff has a line matching this regex.
    pub regex: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

/// Splits on whitespace, keeping double-quoted runs together without the quotes.
fn search_tokens(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for char in query.chars() {
        match char {
            '"' => quoted = !quoted,
            char if char.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            char => current.push(char),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

pub(super) fn parse_search_query(query: &str) -> SearchQuery {
    let mut parsed = SearchQuery::default();
    let mut text = Vec::new();
    for token in search_tokens(query) {
        let Some((key, value)) = token.split_once(':') else {
            text.push(token);
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            text.push(token);
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "author" => parsed.authors.push(value),
            "path" | "file" if cfg!(windows) => parsed.paths.push(value.replace('\\', "/")),
            "path" | "file" => parsed.paths.push(value),
            "content" => parsed.content = Some(value),
            "regex" => parsed.regex = Some(value),
            "since" | "after" => parsed.since = Some(value),
            "until" | "before" => parsed.until = Some(value),
            _ => text.push(token),
        }
    }
    parsed.text = text.join(" ");
    parsed
}

fn git_history_args(revs: &[&str], query: Option<&SearchQuery>) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "log.showSignature=false".to_string(),
        "-c".to_string(),
        "i18n.logOutputEncoding=utf-8".to_string(),
        "log".to_string(),
        "--date-order".to_string(),
        "--no-notes".to_string(),
        "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P".to_string(),
    ];
    if let Some(query) = query {
        push_search_args(&mut args, query);
    }
    if revs.is_empty() {
        args.push("--branches".to_string());
        args.push("--remotes".to_string());
    } else {
        // A branch can also disappear between enumeration and this walk.
        args.push("--ignore-missing".to_string());
        args.extend(revs.iter().map(|rev| (*rev).to_string()));
    }
    // A branch and a path in the worktree can have the same name.
    args.push("--".to_string());
    if let Some(query) = query {
        args.extend(query.paths.iter().cloned());
    }
    args
}

fn push_search_args(args: &mut Vec<String>, query: &SearchQuery) {
    if !query.authors.is_empty() {
        args.extend([
            "--regexp-ignore-case".to_string(),
            "--fixed-strings".to_string(),
        ]);
        args.extend(
            query
                .authors
                .iter()
                .map(|author| format!("--author={author}")),
        );
    }
    if let Some(content) = &query.content {
        args.push(format!("-S{content}"));
    }
    if let Some(regex) = &query.regex {
        args.push(format!("-G{regex}"));
    }
    if let Some(since) = &query.since {
        args.push(format!("--since={since}"));
    }
    if let Some(until) = &query.until {
        args.push(format!("--until={until}"));
    }
}

fn search_commits(
    repo: &Repository,
    limit: usize,
    skip: usize,
    query: &str,
    refs: &HistoryRefs<'_>,
    preview: impl FnOnce(&[CommitSummary]),
) -> AppResult<Vec<CommitSummary>> {
    let parsed = parse_search_query(query);
    let needle = parsed.text.to_lowercase();
    let mut items = Vec::new();
    let mut skipped = 0usize;

    let args = git_history_args(&refs.selected, Some(&parsed));
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut child = spawn_git_stdout(repo.workdir(), &argv)?;
    let mut reader = BufReader::new(child.stdout.take().expect("piped Git output"));
    let mut record = Vec::new();
    while read_git_line(&mut reader, &mut record)? {
        let Some(commit) = parse_search_record(&record) else {
            continue;
        };
        if !commit_matches(&commit, &needle, &refs.labels) {
            continue;
        }
        if skipped < skip {
            skipped += 1;
            continue;
        }
        items.push(commit);
        if items.len() >= limit {
            break;
        }
    }
    if items.len() < limit {
        child.wait_checked("Could not search Git history")?;
    }
    drop(reader);
    drop(child);

    apply_ref_labels(&mut items, &refs.labels);
    preview(&items);
    mark_on_current_branch(repo, &BranchTips::read(repo), &mut items)?;
    Ok(items)
}

pub(super) fn parse_search_record(bytes: &[u8]) -> Option<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0');
    let id = normalize_oid(fields.next()?)?;
    let short_id = fields.next()?.trim().to_string();
    let summary = fields.next()?.to_string();
    let author_name = fields.next()?.trim().to_string();
    let author_email = fields.next()?.trim().to_string();
    let timestamp = fields.next()?.trim().parse().unwrap_or(0);
    let parents = fields.next().unwrap_or("");
    if short_id.is_empty() {
        return None;
    }
    Some(CommitSummary {
        id,
        short_id,
        summary,
        body: String::new(),
        author_name,
        author_email,
        timestamp,
        parents: parents
            .split_whitespace()
            .filter_map(normalize_oid)
            .collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    })
}

pub(super) fn normalize_oid(value: &str) -> Option<String> {
    let value = value.trim();
    let len = value.len();
    if (4..=40).contains(&len) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(value.to_string())
    } else {
        None
    }
}

pub(super) fn commit_matches(
    commit: &CommitSummary,
    needle: &str,
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    let hash = commit.id.to_lowercase();
    if hash.starts_with(needle) || commit.short_id.to_lowercase().starts_with(needle) {
        return true;
    }
    if commit.summary.to_lowercase().contains(needle)
        || commit.body.to_lowercase().contains(needle)
        || commit.author_name.to_lowercase().contains(needle)
        || commit.author_email.to_lowercase().contains(needle)
    {
        return true;
    }
    labels.get(&commit.id).is_some_and(|refs| {
        refs.iter()
            .any(|label| label.name.to_lowercase().contains(needle))
    })
}

pub(super) fn parse_log_row(bytes: &[u8]) -> Option<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0');
    Some(CommitSummary {
        id: fields.next()?.to_owned(),
        short_id: fields.next()?.to_owned(),
        summary: fields.next()?.to_owned(),
        body: String::new(),
        author_name: fields.next()?.to_owned(),
        author_email: fields.next()?.to_owned(),
        timestamp: fields.next()?.parse().unwrap_or(0),
        parents: fields
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        refs: Vec::new(),
        on_current_branch: true,
        on_tracking_branch: false,
        path: None,
    })
}

#[derive(Clone, PartialEq)]
pub(super) struct BranchTips {
    pub(super) head: Option<String>,
    pub(super) upstream: Option<String>,
}

impl BranchTips {
    fn read(repo: &Repository) -> Self {
        Self {
            head: head_oid(repo),
            upstream: rev_parse(repo, "@{upstream}"),
        }
    }

    pub(super) fn frontier(&self) -> HashMap<String, u8> {
        let mut frontier = HashMap::new();
        for (tip, mask) in [(&self.head, 1), (&self.upstream, 2)] {
            if let Some(id) = tip {
                *frontier.entry(id.clone()).or_default() |= mask;
            }
        }
        frontier
    }
}

pub(super) fn propagate_membership<'a>(
    frontier: &mut HashMap<String, u8>,
    id: &str,
    parents: impl Iterator<Item = &'a str>,
) -> u8 {
    let mask = frontier.remove(id).unwrap_or_default();
    if mask != 0 {
        for parent in parents {
            *frontier.entry(parent.to_owned()).or_default() |= mask;
        }
    }
    mask
}

fn mark_on_current_branch(
    repo: &Repository,
    tips: &BranchTips,
    commits: &mut [CommitSummary],
) -> AppResult<()> {
    // Children precede every parent, including across merges with skewed dates.
    // Walking the requested commits as additional tips lets us resolve negative
    // answers as soon as we encounter them, even on unrelated branches.
    for page in commits.chunks_mut(80) {
        let ids = page.iter().map(|c| c.id.as_str()).collect::<Vec<_>>();
        let membership = page_membership(repo, tips, &ids)?;
        for commit in page {
            let mask = membership.get(&commit.id).copied().unwrap_or_default();
            commit.on_current_branch = mask & 1 != 0;
            commit.on_tracking_branch = mask & 2 != 0;
        }
    }
    Ok(())
}

pub(super) fn page_membership(
    repo: &Repository,
    tips: &BranchTips,
    ids: &[&str],
) -> AppResult<HashMap<String, u8>> {
    let mut frontier = tips.frontier();
    let mut wanted = ids.iter().copied().collect::<HashSet<_>>();
    let mut result = HashMap::new();
    if wanted.is_empty() || frontier.is_empty() {
        return Ok(result);
    }
    let mut args = vec!["rev-list", "--topo-order", "--parents"];
    args.extend(tips.head.as_deref());
    args.extend(tips.upstream.as_deref());
    args.extend(wanted.iter().copied());
    let mut child = spawn_git_stdout(repo.workdir(), &args)?;
    let mut reader = BufReader::new(child.stdout.take().expect("piped Git output"));
    let mut line = Vec::new();
    while read_git_line(&mut reader, &mut line)? {
        let row = String::from_utf8_lossy(&line);
        let mut fields = row.split_ascii_whitespace();
        let Some(id) = fields.next() else { continue };
        let mask = propagate_membership(&mut frontier, id, fields);
        if wanted.remove(id) {
            result.insert(id.to_string(), mask);
            if wanted.is_empty() {
                break;
            }
        }
    }
    if !wanted.is_empty() {
        child.wait_checked("Could not read commit ancestry")?;
    }
    Ok(result)
}

pub(super) fn apply_ref_labels(
    commits: &mut [CommitSummary],
    labels: &HashMap<String, Vec<CommitRefLabel>>,
) {
    for commit in commits {
        if let Some(mut refs) = labels.get(&commit.id).cloned() {
            refs.sort_by(|left, right| {
                ref_kind_rank(&left.kind)
                    .cmp(&ref_kind_rank(&right.kind))
                    .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            });
            commit.refs = refs;
        }
    }
}

pub(super) fn ref_kind_rank(kind: &str) -> u8 {
    match kind {
        "head" => 0,
        "branch" => 1,
        "tag" => 2,
        _ => 3,
    }
}

struct HistoryRefs<'a> {
    labels: HashMap<String, Vec<CommitRefLabel>>,
    selected: Vec<&'a str>,
}

impl<'a> HistoryRefs<'a> {
    fn read(repo: &Repository, revs: &'a [String]) -> Self {
        let mut selected = revs
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && !value.starts_with('-'))
            .collect::<Vec<_>>();
        let requested: HashSet<_> = selected.iter().copied().collect();
        let mut available = HashSet::new();
        let mut labels: HashMap<String, Vec<CommitRefLabel>> = HashMap::new();
        let remote_names = configured_remote_names(repo);
        let listed = run_git_stdout(
            repo.workdir(),
            &[
                "for-each-ref",
                "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%00%(refname)",
                "refs/heads",
                "refs/tags",
                "refs/remotes",
            ],
        );
        if let Ok(stdout) = &listed {
            for line in String::from_utf8_lossy(stdout).lines() {
                let mut fields = line.split('\0');
                let (Some(oid), Some(refname)) = (fields.next(), fields.next()) else {
                    continue;
                };
                let (kind, name) = if let Some(name) = refname.strip_prefix("refs/heads/") {
                    ("branch", name)
                } else if let Some(name) = refname.strip_prefix("refs/tags/") {
                    ("tag", name)
                } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
                    if !is_remote_branch_name(name, &remote_names) {
                        continue;
                    }
                    ("branch", name)
                } else {
                    continue;
                };
                if name.is_empty() {
                    continue;
                }
                for alias in [
                    refname,
                    refname.strip_prefix("refs/").unwrap_or(refname),
                    name,
                ] {
                    if let Some(&requested) = requested.get(alias) {
                        available.insert(requested);
                    }
                }
                labels
                    .entry(oid.to_string())
                    .or_default()
                    .push(CommitRefLabel {
                        name: name.to_string(),
                        kind: kind.to_string(),
                    });
            }
        }

        if let Some(oid) = head_oid(repo) {
            labels.entry(oid).or_default().insert(
                0,
                CommitRefLabel {
                    name: "HEAD".to_string(),
                    kind: "head".to_string(),
                },
            );
            available.insert("HEAD");
        }
        // Sidebar scopes are branch or tag references. Ignore deleted refs left
        // in saved selections and return to all branches if none are left.
        if listed.is_ok() {
            selected.retain(|rev| available.contains(rev));
        }
        Self { labels, selected }
    }
}

pub fn file_commits(
    repo: &Repository,
    path: &str,
    limit: usize,
    skip: usize,
) -> AppResult<Vec<CommitSummary>> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    let root = workdir(repo)?;
    // `--follow` switches to the old name only when it prints the rename, so a
    // `--skip` past the rename would lose everything older. Read through instead.
    let count = format!("-n{}", skip + limit.max(1));
    let stdout = run_git_stdout(
        root,
        &[
            "--literal-pathspecs",
            "-c",
            "log.showSignature=false",
            "-c",
            "core.quotePath=off",
            "log",
            "--follow",
            "--name-status",
            "-z",
            "--format=%x1e%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P",
            &count,
            "HEAD",
            "--",
            &rel,
        ],
    )?;
    Ok(parse_follow_log(&stdout, &rel)
        .into_iter()
        .skip(skip)
        .collect())
}

/// Parses `git log --follow --name-status -z` records. Each commit carries the
/// file's name at that commit so its diff can be shown after a rename.
pub(super) fn parse_follow_log(bytes: &[u8], current: &str) -> Vec<CommitSummary> {
    let text = String::from_utf8_lossy(bytes);
    let mut items = Vec::new();
    let mut fallback = current.to_string();
    for record in text.split('\u{1e}') {
        let fields: Vec<&str> = record.split('\0').collect();
        if fields.len() < 7 {
            continue;
        }
        let Some(id) = normalize_oid(fields[0]) else {
            continue;
        };
        let status: Vec<&str> = fields[7..]
            .iter()
            .map(|field| field.trim_start_matches('\n'))
            .filter(|field| !field.is_empty())
            .collect();
        let path = match status.as_slice() {
            [kind, old, new, ..] if kind.starts_with('R') || kind.starts_with('C') => {
                let path = (*new).to_string();
                fallback = (*old).to_string();
                path
            }
            [_, path, ..] => {
                let path = (*path).to_string();
                fallback = path.clone();
                path
            }
            _ => fallback.clone(),
        };
        items.push(CommitSummary {
            id,
            short_id: fields[1].to_string(),
            summary: fields[2].to_string(),
            body: String::new(),
            author_name: fields[3].to_string(),
            author_email: fields[4].to_string(),
            timestamp: fields[5].trim().parse().unwrap_or(0),
            parents: fields[6]
                .split_whitespace()
                .filter_map(normalize_oid)
                .collect(),
            refs: Vec::new(),
            on_current_branch: true,
            on_tracking_branch: false,
            path: Some(path),
        });
    }
    items
}
