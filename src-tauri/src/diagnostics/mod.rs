mod archive;
mod event;

pub use event::{Code, Status};
use event::{Event, Failure};

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::Record;
use log4rs::{
    append::{
        file::FileAppender,
        rolling_file::policy::compound::roll::{fixed_window::FixedWindowRoller, Roll},
        Append,
    },
    encode::pattern::PatternEncoder,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const FILE_BYTES: usize = 1024 * 1024;
const RETENTION_DAYS: u64 = 7;
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
const LOG_NAMES: [&str; 8] = [
    "events.log",
    "events.1.log",
    "events.2.log",
    "events.3.log",
    "events.4.log",
    "events.5.log",
    "events.6.log",
    "events.7.log",
];
const MAX_LOG_BYTES: usize = FILE_BYTES * LOG_NAMES.len();
const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_TIMESTAMP_MS: u64 = 4_102_444_800_000;
const ISSUES_URL: &str = "https://github.com/FlyAndNotDown/Rebasely/issues";
static EVENTS: OnceLock<mpsc::SyncSender<Event>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    total_bytes: u64,
    file_count: usize,
    max_bytes: usize,
    retention_days: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    file_count: usize,
    skipped_entries: usize,
}

/// Starts one low-priority writer; failed diagnostics never prevent startup.
/// Call once during setup. Disk work stays on this thread or a blocking command.
pub fn initialize(app: &AppHandle) -> AppResult<()> {
    if EVENTS.get().is_some() {
        return Ok(());
    }
    let directory = log_directory(app)?;
    let (sender, receiver) = mpsc::sync_channel::<Event>(64);
    std::thread::Builder::new()
        .name("local-diagnostics".into())
        .spawn(move || {
            let mut limiter = RateLimit::default();
            let mut next_prune = Instant::now();
            loop {
                let wait = next_prune.saturating_duration_since(Instant::now());
                let event = match receiver.recv_timeout(wait) {
                    Ok(event) => Some(event),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let now = Instant::now();
                let prune = now >= next_prune;
                let event = event.filter(|event| limiter.allow(event.code, event.status, now));
                if prune {
                    next_prune = now + PRUNE_INTERVAL;
                }
                if prune || event.is_some() {
                    if let Ok(store) = Store::new(&directory) {
                        if prune {
                            let _ = store.prune(retention_cutoff());
                        }
                        if let Some(event) = event {
                            let _ = store.append(&event);
                        }
                    }
                }
            }
        })
        .map_err(|_| AppError::msg("Could not start local diagnostics."))?;
    let _ = EVENTS.set(sender);
    record(Code::AppStarted, Status::Success, None);
    Ok(())
}

/// Successful fast reads stay quiet; failures and slow operations carry no input data.
pub fn record_slow_or_failed<T>(code: Code, started: Instant, result: &AppResult<T>) {
    if result.is_err() || started.elapsed() >= Duration::from_secs(1) {
        record_command(code, started, result);
    }
}

/// Mutations and explicit previews record their outcome even when fast.
pub fn record_command<T>(code: Code, started: Instant, result: &AppResult<T>) {
    record_command_outcome(
        code,
        started,
        Status::of(result),
        result.as_ref().err().and_then(Failure::of),
    );
}

pub fn record_exit(code: Code, started: Instant, success: bool, status: std::process::ExitStatus) {
    let (outcome, failure) = if success {
        (Status::Success, None)
    } else {
        (Status::Failure, status.code().map(Failure::ExitCode))
    };
    record_command_outcome(code, started, outcome, failure);
}

fn record_command_outcome(code: Code, started: Instant, status: Status, failure: Option<Failure>) {
    let passive = matches!(
        code,
        Code::GitStatus
            | Code::GitDiff
            | Code::GitHistory
            | Code::GitBackgroundFetch
            | Code::PerforceOperation
            | Code::PerforceInfo
            | Code::PerforceStatus
            | Code::PerforceHistory
            | Code::PerforceDiff
    );
    let elapsed = started.elapsed();
    if !passive || status != Status::Success || elapsed >= Duration::from_secs(1) {
        record_event(code, status, Some(elapsed), failure);
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(MAX_TIMESTAMP_MS)) as u64
}

fn retention_cutoff() -> u64 {
    unix_ms().saturating_sub(RETENTION_DAYS * 86_400_000)
}

/// Nonblocking and deliberately unable to accept paths, messages, or command output.
pub fn record(code: Code, status: Status, duration: Option<Duration>) {
    record_event(code, status, duration, None);
}

fn record_event(code: Code, status: Status, duration: Option<Duration>, failure: Option<Failure>) {
    if let Some(sender) = EVENTS.get() {
        let _ = sender.try_send(Event {
            time_unix_ms: unix_ms(),
            code,
            status,
            duration_ms: duration
                .map(|value| value.as_millis().min(u128::from(MAX_DURATION_MS)) as u64),
            failure,
        });
    }
}

pub fn summary(app: &AppHandle) -> AppResult<Summary> {
    let directory = log_directory(app)?;
    Store::new(&directory)
        .and_then(|store| store.summary())
        .map_err(|_| AppError::msg("Could not read local diagnostics. Try again."))
}

pub fn export(app: &AppHandle, destination: &Path) -> AppResult<ExportResult> {
    let directory = log_directory(app)?;
    let result = Store::new(&directory).and_then(|store| store.export(destination));
    record(
        Code::DiagnosticsExport,
        if result.is_ok() {
            Status::Success
        } else {
            Status::Failure
        },
        None,
    );
    result.map_err(|_| {
        AppError::msg("Could not export diagnostics. Choose a writable ZIP file and try again.")
    })
}

pub fn open_directory(app: &AppHandle) -> AppResult<()> {
    let directory = log_directory(app)?;
    let store = Store::new(&directory)
        .map_err(|_| AppError::msg("Could not open the local diagnostics folder."))?;
    crate::platform::open_path(&store.directory)
        .map_err(|_| AppError::msg("Could not open the local diagnostics folder."))
}

pub fn open_issues() -> AppResult<()> {
    crate::platform::open_url(ISSUES_URL)
}

fn log_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_log_dir()
        .map(|directory| directory.join("diagnostics-v2"))
        .map_err(|_| AppError::msg("The local diagnostics folder is unavailable."))
}

