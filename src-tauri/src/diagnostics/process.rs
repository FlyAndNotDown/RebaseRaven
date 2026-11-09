use std::collections::VecDeque;
use std::io::{self, Read};
use std::ops::{Deref, DerefMut};
use std::process::{Child, ChildStdout, Command, ExitStatus, Output};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use super::{
    command::{CommandReport, OUTPUT_BYTES},
    enqueue, Code, CommandOutput, Status,
};
use crate::error::{AppError, AppResult};

#[derive(Default)]
pub(crate) struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}
impl Capture {
    pub(crate) fn append(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len());
        let count = bytes
            .len()
            .min((OUTPUT_BYTES / 2 - 128).saturating_sub(self.head.len()));
        self.head.extend_from_slice(&bytes[..count]);
        let bytes = &bytes[count..];
        let keep = OUTPUT_BYTES / 2 - 128;
        if bytes.len() >= keep {
            self.tail.clear();
            self.tail.extend(&bytes[bytes.len() - keep..]);
        } else {
            let remove = (self.tail.len() + bytes.len()).saturating_sub(keep);
            self.tail.drain(..remove);
            self.tail.extend(bytes);
        }
    }
    pub(crate) fn take(&mut self) -> Vec<u8> {
        let mut bytes = std::mem::take(&mut self.head);
        let omitted = self.total.saturating_sub(bytes.len() + self.tail.len());
        if omitted > 0 {
            bytes.extend_from_slice(format!("\n[{omitted} output bytes omitted]\n").as_bytes());
        }
        bytes.extend(self.tail.drain(..));
        self.total = 0;
        bytes
    }
}

#[derive(Default)]
struct Streams {
    stdout: Capture,
    stderr: Capture,
    completed: Option<(Code, CommandReport, Instant)>,
}
impl Streams {
    fn append(&mut self, bytes: &[u8], stderr: bool) {
        if bytes.is_empty() {
            return;
        }
        if let Some((code, report, started)) = &self.completed {
            let mut report = report.clone();
            report.set_output(CommandOutput {
                status: None,
                stdout: if stderr { &[] } else { bytes },
                stderr: if stderr { bytes } else { &[] },
            });
            enqueue(*code, Status::Output, Some(started.elapsed()), || {
                (None, Some(report))
            });
        } else if stderr {
            self.stderr.append(bytes);
        } else {
            self.stdout.append(bytes);
        }
    }
}

pub(crate) struct CommandTrace {
    code: Code,
    report: CommandReport,
    started: Instant,
    streams: Arc<Mutex<Streams>>,
    finished: bool,
}
impl CommandTrace {
    pub(crate) fn new(code: Code, command: &Command) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let trace = Self {
            code,
            report: CommandReport::for_command(code.category(), command, id),
            started: Instant::now(),
            streams: Arc::default(),
            finished: false,
        };
        let report = trace.report.clone();
        enqueue(code, Status::Started, None, || (None, Some(report)));
        trace
    }
    pub(crate) fn failed(&mut self, error: AppError) -> AppError {
        self.finish(Status::Failure, CommandOutput::default(), Some(&error));
        error
    }
    pub(crate) fn output(&mut self, result: &AppResult<Output>) {
        match result {
            Ok(output) => self.finish(
                if output.status.success() {
                    Status::Success
                } else {
                    Status::Failure
                },
                output.into(),
                None,
            ),
            Err(error) => self.finish(Status::of(result), CommandOutput::default(), Some(error)),
        }
    }
    pub(crate) fn checkpoint(&mut self) {
        let has_output = {
            let streams = self.streams.lock().unwrap_or_else(|err| err.into_inner());
            streams.stdout.total > 0 || streams.stderr.total > 0
        };
        if has_output {
            self.emit(Status::Running, CommandOutput::default(), None);
        }
    }
    fn emit(&mut self, status: Status, output: CommandOutput<'_>, error: Option<&AppError>) {
        let (stdout, stderr) = {
            let mut streams = self.streams.lock().unwrap_or_else(|err| err.into_inner());
            streams.stdout.append(output.stdout);
            streams.stderr.append(output.stderr);
            let output = (streams.stdout.take(), streams.stderr.take());
            if status != Status::Running {
                streams.completed = Some((self.code, self.report.clone(), self.started));
            }
            output
        };
        let mut report = self.report.clone();
        report.set_output(CommandOutput {
            status: output.status,
            stdout: &stdout,
            stderr: &stderr,
        });
        enqueue(self.code, status, Some(self.started.elapsed()), || {
            (error.and_then(super::error_excerpt), Some(report))
        });
    }
    pub(crate) fn finish(
        &mut self,
        status: Status,
        output: CommandOutput<'_>,
        error: Option<&AppError>,
    ) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.emit(status, output, error);
    }
    pub(crate) fn spawn(mut command: Command, code: Code) -> AppResult<LoggedChild> {
        let mut trace = Self::new(code, &command);
        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().map(|reader| LoggedReader {
                    reader,
                    streams: Arc::clone(&trace.streams),
                });
                let stderr = child.stderr.take();
                let streams = Arc::clone(&trace.streams);
                std::thread::spawn(move || {
                    if let Some(mut pipe) = stderr {
                        let mut bytes = [0; 8192];
                        loop {
                            match pipe.read(&mut bytes) {
                                Ok(0) | Err(_) => break,
                                Ok(count) => streams
                                    .lock()
                                    .unwrap_or_else(|err| err.into_inner())
                                    .append(&bytes[..count], true),
                            }
                        }
                    }
                });
                Ok(LoggedChild {
                    child,
                    stdout,
                    trace,
                })
            }
            Err(error) => {
                let error = AppError::from(error);
                trace.finish(Status::Failure, CommandOutput::default(), Some(&error));
                Err(error)
            }
        }
    }
}
impl Drop for CommandTrace {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Status::Cancelled, CommandOutput::default(), None);
        }
    }
}

