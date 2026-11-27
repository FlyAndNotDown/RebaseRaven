use super::*;

use crate::diagnostics::{LoggedChild, LoggedReader};
use std::process::ChildStdout;
use std::sync::Weak;
use std::time::Instant;

/// A stream nobody has read for this long is closed so its `git log` process
/// does not keep the repository folder busy.
const STREAM_IDLE: Duration = Duration::from_secs(120);

struct LogStream {
    args: Vec<String>,
    selected: Vec<String>,
    query: Option<String>,
    refs: Arc<refs::RefCatalog>,
    tips: Option<BranchTips>,
    frontier: HashMap<String, u8>,
    child: Arc<Mutex<LoggedChild>>,
    reader: BufReader<LoggedReader<ChildStdout>>,
    position: usize,
    used: Instant,
}

#[derive(Default)]
pub struct HistoryReader {
    stream: Mutex<Option<LogStream>>,
    pub(super) processes: ReadProcesses,
}

type Slot = Arc<HistoryReader>;

impl HistoryReader {
    pub fn for_root(root: &Path) -> Slot {
        let mut readers = registry().lock().unwrap_or_else(|err| err.into_inner());
        readers
            .worktrees
            .entry(root.to_owned())
            .or_default()
            .clone()
    }

    pub fn search() -> Slot {
        let reader = Slot::default();
        let mut readers = registry().lock().unwrap_or_else(|err| err.into_inner());
        readers.searches.retain(|entry| entry.strong_count() != 0);
        readers.searches.push(Arc::downgrade(&reader));
        reader
    }
}

impl tauri::Resource for HistoryReader {
    fn close(self: Arc<Self>) {
        self.processes.close();
    }
}

#[derive(Default)]
struct Readers {
    worktrees: HashMap<PathBuf, Slot>,
    searches: Vec<Weak<HistoryReader>>,
}

fn registry() -> &'static Mutex<Readers> {
    static READERS: OnceLock<Mutex<Readers>> = OnceLock::new();
    READERS.get_or_init(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(30));
            let mut readers = registry().lock().unwrap_or_else(|err| err.into_inner());
            readers.searches.retain(|entry| entry.strong_count() != 0);
            let slots: Vec<_> = readers
                .worktrees
                .values()
                .cloned()
                .chain(readers.searches.iter().filter_map(Weak::upgrade))
                .collect();
            drop(readers);
            for slot in slots {
                if let Ok(mut stream) = slot.stream.try_lock() {
                    if stream
                        .as_ref()
                        .is_some_and(|item| item.used.elapsed() > STREAM_IDLE)
                    {
                        *stream = None;
                    }
                }
            }
        });
        Mutex::default()
    })
}

fn root_key(path: &str) -> String {
    let path = strip_verbatim_prefix(path);
    let slash = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path
    };
    let slash = slash.trim_end_matches('/').to_string();
    if cfg!(windows) {
        slash.to_lowercase()
    } else {
        slash
    }
}

/// Closes the history streams of repositories that are no longer open.
pub fn retain_log_streams(open: &[String]) {
    let open: Vec<String> = open.iter().map(|path| root_key(path)).collect();
    registry()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .worktrees
        .retain(|root, _| open.contains(&root_key(&root.to_string_lossy())));
}

pub(super) fn history_stream_refs(
    slot: &HistoryReader,
    skip: usize,
    selected: &[String],
    query: Option<&str>,
) -> Option<Arc<refs::RefCatalog>> {
    if skip == 0 {
        return None;
    }
    let stream = slot.stream.lock().unwrap_or_else(|err| err.into_inner());
    stream
        .as_ref()
        .filter(|stream| {
            stream.position == skip
                && stream.selected == selected
                && stream.query.as_deref() == query
        })
        .map(|stream| stream.refs.clone())
}

/// Returns `limit` lines of `git <args>` output starting at line `skip`.
///
/// Date-ordered `git log` walks the whole graph before printing its first line,
/// and `--skip` repeats that walk for every page. Instead the process for a
/// repository stays open between pages, so only the first page pays for it.
pub(super) struct LogQuery<'a> {
    pub root: &'a Path,
    pub args: &'a [String],
    pub selected: Vec<String>,
    pub query: Option<&'a str>,
    pub needle: &'a str,
    pub labels: &'a HashMap<String, Vec<CommitRefLabel>>,
    pub tips: Option<&'a BranchTips>,
    pub refs: Arc<refs::RefCatalog>,
}

pub(super) fn log_page(
    slot: &HistoryReader,
    request: LogQuery<'_>,
    skip: usize,
    limit: usize,
) -> AppResult<Vec<CommitSummary>> {
    let LogQuery {
        root,
        args,
        selected,
        query,
        needle,
        labels,
        tips,
        refs,
    } = request;
    let mut guard = slot.stream.lock().unwrap_or_else(|err| err.into_inner());
    slot.processes.active()?;
    let reusable = skip > 0
        && guard.as_ref().is_some_and(|stream| {
            stream.args == args
                && stream.query.as_deref() == query
                && stream.position == skip
                && stream.tips.as_ref() == tips
                && Arc::ptr_eq(&stream.refs, &refs)
        });
    if !reusable {
        *guard = None;
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = spawn_git_stdout(root, &argv)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::msg("Could not read git log"))?;
        let child = slot.processes.track(child)?;
        *guard = Some(LogStream {
            args: args.to_vec(),
            selected,
            query: query.map(str::to_owned),
            refs,
            tips: tips.cloned(),
            frontier: tips.map(BranchTips::frontier).unwrap_or_default(),
            child,
            reader: BufReader::new(stdout),
            position: 0,
            used: Instant::now(),
        });
    }
    let stream = guard.as_mut().expect("stream was just opened");
    let mut line = Vec::new();
    let mut page = Vec::new();
    let mut ended = false;
    while stream.position < skip.saturating_add(limit) {
        if !read_git_line(&mut stream.reader, &mut line)? {
            ended = true;
            break;
        }
        slot.processes.active()?;
        let commit = if query.is_some() {
            parse_search_record(&line).filter(|commit| commit_matches(commit, needle, labels))
        } else {
            parse_log_row(&line)
        };
        let Some(mut commit) = commit else { continue };
        if tips.is_some() {
            let mask = propagate_membership(
                &mut stream.frontier,
                &commit.id,
                commit.parents.iter().map(String::as_str),
            );
            commit.on_current_branch = mask & 1 != 0;
            commit.on_tracking_branch = mask & 2 != 0;
        }
        if stream.position >= skip {
            page.push(commit);
        }
        stream.position += 1;
    }
    slot.processes.active()?;
    if ended {
        let result = stream
            .child
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .wait_checked("Could not load Git history");
        *guard = None;
        result?;
    } else {
        stream
            .child
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .checkpoint();
        stream.used = Instant::now();
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::root_key;

    #[test]
    fn preserves_case_sensitive_repository_names() {
        assert_eq!(
            root_key("/work/Repo") == root_key("/work/repo"),
            cfg!(windows)
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_backslashes_in_unix_repository_names() {
        assert_ne!(root_key("/work/with\\slash"), root_key("/work/with/slash"));
    }
}
