//! A Files view owns one native path listing across successive search terms.
//! Large listings spill to a private temporary file and release it on close.
use super::*;
use std::collections::VecDeque;
use std::io::{Seek, SeekFrom};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

const PAGE: usize = 200;
const MEMORY_BYTES: usize = 8 * 1024 * 1024;

pub struct FileSearchIndex {
    repo: Repository,
    listing: Mutex<Option<Listing>>,
    processes: ReadProcesses,
    generation: AtomicU32,
}

struct Listing {
    paths: BufReader<tempfile::SpooledTempFile>,
    built: Instant,
    generation: Option<u32>,
    directories: HashSet<String>,
    pending: VecDeque<FileSearchHit>,
}

impl FileSearchIndex {
    pub fn new(repo: Repository) -> Self {
        Self {
            repo,
            listing: Mutex::default(),
            processes: ReadProcesses::default(),
            generation: 0.into(),
        }
    }

    fn build(&self) -> AppResult<Listing> {
        let mut child = spawn_git_stdout(
            self.repo.workdir(),
            &[
                "ls-files",
                "-co",
                "--exclude-standard",
                "--deduplicate",
                "-z",
            ],
        )?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::msg("Could not read Git file names"))?;
        let child = self.processes.track(child)?;
        let mut spool = tempfile::spooled_tempfile(MEMORY_BYTES);
        std::io::copy(&mut stdout, &mut spool)?;
        self.processes.active()?;
        child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wait_checked("Could not read Git file names")?;
        spool.rewind()?;
        Ok(Listing {
            paths: BufReader::new(spool),
            built: Instant::now(),
            generation: None,
            directories: HashSet::new(),
            pending: VecDeque::new(),
        })
    }

    pub fn page(&self, query: &str, generation: u32) -> AppResult<FileSearch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(FileSearch {
                hits: Vec::new(),
                truncated: false,
            });
        }
        self.generation.fetch_max(generation, Ordering::AcqRel);
        let active = || {
            self.processes.active()?;
            if self.generation.load(Ordering::Acquire) != generation {
                Err(AppError::cancelled())
            } else {
                Ok(())
            }
        };
        let mut cached = self.listing.lock().unwrap_or_else(|e| e.into_inner());
        active()?;
        // Watcher changes close the resource. Also refresh on a new term after a
        // quiet interval for global excludes and worktrees with limited watches.
        if cached.as_ref().is_none_or(|list| {
            list.generation != Some(generation) && list.built.elapsed() > Duration::from_secs(30)
        }) {
            *cached = Some(self.build()?);
        }
        let list = cached.as_mut().expect("listing just built");
        if list.generation != Some(generation) {
            list.paths.seek(SeekFrom::Start(0))?;
            list.generation = Some(generation);
            list.pending.clear();
            list.directories.clear();
        }
        let mut record = Vec::new();
        while list.pending.len() <= PAGE {
            active()?;
            record.clear();
            if list.paths.read_until(0, &mut record)? == 0 {
                break;
            }
            if record.last() == Some(&0) {
                record.pop();
            }
            let path = String::from_utf8_lossy(&record);
            let mut entry = path.as_ref();
            loop {
                let (parent, name) = entry.rsplit_once('/').unwrap_or(("", entry));
                let dir = entry != path;
                if name.to_lowercase().contains(&needle)
                    && (!dir || list.directories.insert(entry.to_owned()))
                {
                    list.pending.push_back(FileSearchHit {
                        path: entry.to_owned(),
                        dir,
                        kind: GitFileKind::Regular,
                    });
                }
                if parent.is_empty() {
                    break;
                }
                entry = parent;
            }
        }
        let mut hits: Vec<_> = list.pending.drain(..PAGE.min(list.pending.len())).collect();
        let truncated = !list.pending.is_empty();
        drop(cached);
        active()?;
        let paths = hits
            .iter()
            .map(|hit| (hit.path.as_str(), hit.dir))
            .collect::<Vec<_>>();
        let kinds = files::file_kinds(&self.repo, &paths).unwrap_or_default();
        active()?;
        for hit in &mut hits {
            hit.kind = kinds.get(&hit.path).copied().unwrap_or_default();
            hit.dir |= hit.kind == GitFileKind::Submodule;
        }
        Ok(FileSearch { hits, truncated })
    }
}

impl tauri::Resource for FileSearchIndex {
    fn close(self: Arc<Self>) {
        self.processes.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_share_a_listing_and_changed_queries_restart_at_the_root() {
        let (root, repo) = super::super::tests::temp_repo();
        fs::create_dir(root.join("Components")).unwrap();
        for n in 0..=PAGE {
            fs::write(root.join(format!("Components/button-{n}")), []).unwrap();
        }
        fs::write(root.join(".gitignore"), "ignored*\n").unwrap();
        fs::write(root.join("ignored-button"), []).unwrap();
        let index = FileSearchIndex::new(repo);
        let first = index.page("BUTTON", 1).unwrap();
        assert!(first.truncated);
        assert_eq!(first.hits.len(), PAGE);
        let tail = index.page("BUTTON", 1).unwrap();
        assert_eq!(tail.hits.len(), 1);
        assert!(!tail.truncated);
        assert!(!first
            .hits
            .iter()
            .any(|hit| hit.path == tail.hits[0].path || hit.path.starts_with("ignored")));
        let folders = index.page("components", 2).unwrap();
        assert_eq!(folders.hits.len(), 1);
        assert!(folders.hits[0].dir);
        assert_eq!(folders.hits[0].path, "Components");
        assert!(index.page("BUTTON", 1).unwrap_err().is_cancelled());
        drop(index);
        fs::remove_dir_all(root).unwrap();
    }
}
