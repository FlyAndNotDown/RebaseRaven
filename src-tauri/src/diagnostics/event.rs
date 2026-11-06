use std::fmt::{self, Write};

use chrono::{DateTime, SecondsFormat};
use serde::{de::value::StrDeserializer, Deserialize};

use crate::error::{
    AppError, AppResult, GIT_BACKGROUND_TIMEOUT, GIT_MISSING, P4_LOGIN, P4_MISSING,
    P4_PROBE_TIMEOUT, P4_RESOLVE_CONFLICTS,
};

use super::{MAX_DURATION_MS, MAX_TIMESTAMP_MS};

/// Only fixed diagnostic categories cross this boundary. Never add user input.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
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
    CredentialRequest,
    DiagnosticsExport,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Status {
    Success,
    Failure,
    Cancelled,
}

impl Status {
    pub(super) fn of<T>(result: &AppResult<T>) -> Self {
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
pub(super) enum Failure {
    MergeConflict,
    TimedOut,
    LoginRequired,
    ExecutableMissing,
    PermissionDenied,
    ExitCode(i32),
}

impl Failure {
    pub(super) fn of(error: &AppError) -> Option<Self> {
        match error {
            AppError::Message(message) => match message.as_str() {
                P4_RESOLVE_CONFLICTS => Some(Self::MergeConflict),
                GIT_BACKGROUND_TIMEOUT | P4_PROBE_TIMEOUT => Some(Self::TimedOut),
                P4_LOGIN => Some(Self::LoginRequired),
                GIT_MISSING | P4_MISSING => Some(Self::ExecutableMissing),
                _ => None,
            },
            AppError::Io(error) => match error.kind() {
                std::io::ErrorKind::TimedOut => Some(Self::TimedOut),
                std::io::ErrorKind::PermissionDenied => Some(Self::PermissionDenied),
                _ => None,
            },
        }
    }

    const KNOWN: [Self; 5] = [
        Self::MergeConflict,
        Self::TimedOut,
        Self::LoginRequired,
        Self::ExecutableMissing,
        Self::PermissionDenied,
    ];

    fn message(self) -> &'static str {
        match self {
            Self::MergeConflict => "Automatic merge left conflicts",
            Self::TimedOut => "Operation timed out",
            Self::LoginRequired => "Perforce login required",
            Self::ExecutableMissing => "Executable unavailable",
            Self::PermissionDenied => "Permission denied",
            Self::ExitCode(_) => "Exit code",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        if let Some(code) = text.strip_prefix("Exit code ") {
            return Some(Self::ExitCode(code.parse().ok()?));
        }
        Self::KNOWN
            .into_iter()
            .find(|reason| reason.message() == text)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExitCode(code) => write!(f, "Exit code {code}"),
            _ => f.write_str(self.message()),
        }
    }
}

#[derive(Debug)]
pub(super) struct Event {
    pub(super) time_unix_ms: u64,
    pub(super) code: Code,
    pub(super) status: Status,
    pub(super) duration_ms: Option<u64>,
    pub(super) failure: Option<Failure>,
}

impl Event {
    pub(super) fn line(&self) -> String {
        let time = DateTime::from_timestamp_millis(self.time_unix_ms as i64)
            .expect("bounded diagnostic timestamp")
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut line = format!(
            "{time} {:5} {:?} | {}",
            self.status.level().as_str(),
            self.code,
            self.status.message()
        );
        if let Some(duration) = self.duration_ms {
            write!(line, " in {duration} ms").expect("writing to a string");
        }
        if let Some(failure) = self.failure {
            write!(line, " | {failure}").expect("writing to a string");
        }
        line.push('\n');
        line
    }

    pub(super) fn parse(line: &[u8], cutoff: u64) -> Option<Self> {
        if line.len() > 256 {
            return None;
        }
        let (header, content) = std::str::from_utf8(line).ok()?.split_once(" | ")?;
        let mut fields = header.split_ascii_whitespace();
        let timestamp = DateTime::parse_from_rfc3339(fields.next()?).ok()?;
        let time_unix_ms = u64::try_from(timestamp.timestamp_millis()).ok()?;
        if !(cutoff..=MAX_TIMESTAMP_MS).contains(&time_unix_ms) {
            return None;
        }
        let status = match fields.next()? {
            "INFO" => Status::Success,
            "ERROR" => Status::Failure,
            "WARN" => Status::Cancelled,
            _ => return None,
        };
        let code = Code::deserialize(StrDeserializer::<serde::de::value::Error>::new(
            fields.next()?,
        ))
        .ok()?;
        if fields.next().is_some() {
            return None;
        }
        let (message, failure) = match content.split_once(" | ") {
            Some((message, detail)) if status == Status::Failure => {
                (message, Some(Failure::parse(detail)?))
            }
            Some(_) => return None,
            None => (content, None),
        };
        let duration_ms = match message.strip_prefix(status.message())? {
            "" => None,
            suffix => {
                let duration = suffix
                    .strip_prefix(" in ")?
                    .strip_suffix(" ms")?
                    .parse()
                    .ok()?;
                if duration > MAX_DURATION_MS {
                    return None;
                }
                Some(duration)
            }
        };
        Some(Self {
            time_unix_ms,
            code,
            status,
            duration_ms,
            failure,
        })
    }
}
