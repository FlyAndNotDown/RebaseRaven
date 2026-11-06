use std::fmt::Write;

use chrono::{DateTime, Local};

use crate::error::AppResult;

use super::command::CommandReport;
use super::MAX_TIMESTAMP_MS;

const TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S%.3f %:z";
const MAX_LINE_BYTES: usize = 16 * 1024;

/// Internal event identifiers for filtering and rate limits.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Code {
    AppStarted,
    UiReady,
    UpdateCheck,
    UpdateDownload,
    UpdateInstall,
    UpdateRestart,
    GitOperation,
    GitStatus,
    GitDiff,
    GitHistory,
    GitFetch,
    GitBackgroundFetch,
    GitPull,
    GitPush,
    GitClone,
    GitCommit,
    GitStage,
    GitWorkspace,
    GitStash,
    PerforceOperation,
    PerforceInfo,
    PerforceLogin,
    PerforceStatus,
    PerforceHistory,
    PerforceDiff,
    PerforceSync,
    PerforceSyncPreview,
    PerforceResolve,
    PerforceSubmit,
    PerforceChange,
    PerforceShelf,
    PerforceRevert,
    PerforceOpen,
    DiagnosticsExport,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Status {
    Success,
    Failure,
    Cancelled,
}

impl Status {
    pub(crate) fn of<T>(result: &AppResult<T>) -> Self {
        match result {
            Ok(_) => Self::Success,
            Err(error) if error.is_cancelled() => Self::Cancelled,
            Err(_) => Self::Failure,
        }
    }
    pub(super) fn level(self) -> log::Level {
        match self {
            Self::Success => log::Level::Info,
            Self::Failure => log::Level::Error,
            Self::Cancelled => log::Level::Warn,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Success => "Completed",
            Self::Failure => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Category {
    UI,
    Git,
    P4,
    Update,
    Diagnostics,
}

impl Code {
    pub(super) fn category(self) -> Category {
        match self {
            Self::AppStarted | Self::UiReady => Category::UI,
            Self::UpdateCheck
            | Self::UpdateDownload
            | Self::UpdateInstall
            | Self::UpdateRestart => Category::Update,
            Self::GitOperation
            | Self::GitStatus
            | Self::GitDiff
            | Self::GitHistory
            | Self::GitFetch
            | Self::GitBackgroundFetch
            | Self::GitPull
            | Self::GitPush
            | Self::GitClone
            | Self::GitCommit
            | Self::GitStage
            | Self::GitWorkspace
            | Self::GitStash => Category::Git,
            Self::DiagnosticsExport => Category::Diagnostics,
            _ => Category::P4,
        }
    }

    pub(super) fn passive(self) -> bool {
        matches!(
            self,
            Self::GitOperation
                | Self::GitStatus
                | Self::GitDiff
                | Self::GitHistory
                | Self::GitBackgroundFetch
                | Self::PerforceOperation
                | Self::PerforceInfo
                | Self::PerforceStatus
                | Self::PerforceHistory
                | Self::PerforceDiff
        )
    }

    fn label(self) -> &'static str {
        match self {
            Self::AppStarted => "Application started",
            Self::UiReady => "Main window ready",
            Self::UpdateCheck => "Check for updates",
            Self::UpdateDownload => "Download update",
            Self::UpdateInstall => "Install update",
            Self::UpdateRestart => "Restart after update",
            Self::GitOperation => "Repository operation",
            Self::PerforceResolve => "Verify conflict resolution",
            Self::DiagnosticsExport => "Export diagnostics",
            _ => "Repository command",
        }
    }
}

#[derive(Debug)]
pub(super) struct Event {
    pub(super) time_unix_ms: u64,
    pub(super) code: Code,
    pub(super) status: Status,
    pub(super) duration_ms: Option<u64>,
    pub(super) reason: Option<String>,
    pub(super) command: Option<CommandReport>,
}

impl Event {
    pub(super) fn line(&self) -> String {
        let time = DateTime::from_timestamp_millis(self.time_unix_ms as i64)
            .expect("bounded diagnostic timestamp")
            .with_timezone(&Local);
        let mut line = format!(
            "[{}][{}][{:?}] ",
            time.format(TIME_FORMAT),
            self.status.level(),
            self.code.category()
        );
        if matches!(self.code, Code::AppStarted | Code::UiReady) {
            line.push_str(self.code.label());
        } else {
            if let Some(command) = &self.command {
                line.push_str(&command.invocation);
                if self.code == Code::GitBackgroundFetch {
                    line.push_str(" (background)");
                }
            } else {
                line.push_str(self.code.label());
            }
            write!(line, ": {}", self.status.message()).expect("writing to a string");
            if let Some(duration) = self.duration_ms {
                write!(line, " in {duration} ms").expect("writing to a string");
            }
            if let Some(command) = &self.command {
                command.write_exit(&mut line).expect("writing to a string");
            }
            if let Some(reason) = &self.reason {
                write!(line, " error={reason:?}").expect("writing to a string");
            }
            if let Some(command) = &self.command {
                command
                    .write_output(&mut line)
                    .expect("writing to a string");
            }
        }
        line.push('\n');
        line
    }

    // Text is redacted before storage. Check the header and complete line when
    // pruning or exporting without interpreting command output as log headers.
    pub(super) fn is_retained(line: &[u8], cutoff: u64) -> bool {
        if line.len() > MAX_LINE_BYTES {
            return false;
        }
        let Ok(line) = std::str::from_utf8(line) else {
            return false;
        };
        let Some((time, rest)) = line
            .strip_prefix('[')
            .and_then(|line| line.split_once("]["))
        else {
            return false;
        };
        let Some((level, rest)) = rest.split_once("][") else {
            return false;
        };
        let Some((category, message)) = rest.split_once("] ") else {
            return false;
        };
        if !matches!(level, "INFO" | "WARN" | "ERROR")
            || !matches!(category, "UI" | "Git" | "P4" | "Update" | "Diagnostics")
            || message.is_empty()
            || message.chars().any(char::is_control)
        {
            return false;
        }
        DateTime::parse_from_str(time, TIME_FORMAT)
            .ok()
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
            .is_some_and(|time| (cutoff..=MAX_TIMESTAMP_MS).contains(&time))
    }
}
