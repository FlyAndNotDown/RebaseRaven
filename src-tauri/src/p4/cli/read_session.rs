//! A bounded set of warm, read-only connections supplied by the user's p4 binary.
//! Cold, busy, incompatible, and disconnected sessions use the normal CLI path.
use super::*;
use crate::p4::parse::ZtagRecord;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

const CAPACITY: usize = 4;
const IDLE: Duration = Duration::from_secs(45);
const WIRE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(in crate::p4) struct PendingRows {
    pub pending: Vec<ZtagRecord>,
    pub shelved: Vec<ZtagRecord>,
    pub opened: Vec<ZtagRecord>,
    pub description: String,
}

/// Pending summaries also come from tagged CLI output. Interpret continuation
/// lines identically so a refresh cannot change a draft's saved description.
fn change_row(mut row: ZtagRecord) -> Option<ZtagRecord> {
    if let Some(desc) = row.get_mut("desc") {
        let text = desc.trim_end_matches(['\r', '\n']);
        if text.contains('\n') {
            let mut parsed = crate::p4::parse::parse_ztag(&format!("... desc {text}"));
            let [record] = parsed.as_mut_slice() else {
                return None;
            };
            if record.len() != 1 {
                return None;
            }
            *desc = record.remove("desc")?;
        }
    }
    Some(row)
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Query<'a> {
    Pending,
    Fstat {
        fields: &'a str,
        paths: &'a [String],
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Row {
    Settings(Vec<PathBuf>),
    Pending(ZtagRecord),
    Shelved(ZtagRecord),
    Opened(ZtagRecord),
    File(ZtagRecord),
    Description(String),
    Done,
    Failed,
}

struct Session {
    _process: OwnedChild,
    input: std::process::ChildStdin,
    rows: mpsc::Receiver<Row>,
    settings: Vec<(PathBuf, Option<(SystemTime, u64)>)>,
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = path.metadata().ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

impl Session {
    fn start(program: PathBuf, env: &P4Env) -> Option<Self> {
        let mut script = tempfile::Builder::new().suffix(".lua").tempfile().ok()?;
        script.write_all(include_bytes!("read_session.lua")).ok()?;
        let mut command = prepared(program, env, &["--script"]);
        command
            .arg(script.path())
            .env("PWD", &env.cwd)
            .env("RR_P4_PORT", &env.port)
            .env("RR_P4_USER", &env.user)
            .env("RR_P4_CLIENT", &env.client)
            .env("RR_P4_CHARSET", &env.charset)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (child, tree) = crate::platform::spawn_probe_command(&mut command).ok()?;
        let mut process = OwnedChild {
            child,
            tree,
            reaped: false,
        };
        let input = process.child.stdin.take()?;
        let stdout = process.child.stdout.take()?;
        let (send, rows) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                if reader
                    .by_ref()
                    .take(2 * 1024 * 1024)
                    .read_until(b'\n', &mut line)
                    .is_err()
                    || !line.ends_with(b"\n")
                {
                    break;
                }
                let Ok(row) = serde_json::from_slice(&line) else {
                    break;
                };
                if send.send(row).is_err() {
                    break;
                }
            }
        });
        let Row::Settings(paths) = rows.recv_timeout(Duration::from_secs(3)).ok()? else {
            return None;
        };
        let settings = paths
            .into_iter()
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| {
                let path = env.cwd.join(path);
                let version = stamp(&path);
                (path, version)
            })
            .collect();
        Some(Self {
            _process: process,
            input,
            rows,
            settings,
        })
    }

    fn read(&mut self, query: &Query<'_>, mut receive: impl FnMut(Row) -> bool) -> Option<()> {
        if self
            .settings
            .iter()
            .any(|(path, before)| stamp(path) != *before)
        {
            return None;
        }
        let mut message = serde_json::to_vec(query).ok()?;
        message.push(b'\n');
        self.input.write_all(&message).ok()?;
        loop {
            match self.rows.recv_timeout(WIRE_TIMEOUT).ok()? {
                Row::Done => return Some(()),
                row => {
                    if !receive(row) {
                        return None;
                    }
                }
            }
        }
    }
}

