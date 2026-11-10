use std::collections::{BTreeSet, HashMap};

use super::*;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileKind {
    #[default]
    Regular,
    Submodule,
    Lfs,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub kind: GitFileKind,
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Excluded according to Git, including its tracked-path semantics.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub binary: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    pub start: u32,
    pub count: u32,
    pub commit_id: String,
    pub author: String,
    pub time: i64,
}

pub fn list_directory(repo: &Repository, path: &str) -> AppResult<Vec<DirEntry>> {
    let rel = safe_repo_path(path)?;
    let dir = ensure_inside_workdir(repo, &rel)?;
    let mut pending = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|_| AppError::msg("Folder not found"))? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let kind = item.file_type()?;
        let dir = kind.is_dir();
        if !dir && !kind.is_file() {
            continue;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        // A trailing slash lets directory-only patterns such as `out/` match.
        // `git check-ignore` also keeps a tracked path visible and refuses to
        // re-include anything inside an excluded directory.
        let query = if dir {
            format!("{path}/")
        } else {
            path.clone()
        };
        pending.push((name, path, dir, query));
    }
    let queries: Vec<String> = pending.iter().map(|item| item.3.clone()).collect();
    let ignored = ignored_queries(repo, &queries).unwrap_or_default();
    let mut entries = Vec::new();
    for (name, path, dir, query) in pending {
        entries.push(DirEntry {
            kind: GitFileKind::Regular,
            ignored: ignored.contains(&query),
            name,
            path,
            dir,
        });
    }
    let paths = entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.dir))
        .collect::<Vec<_>>();
    let kinds = file_kinds(repo, &paths).unwrap_or_default();
    for entry in &mut entries {
        entry.kind = kinds.get(&entry.path).copied().unwrap_or_default();
    }
    // Folding a filename in every comparison allocates O(n log n) strings for
    // large directories. Keep the same ordering with one key per entry.
    entries.sort_by_cached_key(|entry| (!entry.dir, entry.name.to_lowercase()));
    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    pub kind: GitFileKind,
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearch {
    pub hits: Vec<FileSearchHit>,
    pub truncated: bool,
}

pub fn search_files(repo: &Repository, query: &str) -> AppResult<FileSearch> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(FileSearch {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let root = workdir(repo)?;
    let bytes = run_git_stdout(root, &["ls-files", "-co", "--exclude-standard", "-z"])?;
    let paths = bytes
        .split(|byte| *byte == 0)
        .filter(|raw| !raw.is_empty())
        .map(|raw| String::from_utf8_lossy(raw).replace('\\', "/"));
    let mut result = hits_from_paths(paths, &needle);
    let paths = result
        .hits
        .iter()
        .map(|hit| (hit.path.as_str(), hit.dir))
        .collect::<Vec<_>>();
    let kinds = file_kinds(repo, &paths).unwrap_or_default();
    for hit in &mut result.hits {
        hit.kind = kinds.get(&hit.path).copied().unwrap_or_default();
        if hit.kind == GitFileKind::Submodule {
            hit.dir = true;
        }
    }
    Ok(result)
}

fn file_kinds(
    repo: &Repository,
    paths: &[(&str, bool)],
) -> AppResult<HashMap<String, GitFileKind>> {
    let mut kinds = HashMap::new();
    if paths.is_empty() {
        return Ok(kinds);
    }
    let parents = paths
        .iter()
        .map(|(path, _)| path.rsplit_once('/').map_or("", |(parent, _)| parent))
        .collect::<BTreeSet<_>>();
    let patterns = parents
        .into_iter()
        .map(|parent| {
            let escaped = parent
                .chars()
                .flat_map(|ch| {
                    if matches!(ch, '\\' | '[' | ']' | '*' | '?') {
                        vec!['\\', ch]
                    } else {
                        vec![ch]
                    }
                })
                .collect::<String>();
            if parent.is_empty() {
                ":(top,glob)*".to_string()
            } else {
                format!(":(top,glob){escaped}/*")
            }
        })
        .collect::<Vec<_>>();
    // Glob pathspecs restrict output to the visible directory levels, rather than exporting the full index.
    for chunk in patterns.chunks(40) {
        let args = ["ls-files", "--stage", "-z", "--"]
            .into_iter()
            .chain(chunk.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let output = run_git_stdout(repo.workdir(), &args)?;
        for record in output.split(|byte| *byte == 0) {
            if !record.starts_with(b"160000 ") {
                continue;
            }
            if let Some(tab) = record.iter().position(|byte| *byte == b'\t') {
                kinds.insert(
                    String::from_utf8_lossy(&record[tab + 1..]).into_owned(),
                    GitFileKind::Submodule,
                );
            }
        }
    }
    let mut input = Vec::new();
    for (path, dir) in paths {
        if !dir && !kinds.contains_key(*path) {
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
    }
    if !input.is_empty() {
        let output = run_git_input(
            repo.workdir(),
            &["check-attr", "-z", "--stdin", "filter"],
            &input,
        )?;
        let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
        for record in fields.as_chunks::<3>().0 {
            if record[1] == b"filter" && record[2] == b"lfs" {
                kinds.insert(
                    String::from_utf8_lossy(record[0]).into_owned(),
                    GitFileKind::Lfs,
                );
            }
        }
    }
    Ok(kinds)
}

fn hits_from_paths(paths: impl Iterator<Item = String>, needle: &str) -> FileSearch {
    let mut files = Vec::new();
    let mut dirs = BTreeSet::new();
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        if name.to_lowercase().contains(needle) {
            files.push(FileSearchHit {
                kind: GitFileKind::Regular,
                path: path.clone(),
                dir: false,
            });
        }
        collect_matching_dirs(&path, needle, &mut dirs);
    }
    let mut hits = files;
    for dir in dirs {
        hits.push(FileSearchHit {
            kind: GitFileKind::Regular,
            path: dir,
            dir: true,
        });
    }
    FileSearch {
        hits,
        truncated: false,
    }
}

fn collect_matching_dirs(path: &str, needle: &str, dirs: &mut BTreeSet<String>) {
    let mut rest = path;
    while let Some((parent, _)) = rest.rsplit_once('/') {
        let name = parent.rsplit('/').next().unwrap_or(parent);
        if name.to_lowercase().contains(needle) {
            dirs.insert(parent.to_string());
        }
        rest = parent;
    }
}

pub fn read_file(repo: &Repository, path: &str) -> AppResult<FileText> {
    let full = work_file_path(repo, path)?;
    let too_large = fs::metadata(&full)
        .map_err(|_| AppError::msg("File not found"))?
        .len()
        > MAX_TEXT_BYTES;
    let (bytes, grew_too_large) = if too_large {
        (Vec::new(), false)
    } else {
        read_text_prefix(&full).map_err(|_| AppError::msg("File not found"))?
    };
    if too_large || grew_too_large || bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Ok(FileText {
            binary: true,
            text: String::new(),
        });
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    Ok(FileText {
        binary: false,
        text,
    })
}

pub fn file_blame(repo: &Repository, path: &str) -> AppResult<Vec<BlameHunk>> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    let root = workdir(repo)?;
    let stdout = match run_git_stdout(root, &["blame", "-w", "--porcelain", "--", &rel]) {
        Ok(stdout) => stdout,
        // A file that is not in HEAD has no history yet; every line shows as not committed.
        Err(_) if !in_head(repo, &rel) => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    Ok(parse_blame_porcelain(&stdout))
}

fn in_head(repo: &Repository, rel: &str) -> bool {
    object_exists(repo, &format!("HEAD:{rel}"))
}

pub(super) fn work_file_path(repo: &Repository, path: &str) -> AppResult<PathBuf> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    ensure_inside_workdir(repo, &rel)
}

/// Reads at most `MAX_TEXT_BYTES`; the flag reports whether the file was longer.
pub(super) fn read_text_prefix(path: &Path) -> AppResult<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > MAX_TEXT_BYTES;
    bytes.truncate(MAX_TEXT_BYTES as usize);
    Ok((bytes, truncated))
}