#[derive(Default)]
struct RateLimit {
    last: HashMap<(Code, Status), Instant>,
    window: Option<Instant>,
    count: usize,
}

impl RateLimit {
    fn allow(&mut self, code: Code, status: Status, now: Instant) -> bool {
        if self
            .window
            .is_none_or(|start| now.duration_since(start) >= Duration::from_secs(60))
        {
            self.window = Some(now);
            self.count = 0;
        }
        if self.count >= 60
            || self
                .last
                .get(&(code, status))
                .is_some_and(|last| now.duration_since(*last) < Duration::from_secs(5))
        {
            return false;
        }
        self.count += 1;
        self.last.insert((code, status), now);
        true
    }
}

struct Store {
    directory: PathBuf,
    // The OS releases this cross-process lock even if the app crashes.
    _lock: File,
}

impl Store {
    fn new(directory: &Path) -> io::Result<Self> {
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::create_dir(directory) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        if !fs::symlink_metadata(directory)?.file_type().is_dir() {
            return Err(invalid_store());
        }
        let directory = fs::canonicalize(directory)?;
        let lock_path = directory.join(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        safe_options(&mut options);
        let lock = options.open(lock_path)?;
        if !lock.metadata()?.is_file() {
            return Err(invalid_store());
        }
        lock.try_lock().map_err(|_| invalid_store())?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }

    fn summary(&self) -> io::Result<Summary> {
        let mut total_bytes = 0;
        let mut file_count = 0;
        for name in LOG_NAMES {
            if let Some(metadata) = self.metadata(name)? {
                total_bytes += metadata.len();
                file_count += 1;
            }
        }
        Ok(Summary {
            total_bytes,
            file_count,
            max_bytes: MAX_LOG_BYTES,
            retention_days: RETENTION_DAYS,
        })
    }

    fn metadata(&self, name: &str) -> io::Result<Option<fs::Metadata>> {
        match fs::symlink_metadata(self.directory.join(name)) {
            Ok(metadata) if metadata.file_type().is_file() => Ok(Some(metadata)),
            Ok(_) => Err(invalid_store()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        let Some(metadata) = self.metadata(name)? else {
            return Ok(None);
        };
        if metadata.len() > FILE_BYTES as u64 {
            return Err(invalid_store());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        safe_options(&mut options);
        let file = options.open(self.directory.join(name))?;
        if !file.metadata()?.is_file() {
            return Err(invalid_store());
        }
        let mut contents = Vec::new();
        file.take(FILE_BYTES as u64 + 1)
            .read_to_end(&mut contents)?;
        if contents.len() > FILE_BYTES {
            return Err(invalid_store());
        }
        Ok(Some(contents))
    }

    fn prune(&self, cutoff: u64) -> io::Result<()> {
        for name in LOG_NAMES {
            let Ok(Some(contents)) = self.read(name) else {
                continue;
            };
            let (retained, _) = sanitize(&contents, cutoff);
            let path = self.directory.join(name);
            if retained.is_empty() {
                fs::remove_file(path)?;
            } else if retained != contents {
                crate::fsutil::write_atomic(&path, &retained)?;
            }
        }
        Ok(())
    }

    fn append(&self, event: &Event) -> io::Result<()> {
        // Discard damaged oversized files before writing; do not grow the budget.
        for name in LOG_NAMES {
            if self
                .metadata(name)?
                .is_some_and(|metadata| metadata.len() > FILE_BYTES as u64)
            {
                fs::remove_file(self.directory.join(name))?;
            }
        }
        let directory = self.directory.to_str().ok_or_else(invalid_store)?;
        // The appender and roller interpolate these tokens in paths.
        if ["$ENV{", "$TIME{", "{}"]
            .iter()
            .any(|token| directory.contains(token))
        {
            return Err(invalid_store());
        }
        let path = self.directory.join(LOG_NAMES[0]);
        let (length, needs_newline) = prepare_active_log(&path)?;
        let mut line = event.line();
        if needs_newline {
            // Keep an interrupted write from swallowing the next complete record.
            line.insert(0, '\n');
        }
        if length + line.len() as u64 > FILE_BYTES as u64 {
            // The roller can fall back to copying if a rename fails.
            for name in &LOG_NAMES[1..] {
                if self.metadata(name)?.is_some() {
                    open_log(&self.directory.join(name))?;
                }
            }
            let pattern = self.directory.join("events.{}.log");
            FixedWindowRoller::builder()
                .base(1)
                .build(
                    pattern.to_str().ok_or_else(invalid_store)?,
                    (LOG_NAMES.len() - 1) as u32,
                )
                .and_then(|roller| roller.roll(&path))
                .map_err(|_| invalid_store())?;
            prepare_active_log(&path)?;
            line = event.line();
        }
        // Keep this appender private: only typed diagnostic events enter the file.
        FileAppender::builder()
            .append(true)
            .encoder(Box::new(PatternEncoder::new("{m}")))
            .build(&path)?
            .append(
                &Record::builder()
                    .level(event.status.level())
                    .args(format_args!("{line}"))
                    .build(),
            )
            .map_err(|_| invalid_store())
    }

    fn export(&self, destination: &Path) -> io::Result<ExportResult> {
        if !destination.is_absolute()
            || !destination
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        {
            return Err(invalid_store());
        }
        let parent = destination.parent().ok_or_else(invalid_store)?;
        let parent = fs::canonicalize(parent)?;
        if parent.starts_with(&self.directory) {
            return Err(invalid_store());
        }
        let destination = parent.join(destination.file_name().ok_or_else(invalid_store)?);
        let mut entries = Vec::new();
        let mut skipped_entries = 0;
        let cutoff = retention_cutoff();
        for name in LOG_NAMES {
            match self.read(name) {
                Ok(Some(contents)) => {
                    let (contents, skipped) = sanitize(&contents, cutoff);
                    skipped_entries += skipped;
                    if !contents.is_empty() {
                        entries.push((name, contents));
                    }
                }
                Ok(None) => {}
                Err(_) => skipped_entries += 1,
            }
        }
        let file_count = entries.len();
        let manifest = serde_json::json!({
            "schemaVersion": 3,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "logFiles": file_count,
            "skippedEntries": skipped_entries,
        });
        entries.push(("manifest.json", serde_json::to_vec_pretty(&manifest)?));
        entries.push(("README.txt", b"Rebasely local diagnostics\n\nThe .log files contain one event per line: [UTC time][Level][Type] Message. The message reports the outcome and available timing or failure details. No repository paths, remote URLs, usernames, credentials, command output, or original error messages are collected. Nothing is uploaded automatically. Review the archive before sharing it manually in an issue.\n".to_vec()));
        let contents = archive::stored_zip(&entries)?;
        crate::fsutil::write_atomic(&destination, &contents)?;
        Ok(ExportResult {
            file_count,
            skipped_entries,
        })
    }
}

fn open_log(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    safe_options(&mut options);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || !single_link(&file)? {
        return Err(invalid_store());
    }
    Ok(file)
}

fn prepare_active_log(path: &Path) -> io::Result<(u64, bool)> {
    let mut file = match open_log(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Set private permissions before handing the path to the appender.
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            safe_options(&mut options);
            options.open(path)?;
            return Ok((0, false));
        }
        Err(error) => return Err(error),
    };
    let length = file.metadata()?.len();
    if length == 0 {
        return Ok((0, false));
    }
    let mut last = [0];
    file.seek(SeekFrom::End(-1))?;
    file.read_exact(&mut last)?;
    Ok((length, last[0] != b'\n'))
}

#[cfg(unix)]
fn single_link(file: &File) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink() == 1)
}

#[cfg(windows)]
fn single_link(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The open handle and the writable structure both outlive the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks == 1 && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0)
}

