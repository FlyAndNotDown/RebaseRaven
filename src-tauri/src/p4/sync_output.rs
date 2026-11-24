use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub failed: bool,
    updated: usize,
    added: usize,
    deleted: usize,
    unchanged: bool,
    warnings: BTreeMap<&'static str, usize>,
    diagnostics: usize,
    first_diagnostic: String,
}

/// File progress takes constant space. Only skipped paths need to be retained
/// for exact deduplication across both pipes and all revision target batches.
#[derive(Default)]
pub(super) struct SyncOutput {
    summary: SyncSummary,
    skipped: BTreeMap<&'static str, HashSet<String>>,
}

impl SyncOutput {
    pub fn record(&mut self, line: &str) -> bool {
        let line = line.trim();
        let line = line
            .get(..8)
            .filter(|s| s.eq_ignore_ascii_case("warning:"))
            .map_or(line, |_| line[8..].trim_start());
        if line.is_empty() || line == "Perforce client error:" {
            return false;
        }
        let (file, status) = file_status(line);
        if file.starts_with("//") {
            let count = if status.starts_with("added as ") {
                Some(&mut self.summary.added)
            } else if status.starts_with("deleted as ") {
                Some(&mut self.summary.deleted)
            } else if [
                "updating ",
                "refreshing ",
                "replacing ",
                "moved from ",
                "moved to ",
            ]
            .iter()
            .any(|prefix| status.starts_with(prefix))
            {
                Some(&mut self.summary.updated)
            } else {
                None
            };
            if let Some(count) = count {
                *count += 1;
                return true;
            }
        }
        let status_lower = status.to_ascii_lowercase();
        let status = status_lower.trim_end_matches('.');
        if let Some((kind, file)) = skipped_file(line, file, status) {
            self.skip(kind, file);
        } else if matches!(
            status,
            "file(s) up-to-date"
                | "up to date"
                | "no file(s) to resolve"
                | "no file(s) to reconcile"
                | "no file(s) to revert"
        ) {
            self.summary.unchanged = true;
        } else {
            self.summary.diagnostics += 1;
            if self.summary.first_diagnostic.is_empty()
                || (self.summary.first_diagnostic.starts_with("Perforce ")
                    && self.summary.first_diagnostic.ends_with(" error:"))
            {
                self.summary.first_diagnostic = crate::error::redact_credentials(line)
                    .chars()
                    .take(2048)
                    .collect();
            }
        }
        false
    }

    pub fn skip(&mut self, kind: &'static str, path: &str) {
        self.skipped
            .entry(kind)
            .or_default()
            .insert(file_key(path.trim()));
    }

    pub fn only_skips(&self) -> bool {
        !self.skipped.is_empty() && self.summary.diagnostics == 0
    }

    pub fn append(&mut self, other: Self) {
        self.summary.updated += other.summary.updated;
        self.summary.added += other.summary.added;
        self.summary.deleted += other.summary.deleted;
        self.summary.unchanged |= other.summary.unchanged;
        self.summary.diagnostics += other.summary.diagnostics;
        if self.summary.first_diagnostic.is_empty() {
            self.summary.first_diagnostic = other.summary.first_diagnostic;
        }
        for (kind, files) in other.skipped {
            self.skipped.entry(kind).or_default().extend(files);
        }
    }

    pub fn finish(mut self, success: bool) -> SyncSummary {
        self.summary.failed = !success;
        // A later batch can fail silently after earlier batches skipped files.
        if !success && self.summary.diagnostics == 0 {
            self.summary.diagnostics = 1;
        }
        self.summary.warnings = self
            .skipped
            .into_iter()
            .map(|(kind, files)| (kind, files.len()))
            .collect();
        self.summary
    }
}

fn skipped_file<'a>(line: &'a str, file: &'a str, status: &str) -> Option<(&'static str, &'a str)> {
    for (prefix, kind) in [
        ("can't clobber writable file ", "writable"),
        ("can't clobber modified file ", "modified"),
        ("can't overwrite modified file ", "modified"),
    ] {
        if line
            .get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        {
            return Some((kind, &line[prefix.len()..]));
        }
    }
    if let Some(skipped) = windows_skip(line) {
        return Some(skipped);
    }
    if file.is_empty() {
        return None;
    }
    let starts_with_words = |words: &str| {
        status
            .strip_prefix(words)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
    };
    let kind = if [
        "can't update open file",
        "can't update opened file",
        "can't delete open file",
        "can't delete opened file",
    ]
    .iter()
    .any(|words| starts_with_words(words))
        || status == "is opened and not being changed"
        || (status.starts_with("is opened for ")
            && (status.ends_with("and can't be deleted")
                || status.ends_with("and can't be updated")))
    {
        "opened"
    } else if starts_with_words("can't update modified file")
        || starts_with_words("can't overwrite modified file")
    {
        "modified"
    } else if starts_with_words("must resolve") {
        "resolve"
    } else if status == "file(s) not in client view" {
        "outsideView"
    } else {
        return None;
    };
    Some((kind, file))
}

fn windows_skip(line: &str) -> Option<(&'static str, &str)> {
    let (op, rest) = line.split_once(": ")?;
    let (arg, reason) = rest.rsplit_once(": ")?;
    let path = match op {
        "rename" => {
            let (path, count) = arg
                .strip_prefix("failed to rename ")?
                .rsplit_once(" after ")?;
            count.strip_suffix(" attempts")?.parse::<u32>().ok()?;
            path
        }
        "unlink" | "open for write" | "chmod" | "write" | "Write" => arg,
        _ => return None,
    };
    if !is_windows_path(path) {
        return None;
    }
    Some((windows_file_error(reason, op == "rename")?, path))
}

