//! A resumable workspace walk. Each open Files view owns its cursor and closes
//! it when the query changes, including while a status command is running.
use super::*;
use crate::activity;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

const PAGE_SIZE: usize = 200;
const ENTRIES_PER_SCAN: usize = 1024;

pub(super) struct Walker {
    root: Option<PathBuf>,
    directories: VecDeque<PathBuf>,
    current: Option<fs::ReadDir>,
    query: String,
}

impl Walker {
    pub(super) fn new(root: PathBuf, query: &str) -> Self {
        Self {
            root: Some(root),
            directories: VecDeque::new(),
            current: None,
            query: query.trim().to_lowercase(),
        }
    }

    pub(super) fn page(&mut self, cancelled: &AtomicBool) -> AppResult<(Vec<P4DirEntry>, bool)> {
        let mut hits = Vec::new();
        if self.query.is_empty() {
            return Ok((hits, false));
        }
        let mut scanned = 0;
        // Sparse queries can show their first matches before the entire tree is walked.
        while hits.len() < PAGE_SIZE && (hits.is_empty() || scanned < ENTRIES_PER_SCAN) {
            if cancelled.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let Some(read) = self.current.as_mut() else {
                if let Some(root) = self.root.take() {
                    self.current = fs::read_dir(root).ok();
                    continue;
                }
                let Some(dir) = self.directories.pop_front() else {
                    return Ok((hits, false));
                };
                if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
                    self.current = fs::read_dir(dir).ok();
                }
                continue;
            };
            let Some(entry) = read.next() else {
                self.current = None;
                continue;
            };
            scanned += 1;
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && !generated_dir(&name) {
                self.directories.push_back(entry.path());
            }
            if name.to_lowercase().contains(&self.query) {
                let mut hit = plain_dir(&name, &entry.path());
                hit.dir = kind.is_dir();
                hits.push(hit);
            }
        }
        Ok((hits, true))
    }
}

pub struct WorkspaceSearch {
    connection: P4Connection,
    walker: Mutex<Walker>,
    cancelled: AtomicBool,
    activity: String,
}

impl WorkspaceSearch {
    pub fn new(connection: P4Connection, query: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self {
            walker: Mutex::new(Walker::new(PathBuf::from(&connection.root), query)),
            connection,
            activity: format!("workspace-search-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            cancelled: false.into(),
        }
    }

    pub fn page(&self, names: impl FnOnce(&P4FileSearch)) -> AppResult<P4FileSearch> {
        activity::with_cancel(Some(&self.activity), || {
            let root = Path::new(&self.connection.root);
            if !root.is_dir() {
                return Err(AppError::msg("Workspace folder was not found."));
            }
            let (mut hits, truncated) = self
                .walker
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .page(&self.cancelled)?;
            include_search_parents(root, &mut hits);
            let mut page = P4FileSearch {
                hits,
                truncated,
                scope: String::new(),
            };
            names(&page);
            annotate_ignored(&env_for(&self.connection), &mut page.hits);
            activity::check_cancelled()?;
            let (mut files, dirs): (Vec<_>, Vec<_>) =
                page.hits.into_iter().partition(|hit| !hit.dir);
            annotate_paths(&self.connection, &mut files);
            activity::check_cancelled()?;
            files.extend(dirs);
            clear_versioned_ignores(&mut files);
            page.hits = files;
            Ok(page)
        })
    }
}

impl tauri::Resource for WorkspaceSearch {
    fn close(self: Arc<Self>) {
        self.cancelled.store(true, Ordering::Relaxed);
        activity::cancel_activity(&self.activity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn pages_resume_at_the_next_entry_and_observe_cancellation() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..(PAGE_SIZE + 13) {
            fs::write(root.path().join(format!("asset-{index}")), []).unwrap();
        }
        let mut walk = Walker::new(root.path().into(), "ASSET");
        let (first, more) = walk.page(&false.into()).unwrap();
        assert!(more);
        assert_eq!(first.len(), PAGE_SIZE);
        assert!(walk.page(&true.into()).unwrap_err().is_cancelled());
        let (last, more) = walk.page(&false.into()).unwrap();
        assert!(!more);
        assert_eq!(last.len(), 13);
        assert_eq!(
            first
                .into_iter()
                .chain(last)
                .map(|hit| hit.path)
                .collect::<BTreeSet<_>>()
                .len(),
            PAGE_SIZE + 13
        );
    }
}