#[derive(Hash, Eq, PartialEq, Clone)]
struct Key {
    program: PathBuf,
    env: P4Env,
    stream: Option<String>,
}
impl Key {
    fn for_read(env: &P4Env, stream: Option<&str>) -> Option<Self> {
        if activity::current_cancel().is_some()
            || env.client.is_empty()
            || env.user.is_empty()
            || env.port.is_empty()
        {
            return None;
        }
        Some(Self {
            program: require_p4().ok()?,
            env: env.clone(),
            stream: stream.map(str::to_owned),
        })
    }
}
struct Entry {
    idle: Option<Session>,
    busy: bool,
    used: Instant,
    pending_times: PendingTimes,
}
#[derive(Default)]
struct PendingTimes {
    parallel: Option<Duration>,
    slower_reads: u8,
    parallel_until: Option<Instant>,
}

impl PendingTimes {
    fn record_serial(&mut self, elapsed: Duration, now: Instant) {
        if self.parallel.is_some_and(|parallel| elapsed > parallel) {
            self.slower_reads += 1;
            if self.slower_reads == 3 {
                self.parallel_until = Some(now + IDLE);
                self.slower_reads = 0;
            }
        } else {
            self.slower_reads = 0;
            self.parallel_until = None;
        }
    }

    fn prefers_parallel(&self, now: Instant) -> bool {
        self.parallel_until.is_some_and(|until| now < until)
    }
}

type Pool = Mutex<HashMap<Key, Entry>>;
fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| {
        thread::spawn(|| loop {
            thread::sleep(IDLE);
            if let Some(pool) = POOL.get() {
                pool.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .retain(|_, entry| entry.busy || entry.used.elapsed() < IDLE);
            }
        });
        Mutex::default()
    })
}

fn put(key: &Key, session: Option<Session>, pending_time: Option<Duration>) {
    let mut pool = pool().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = pool.get_mut(key) {
        entry.idle = session;
        entry.used = Instant::now();
        entry.busy = false;
        if let Some(time) = pending_time {
            entry.pending_times.record_serial(time, entry.used);
        }
    }
}

fn run(key: &Key, query: Query<'_>, receive: impl FnMut(Row) -> bool) -> Option<()> {
    let mut pool = pool().lock().unwrap_or_else(|e| e.into_inner());
    let pending = matches!(query, Query::Pending);
    if let Some(entry) = pool.get_mut(key) {
        // On a high-latency link four concurrent CLI reads can beat four
        // serial RPCs over one connection. Use this workspace's actual timings.
        if pending && entry.pending_times.prefers_parallel(Instant::now()) {
            return None;
        }
        let mut session = entry.idle.take()?;
        entry.busy = true;
        drop(pool);
        let started = Instant::now();
        let result = session.read(&query, receive);
        let pending_time = (result.is_some() && pending).then(|| started.elapsed());
        put(key, result.map(|()| session), pending_time);
        return result;
    }
    if pool.len() >= CAPACITY {
        let oldest = pool
            .iter()
            .filter(|(_, slot)| !slot.busy)
            .min_by_key(|(_, slot)| slot.used)
            .map(|(key, _)| key.clone())?;
        pool.remove(&oldest);
    }
    pool.insert(
        key.clone(),
        Entry {
            idle: None,
            busy: true,
            used: Instant::now(),
            pending_times: PendingTimes::default(),
        },
    );
    drop(pool);
    let key = key.clone();
    thread::spawn(move || {
        let session = Session::start(key.program.clone(), &key.env);
        put(&key, session, None);
    });
    None
}