pub(crate) struct LoggedReader<R> {
    reader: R,
    streams: Arc<Mutex<Streams>>,
}
impl<R: Read> Read for LoggedReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.reader.read(bytes)?;
        self.streams
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .append(&bytes[..count], false);
        Ok(count)
    }
}
pub(crate) struct LoggedChild {
    child: Child,
    pub(crate) stdout: Option<LoggedReader<ChildStdout>>,
    trace: CommandTrace,
}
impl LoggedChild {
    pub(crate) fn checkpoint(&mut self) {
        self.trace.checkpoint();
    }
    fn completed(&mut self, status: ExitStatus) {
        self.trace.finish(
            if status.success() {
                Status::Success
            } else {
                Status::Failure
            },
            CommandOutput {
                status: Some(status),
                ..Default::default()
            },
            None,
        );
    }
    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.completed(status);
        Ok(status)
    }
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if let Some(status) = status {
            self.completed(status);
        }
        Ok(status)
    }
}
impl Deref for LoggedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl DerefMut for LoggedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for LoggedChild {
    fn drop(&mut self) {
        if self.trace.finished {
            return;
        }
        if let Ok(Some(status)) = self.child.try_wait() {
            self.completed(status);
            return;
        }
        crate::platform::kill_process_tree(self.child.id());
        let _ = self.child.kill();
        let status = self.child.wait().ok();
        self.trace.finish(
            Status::Cancelled,
            CommandOutput {
                status,
                ..Default::default()
            },
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logging_does_not_change_streamed_bytes_or_record_delimiters() {
        let bytes = b"commit\0author\x1fbody\n";
        let streams = Arc::new(Mutex::new(Streams::default()));
        let mut reader = LoggedReader {
            reader: std::io::Cursor::new(bytes),
            streams: Arc::clone(&streams),
        };
        let mut actual = Vec::new();
        reader.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, bytes);
        assert_eq!(streams.lock().unwrap().stdout.take(), bytes);
    }
    #[test]
    fn captures_small_output_and_bounds_large_streams_without_losing_the_end() {
        let mut capture = Capture::default();
        capture.append(b"first\n");
        capture.append(b"last\n");
        assert_eq!(capture.take(), b"first\nlast\n");
        capture.append(&vec![b'x'; OUTPUT_BYTES * 3]);
        capture.append(b"final error\n");
        let bytes = capture.take();
        assert!(bytes.len() < OUTPUT_BYTES + 100);
        assert!(bytes.ends_with(b"final error\n"));
        assert!(String::from_utf8_lossy(&bytes).contains("output bytes omitted"));
    }
}