fn windows_file_error(reason: &str, replacing: bool) -> Option<&'static str> {
    // p4 uses FormatMessage for the Windows portion of the diagnostic.
    for (code, english, kind) in [
        (32, "The process cannot access the file because it is being used by another process.", "inUse"),
        (33, "The process cannot access the file because another process has locked a portion of the file.", "inUse"),
        (1224, "The requested operation cannot be performed on a file with a user-mapped section open.", "inUse"),
        (80, "The file exists.", "targetExists"),
        (183, "Cannot create a file when that file already exists.", "targetExists"),
    ] {
        if (kind != "targetExists" || replacing)
            && (reason.eq_ignore_ascii_case(english) || localized_os_error(reason, code))
        {
            return Some(kind);
        }
    }
    None
}

fn localized_os_error(reason: &str, code: i32) -> bool {
    cfg!(windows)
        && std::io::Error::from_raw_os_error(code)
            .to_string()
            .rsplit_once(" (os error ")
            .is_some_and(|(text, _)| text.trim() == reason)
}

fn file_status(line: &str) -> (&str, &str) {
    // Perforce escapes literal '#' in depot names. The revision therefore
    // disambiguates the status separator even when the name also contains " - ".
    if line.starts_with("//") {
        if let Some((_, revision)) = line.split_once('#') {
            if let Some((number, status)) = revision.split_once(" - ") {
                if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) {
                    return (&line[..line.len() - status.len() - 3], status);
                }
            }
        }
    }
    line.rsplit_once(" - ").unwrap_or(("", line))
}

fn is_windows_path(path: &str) -> bool {
    path.starts_with(r"\\")
        || (path.as_bytes().get(1) == Some(&b':')
            && path
                .as_bytes()
                .get(2)
                .is_some_and(|b| matches!(b, b'/' | b'\\')))
}

fn file_key(path: &str) -> String {
    if path.starts_with("//") {
        if let Some((base, rev)) = path.rsplit_once('#') {
            if !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) {
                return base.to_owned();
            }
        }
    } else if is_windows_path(path) {
        return path.replace('\\', "/").to_lowercase();
    }
    path.to_owned()
}

#[derive(Default)]
pub(super) struct TransferProgress {
    pub transferred: u64,
    last: Option<Instant>,
    pending: String,
}

impl TransferProgress {
    pub fn record(&mut self, line: &str, now: Instant, emit: &mut impl FnMut(&str, u64)) {
        self.transferred += 1;
        self.pending.clear();
        if self
            .last
            .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100))
        {
            emit(line, self.transferred);
            self.last = Some(now);
        } else {
            self.pending.push_str(line);
        }
    }

    pub fn finish(&self, emit: &mut impl FnMut(&str, u64)) {
        if !self.pending.is_empty() {
            emit(&self.pending, self.transferred);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_files_and_rename_collisions_are_distinct_from_fatal_io_errors() {
        let mut batch = SyncOutput::default();
        let sharing =
            "The process cannot access the file because it is being used by another process.";
        batch.record("Perforce client error:");
        batch.record(&format!(
            r"rename: failed to rename C:\Work\binary file after 10 attempts: {sharing}"
        ));
        batch.record(&format!("unlink: c:/work/binary file: {sharing}"));
        batch.record(r"rename: failed to rename C:\work\other after 10 attempts: Cannot create a file when that file already exists.");
        assert!(batch.only_skips());
        batch.record(r"rename: failed to rename C:\work\third after 10 attempts: There is not enough space on the disk.");
        assert!(!batch.only_skips());
        let summary = batch.finish(false);
        assert!(summary.failed);
        assert_eq!(summary.diagnostics, 1);
        assert_eq!(summary.warnings["inUse"], 1);
        assert_eq!(summary.warnings["targetExists"], 1);
        assert!(summary.first_diagnostic.contains("disk"));
    }

    #[test]
    fn progress_coalesces_bursts_and_reports_the_final_count() {
        let start = Instant::now();
        let mut progress = TransferProgress::default();
        let mut counts = Vec::new();
        let mut emit = |_: &str, count| counts.push(count);
        for index in 0..100_000 {
            progress.record(
                "transferring",
                start + Duration::from_micros(index),
                &mut emit,
            );
        }
        progress.record("sampled", start + Duration::from_millis(100), &mut emit);
        progress.record("final", start + Duration::from_millis(101), &mut emit);
        progress.finish(&mut emit);
        assert_eq!(counts, [1, 100_001, 100_002]);
    }

    #[test]
    fn large_transfers_keep_counts_and_distinct_warnings() {
        let mut out = SyncOutput::default();
        for _ in 0..100_000 {
            assert!(out.record("//depot/asset#2 - updating /work/asset"));
        }
        out.record(r"Can't clobber writable file C:\Work\asset");
        out.record("Can't clobber writable file c:/work/ASSET");
        out.record("//depot/A#2 - must resolve #3");
        out.record("//depot/a#2 - must resolve #3");
        out.record("//depot/a#3 - must resolve #4");
        assert!(out.record("//depot/a - b#3 - added as /work/a - b"));
        out.record("//depot/a - b#2 - is opened for edit and can't be updated.");
        out.record("Perforce client error:");
        out.record("TCP receive failed.");
        let summary = out.finish(false);
        assert_eq!(summary.updated, 100_000);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.warnings["opened"], 1);
        assert_eq!(summary.warnings["writable"], 1);
        assert_eq!(summary.warnings["resolve"], 2);
        assert_eq!(summary.first_diagnostic, "TCP receive failed.");
        assert_eq!(summary.diagnostics, 1);
        assert!(serde_json::to_vec(&summary).unwrap().len() < 300);
    }
}