pub(in crate::p4) fn pending(
    env: &P4Env,
    stream: Option<&str>,
    parallel: impl FnOnce() -> AppResult<PendingRows>,
) -> AppResult<PendingRows> {
    let Some(key) = Key::for_read(env, stream) else {
        return parallel();
    };
    let mut rows = PendingRows::default();
    let read = run(&key, Query::Pending, |row| {
        let (changes, raw) = match row {
            Row::Opened(r) => {
                rows.opened.push(r);
                return true;
            }
            Row::Pending(r) => (&mut rows.pending, r),
            Row::Shelved(r) => (&mut rows.shelved, r),
            Row::Description(text) => {
                rows.description = crate::p4::parse::normalize_description(text.lines());
                return true;
            }
            _ => return false,
        };
        let Some(record) = change_row(raw) else {
            return false;
        };
        changes.push(record);
        true
    });
    if read.is_some() {
        return Ok(rows);
    }
    drop(rows);
    let started = Instant::now();
    let rows = parallel()?;
    if let Some(entry) = pool()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&key)
    {
        entry.pending_times.parallel = Some(started.elapsed());
    }
    Ok(rows)
}

pub(in crate::p4) fn fstat(
    env: &P4Env,
    stream: Option<&str>,
    fields: &str,
    paths: &[String],
) -> Option<Vec<ZtagRecord>> {
    let mut records = Vec::new();
    run(
        &Key::for_read(env, stream)?,
        Query::Fstat { fields, paths },
        |row| {
            if let Row::File(record) = row {
                records.push(record);
                true
            } else {
                false
            }
        },
    )?;
    Some(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_slow_read_does_not_pin_the_parallel_path() {
        let now = Instant::now();
        let fast = Duration::from_millis(3);
        let slow = Duration::from_millis(30);
        let mut times = PendingTimes {
            parallel: Some(Duration::from_millis(10)),
            ..Default::default()
        };
        times.record_serial(slow, now);
        times.record_serial(fast, now);
        assert!(!times.prefers_parallel(now));
        for _ in 0..3 {
            times.record_serial(slow, now);
        }
        assert!(times.prefers_parallel(now));
        assert!(!times.prefers_parallel(now + IDLE));
    }

    #[test]
    fn multiline_change_descriptions_match_cli_continuations() {
        let desc = "First line\n\n  Next line\r\n";
        let raw = ZtagRecord::from([("desc".into(), desc.into())]);
        let row = change_row(raw).unwrap();
        assert_eq!(row["desc"], "First line\nNext line");
    }

    #[cfg(unix)]
    #[test]
    fn warm_reads_retire_on_settings_changes_and_incomplete_responses() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("client");
        let env = P4Env {
            cwd: root.path().to_owned(),
            port: String::new(),
            user: String::new(),
            client: String::new(),
            charset: String::new(),
        };
        std::fs::write(
            &program,
            r#"#!/bin/sh
echo '{"settings":["tickets","trust","config","enviro"]}'
while IFS= read -r request; do
    echo '{"pending":{"change":"7"}}'
    if [ -e fail ]; then echo '"failed"'; exit; fi
    echo '"done"'
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut session = Session::start(program.clone(), &env).unwrap();
        let read = |session: &mut Session| {
            let mut count = 0;
            session
                .read(&Query::Pending, |row| {
                    if !matches!(row, Row::Pending(_)) {
                        return false;
                    }
                    count += 1;
                    true
                })
                .map(|()| count)
        };
        assert_eq!(read(&mut session), Some(1));
        assert_eq!(read(&mut session), Some(1));
        std::fs::write(root.path().join("tickets"), "replacement").unwrap();
        assert_eq!(read(&mut session), None);
        drop(session);
        let mut session = Session::start(program, &env).unwrap();
        std::fs::write(root.path().join("fail"), []).unwrap();
        assert_eq!(read(&mut session), None);
        assert!(Session::start("/usr/bin/false".into(), &env).is_none());
    }
}