pub(super) fn parse_blame_porcelain(bytes: &[u8]) -> Vec<BlameHunk> {
    let text = String::from_utf8_lossy(bytes);
    let mut known: std::collections::HashMap<String, (String, i64)> =
        std::collections::HashMap::new();
    let mut hunks: Vec<BlameHunk> = Vec::new();
    let mut oid = String::new();
    let mut author = String::new();
    let mut time = 0_i64;
    let mut described = false;
    let mut line_no = 0_u32;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(header) = blame_header(line) {
            oid = header;
            described = false;
            author.clear();
            time = 0;
            continue;
        }
        if let Some(name) = line.strip_prefix("author ") {
            author = name.to_string();
            described = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("author-time ") {
            time = value.trim().parse().unwrap_or(0);
            continue;
        }
        if !line.starts_with('\t') {
            continue;
        }
        if oid.is_empty() || oid.chars().all(|ch| ch == '0') {
            line_no += 1;
            continue;
        }
        let (author, time) = if described {
            known.insert(oid.clone(), (author.clone(), time));
            (author.clone(), time)
        } else {
            known
                .get(&oid)
                .map(|(name, when)| (name.clone(), *when))
                .unwrap_or_else(|| (String::new(), 0))
        };
        if let Some(last) = hunks.last_mut() {
            if last.commit_id == oid && last.start + last.count == line_no {
                last.count += 1;
                line_no += 1;
                continue;
            }
        }
        hunks.push(BlameHunk {
            start: line_no,
            count: 1,
            commit_id: oid.clone(),
            author,
            time,
        });
        line_no += 1;
    }
    hunks
}

pub(super) fn blame_header(line: &str) -> Option<String> {
    let oid = line.get(..40)?;
    if !oid.chars().all(|ch| ch.is_ascii_hexdigit()) || !line[40..].starts_with(' ') {
        return None;
    }
    Some(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::hits_from_paths;

    #[test]
    fn file_names_match_without_case_and_folder_names_stay_folders() {
        let page = hits_from_paths(
            [
                "src/components/Button.tsx",
                "src/lib/button.ts",
                "readme.md",
            ]
            .into_iter()
            .map(str::to_string),
            "button",
        );
        let files: Vec<_> = page
            .hits
            .iter()
            .filter(|hit| !hit.dir)
            .map(|hit| hit.path.as_str())
            .collect();
        assert_eq!(
            files,
            vec!["src/components/Button.tsx", "src/lib/button.ts"]
        );
        assert!(page.hits.iter().all(|hit| !hit.dir));
        assert!(!page.truncated);
    }

    #[test]
    fn a_folder_name_is_a_directory_hit_and_not_every_file_inside_it() {
        let page = hits_from_paths(
            ["components/button.tsx", "components/icon.tsx"]
                .into_iter()
                .map(str::to_string),
            "components",
        );
        assert_eq!(page.hits.len(), 1);
        assert!(page.hits[0].dir);
        assert_eq!(page.hits[0].path, "components");
    }
}