fn safe_options(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
}

fn invalid_store() -> io::Error {
    io::Error::other("Local diagnostics are unavailable.")
}

fn sanitize(contents: &[u8], cutoff: u64) -> (Vec<u8>, usize) {
    let mut output = Vec::new();
    let mut skipped = 0;
    for line in contents.split_inclusive(|byte| *byte == b'\n') {
        let Some(event) = line
            .strip_suffix(b"\n")
            .and_then(|line| Event::parse(line, cutoff))
        else {
            skipped += 1;
            continue;
        };
        let line = event.line();
        if output.len() + line.len() <= FILE_BYTES {
            output.extend_from_slice(line.as_bytes());
        } else {
            skipped += 1;
        }
    }
    (output, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> Event {
        Event {
            time_unix_ms: unix_ms(),
            code: Code::UiReady,
            status: Status::Success,
            duration_ms: Some(42),
            failure: None,
        }
    }

    #[test]
    fn exported_records_reject_extra_fields_unknown_codes_and_invalid_limits() {
        let valid = event().line();
        let contents = format!(
            "{valid}[2026-01-01T00:00:00.000Z][INFO][UiReady] Completed /private/example\n\
             [2026-01-01T00:00:00.000Z][ERROR][https://example.com] Failed\n\
             [2026-01-01T00:00:00.000Z][ERROR][GitFetch] Failed. untrusted command output\n\
             incomplete"
        );
        let (sanitized, skipped) = sanitize(contents.as_bytes(), 0);
        assert_eq!(skipped, 4);
        assert_eq!(sanitized, valid.as_bytes());
        let mut invalid = event();
        invalid.duration_ms = Some(MAX_DURATION_MS + 1);
        assert_eq!(sanitize(invalid.line().as_bytes(), 0).1, 1);
        invalid.time_unix_ms = MAX_TIMESTAMP_MS + 1;
        invalid.duration_ms = None;
        assert_eq!(sanitize(invalid.line().as_bytes(), 0).1, 1);
    }

    #[test]
    fn existing_text_records_are_reformatted_without_exporting_unknown_details() {
        let contents =
            b"2026-01-01T00:00:00.000Z ERROR GitFetch | Failed in 37 ms | Exit code 128\n\
            2026-01-01T00:00:00.000Z ERROR GitFetch | Failed | untrusted command output\n";
        let (sanitized, skipped) = sanitize(contents, 0);
        assert_eq!(skipped, 1);
        assert_eq!(
            sanitized,
            b"[2026-01-01T00:00:00.000Z][ERROR][GitFetch] Failed in 37 ms. Exit code 128\n"
        );
    }

    #[test]
    fn appending_after_an_interrupted_write_keeps_complete_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let first = event();
        let path = store.directory.join(LOG_NAMES[0]);
        fs::write(&path, format!("{}interrupted", first.line())).unwrap();
        let mut reader = File::open(&path).unwrap();
        let mut second = event();
        second.code = Code::PerforceResolve;
        second.status = Status::Failure;
        second.failure = Failure::of(&AppError::msg(crate::error::P4_RESOLVE_CONFLICTS));

        store.append(&second).unwrap();

        let mut contents = Vec::new();
        reader.read_to_end(&mut contents).unwrap();
        let (retained, skipped) = sanitize(&contents, 0);
        assert_eq!(skipped, 1);
        assert_eq!(
            retained,
            format!("{}{}", first.line(), second.line()).as_bytes()
        );
        assert!(second
            .line()
            .contains("][ERROR][PerforceResolve] Failed in 42 ms. Automatic merge left conflicts"));
    }

    #[test]
    fn append_and_rotation_do_not_follow_hard_links() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let target = temp.path().join("existing.txt");
        fs::write(&target, b"unchanged").unwrap();
        let active = store.directory.join(LOG_NAMES[0]);
        fs::hard_link(&target, &active).unwrap();
        assert!(store.append(&event()).is_err());
        fs::remove_file(&active).unwrap();

        fs::write(active, vec![b'\n'; FILE_BYTES]).unwrap();
        fs::hard_link(&target, store.directory.join(LOG_NAMES[1])).unwrap();
        assert!(store.append(&event()).is_err());
        assert_eq!(fs::read(target).unwrap(), b"unchanged");
    }

    #[test]
    fn retention_prunes_expired_entries_from_active_and_rotated_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let mut expired = event();
        expired.time_unix_ms = 1;
        store.append(&expired).unwrap();
        fs::write(store.directory.join(LOG_NAMES[1]), expired.line()).unwrap();
        let mut recent = event();
        recent.code = Code::PerforceSync;
        store.append(&recent).unwrap();

        store.prune(retention_cutoff()).unwrap();

        assert!(store.read(LOG_NAMES[1]).unwrap().is_none());
        let retained = store.read(LOG_NAMES[0]).unwrap().unwrap();
        let actual = Event::parse(retained.strip_suffix(b"\n").unwrap(), 0).unwrap();
        assert_eq!(actual.code, Code::PerforceSync);
    }

    #[test]
    fn rotation_keeps_logs_within_the_total_budget() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let line = event().line();
        let full = line.as_bytes().repeat(FILE_BYTES / line.len());
        for name in LOG_NAMES {
            fs::write(store.directory.join(name), &full).unwrap();
        }
        store.append(&event()).unwrap();
        let summary = store.summary().unwrap();
        assert_eq!(summary.file_count, LOG_NAMES.len());
        assert_eq!(summary.max_bytes, 8 * 1024 * 1024);
        assert!(summary.total_bytes <= summary.max_bytes as u64);
        assert!(store.read(LOG_NAMES[0]).unwrap().unwrap().len() < 1024);
        assert_eq!(store.read(LOG_NAMES[1]).unwrap().unwrap(), full);
        fs::write(store.directory.join(LOG_NAMES[2]), vec![0; FILE_BYTES + 1]).unwrap();
        store.append(&event()).unwrap();
        assert!(store.summary().unwrap().total_bytes <= summary.max_bytes as u64);
    }

    #[test]
    fn export_does_not_include_unmanaged_files_or_write_inside_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(&temp.path().join("logs")).unwrap();
        store.append(&event()).unwrap();
        fs::write(store.directory.join("prefs.json"), b"private-value").unwrap();
        assert!(store.export(&store.directory.join("out.zip")).is_err());
        assert!(store.export(Path::new("relative.zip")).is_err());
        let output = temp.path().join("out.zip");
        let result = store.export(&output).unwrap();
        assert_eq!(result.file_count, 1);
        assert_eq!(result.skipped_entries, 0);
        let archive = fs::read(output).unwrap();
        assert!(archive
            .windows(b"events.log".len())
            .any(|value| value == b"events.log"));
        assert!(!archive
            .windows(b"private-value".len())
            .any(|value| value == b"private-value"));
        assert!(archive.len() <= archive::MAX_ARCHIVE_BYTES);
    }

    #[test]
    fn simultaneous_store_handles_cannot_rotate_the_same_logs() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("logs");
        let first = Store::new(&path).unwrap();
        assert!(Store::new(&path).is_err());
        drop(first);
        assert!(Store::new(&path).is_ok());
    }

    #[test]
    fn repetitive_events_are_throttled_but_new_statuses_are_distinct() {
        let mut limit = RateLimit::default();
        let now = Instant::now();
        assert!(limit.allow(Code::GitOperation, Status::Success, now));
        assert!(!limit.allow(
            Code::GitOperation,
            Status::Success,
            now + Duration::from_secs(1)
        ));
        assert!(limit.allow(
            Code::GitOperation,
            Status::Failure,
            now + Duration::from_secs(1)
        ));
        assert!(limit.allow(
            Code::GitOperation,
            Status::Success,
            now + Duration::from_secs(5)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directories_and_entries_are_not_followed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let other = temp.path().join("other");
        fs::create_dir(&other).unwrap();
        let linked = temp.path().join("linked");
        symlink(&other, &linked).unwrap();
        assert!(Store::new(&linked).is_err());
        let store = Store::new(&temp.path().join("logs")).unwrap();
        let private = other.join("secret");
        fs::write(&private, b"private-value").unwrap();
        symlink(&private, store.directory.join(LOG_NAMES[0])).unwrap();
        assert!(store.append(&event()).is_err());
        assert!(store.read(LOG_NAMES[0]).is_err());
        let result = store.export(&temp.path().join("out.zip")).unwrap();
        assert_eq!(result.skipped_entries, 1);
        assert_eq!(fs::read(&private).unwrap(), b"private-value");
    }
}
