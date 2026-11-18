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
        if line.is_empty() {
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
            self.skipped
                .entry(kind)
                .or_default()
                .insert(file_key(file.trim()));
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

fn file_key(path: &str) -> String {
    if path.starts_with("//") {
        if let Some((base, rev)) = path.rsplit_once('#') {
            if !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) {
                return base.to_owned();
            }
        }
    } else if path.starts_with(r"\\")
        || (path.as_bytes().get(1) == Some(&b':')
            && path
                .as_bytes()
                .get(2)
                .is_some_and(|b| matches!(b, b'/' | b'\\')))
    {
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
        assert_eq!(summary.diagnostics, 2);
        assert!(serde_json::to_vec(&summary).unwrap().len() < 300);
    }
}
