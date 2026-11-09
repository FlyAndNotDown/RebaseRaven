use super::event::Category;
use regex::Regex;
use std::fmt::{self, Write};
use std::process::{Command, ExitStatus, Output};
use std::sync::OnceLock;

pub(super) const OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Default)]
pub struct CommandOutput<'a> {
    pub status: Option<ExitStatus>,
    pub stdout: &'a [u8],
    pub stderr: &'a [u8],
}
impl<'a> From<&'a Output> for CommandOutput<'a> {
    fn from(output: &'a Output) -> Self {
        Self {
            status: Some(output.status),
            stdout: &output.stdout,
            stderr: &output.stderr,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct CommandReport {
    pub invocation: String,
    pub(super) status: Option<ExitStatus>,
    pub(super) stdout: Option<String>,
    pub(super) stderr: Option<String>,
    credentials: bool,
    pub(super) id: Option<String>,
    pub(super) cwd: Option<String>,
}
impl CommandReport {
    pub(super) fn new(category: Category, args: &[&str], output: CommandOutput<'_>) -> Self {
        let program = match category {
            Category::Git => "git",
            Category::P4 => "p4",
            _ => unreachable!("VCS command category"),
        };
        let credentials = args
            .iter()
            .any(|arg| matches!(*arg, "login" | "passwd" | "tickets" | "credential"));
        let mut report = Self {
            invocation: invocation(program, args),
            status: output.status,
            stdout: None,
            stderr: None,
            credentials,
            id: None,
            cwd: None,
        };
        report.set_output(output);
        report
    }
    pub(super) fn for_command(category: Category, command: &Command, id: String) -> Self {
        let arguments: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        let args: Vec<_> = arguments.iter().map(|arg| arg.as_ref()).collect();
        let mut report = Self::new(category, &args, CommandOutput::default());
        report.invocation = invocation(&command.get_program().to_string_lossy(), &args);
        report.id = Some(id);
        report.cwd = command
            .get_current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|dir| dir.to_string_lossy().into_owned())
            });
        report
    }
    pub(super) fn set_output(&mut self, output: CommandOutput<'_>) {
        self.status = output.status;
        if self.credentials {
            self.stdout = (!output.stdout.is_empty()).then(|| "[credential output omitted]".into());
            self.stderr = (!output.stderr.is_empty()).then(|| "[credential output omitted]".into());
        } else {
            self.stdout = excerpt(output.stdout);
            self.stderr = excerpt(output.stderr);
        }
    }
    pub(super) fn write_context(&self, line: &mut String) -> fmt::Result {
        if let Some(id) = &self.id {
            write!(line, " [command={id}]")?;
        }
        if let Some(cwd) = &self.cwd {
            write!(line, " cwd={:?}", redact(cwd))?;
        }
        Ok(())
    }
    pub(super) fn write_exit(&self, line: &mut String) -> fmt::Result {
        if let Some(status) = self.status {
            if let Some(code) = status.code() {
                write!(line, " (exit {code})")?;
            } else {
                write!(line, " ({status})")?;
            }
        }
        Ok(())
    }
    pub(super) fn write_output(&self, time: &str, log: &mut String) -> fmt::Result {
        for (stream, output) in [("stderr", &self.stderr), ("stdout", &self.stdout)] {
            if let Some(output) = output {
                let stream = self.id.as_ref().map_or_else(
                    || stream.to_owned(),
                    |id| format!("{stream} [command={id}]"),
                );
                write_output_lines(log, time, &stream, output)?;
            }
        }
        Ok(())
    }
}
fn invocation(program: &str, args: &[&str]) -> String {
    let mut out = format!("{program:?}");
    let mut secret = false;
    for arg in args {
        let value = if secret {
            "[redacted]".to_owned()
        } else {
            redact(arg)
        };
        write!(out, " {value:?}").expect("writing to a string");
        secret = matches!(*arg, "-P" | "--password" | "--token" | "--access-token");
        if out.len() > 8 * 1024 {
            out.truncate(out.floor_char_boundary(8 * 1024));
            out.push_str(" [remaining arguments exceed log limit]");
            break;
        }
    }
    out
}
pub(super) fn write_output_lines(
    log: &mut String,
    time: &str,
    stream: &str,
    output: &str,
) -> fmt::Result {
    const MAX_LINES: usize = 4000;
    let count = output.lines().count();
    for (index, line) in output.lines().enumerate() {
        if count > MAX_LINES && index == MAX_LINES / 2 {
            writeln!(
                log,
                "[{time}][VERBOSE][Commands] {stream}: [{} output lines omitted]",
                count - MAX_LINES
            )?;
        }
        if count > MAX_LINES && index >= MAX_LINES / 2 && index < count - MAX_LINES / 2 {
            continue;
        }
        let mut rest = line;
        loop {
            let stop = rest
                .char_indices()
                .nth(2000)
                .map_or(rest.len(), |(index, _)| index);
            writeln!(
                log,
                "[{time}][VERBOSE][Commands] {stream}: {}",
                &rest[..stop]
            )?;
            if stop == rest.len() {
                break;
            }
            rest = &rest[stop..];
        }
    }
    Ok(())
}
pub(super) fn excerpt(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    if bytes.contains(&0) && std::str::from_utf8(bytes).is_err() {
        return Some(format!(
            "[binary output: {} bytes; prefix {:02x?}]",
            bytes.len(),
            &bytes[..bytes.len().min(32)]
        ));
    }
    let text = if bytes.len() > OUTPUT_BYTES {
        let half = OUTPUT_BYTES / 2;
        format!(
            "{}\n[{} output bytes omitted]\n{}",
            String::from_utf8_lossy(&bytes[..half]),
            bytes.len() - OUTPUT_BYTES,
            String::from_utf8_lossy(&bytes[bytes.len() - half..])
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    Some(redact(
        &text
            .replace('\0', "\\0")
            .replace("\r\n", "\n")
            .replace('\r', "\n"),
    ))
}

pub(super) fn redact(value: &str) -> String {
    static ESCAPE: OnceLock<Regex> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();

    if value.contains("PRIVATE KEY-----") {
        return "[private key output omitted]".to_owned();
    }
    let escape = ESCAPE.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("valid terminal escape pattern")
    });
    let mut cleaned = String::with_capacity(value.len());
    for character in escape.replace_all(value, "").chars() {
        if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
            write!(cleaned, "\\x{:02x}", character as u32).expect("writing to a string");
        } else {
            cleaned.push(character);
        }
    }
    let cleaned = crate::error::redact_credentials(&cleaned);
    let auth = AUTH.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:proxy-)?authorization["']?\s*[:=]\s*|bearer[ \t]+)[^\r\n]+"#)
            .expect("valid authorization pattern")
    });
    let cleaned = auth.replace_all(&cleaned, "${1}[redacted]");
    let assignment = ASSIGNMENT.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:p4passwd|password|passwd|passphrase|(?:access[_-]?|private[_-]?)?token|api[_-]?key|secret|cookie)\b["']?\s*[:=]\s*)[^\r\n]+"#)
            .expect("valid secret assignment pattern")
    });
    let cleaned = assignment.replace_all(&cleaned, "${1}[redacted]");
    let token = TOKEN.get_or_init(|| {
        Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b")
            .expect("valid token pattern")
    });
    token.replace_all(&cleaned, "[redacted]").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_paths_arguments_and_text_output_without_hiding_normal_project_details() {
        let report = CommandReport::new(
            Category::Git,
            &["diff", "--", "src/main.rs"],
            CommandOutput {
                stdout: b"+ println!(\"hello\");\n",
                stderr: b"warning: example\n",
                status: None,
            },
        );
        assert!(report.invocation.contains("src/main.rs"));
        assert!(report.stdout.as_deref().unwrap().contains("println!"));
        let mut command = Command::new("git");
        command
            .current_dir("/work/project")
            .args(["remote", "get-url", "origin"]);
        let report = CommandReport::for_command(Category::Git, &command, "1-2".into());
        assert_eq!(report.cwd.as_deref(), Some("/work/project"));
        assert!(report.invocation.contains("get-url"));
        assert_eq!(
            redact("https://example.test/repo?ref=main"),
            "https://example.test/repo?ref=main"
        );
        assert_eq!(redact(&"a".repeat(64)), "a".repeat(64));
        assert_eq!(
            redact("commit\u{1f}author\u{1e}body"),
            r"commit\x1fauthor\x1ebody"
        );
    }
    #[test]
    fn only_credentials_are_masked_in_commands_and_output() {
        let report = CommandReport::new(
            Category::P4,
            &[
                "-p",
                "ssl:example.test:1666",
                "-P",
                "sample-password",
                "info",
            ],
            CommandOutput::default(),
        );
        assert!(report.invocation.contains("ssl:example.test:1666"));
        assert!(!report.invocation.contains("sample-password"));
        let text=redact("https://user:sample-password@example.test/repo?token=sample-token\nAuthorization: Bearer sample-header\nP4PASSWD=sample-secret");
        for secret in [
            "sample-password",
            "sample-token",
            "sample-header",
            "sample-secret",
        ] {
            assert!(!text.contains(secret));
        }
        let report = CommandReport::new(
            Category::P4,
            &["login", "-p"],
            CommandOutput {
                stdout: b"sample-ticket",
                ..Default::default()
            },
        );
        assert!(!report.stdout.unwrap().contains("sample-ticket"));
    }
    #[test]
    fn long_lines_and_oversized_output_remain_explicit_and_exportable() {
        let text = excerpt(&vec![b'x'; OUTPUT_BYTES * 2]).unwrap();
        assert!(text.contains("output bytes omitted"));
        let mut lines = String::new();
        write_output_lines(
            &mut lines,
            "2026-01-01 00:00:00.000 +00:00",
            "stdout",
            &"x".repeat(50_000),
        )
        .unwrap();
        assert!(lines.lines().all(|line| line.len() < 16 * 1024));
        let output = "x\n".repeat(OUTPUT_BYTES / 2) + "final error\n";
        let mut lines = String::new();
        write_output_lines(
            &mut lines,
            "2026-01-01 00:00:00.000 +00:00",
            "stdout",
            &output,
        )
        .unwrap();
        assert!(lines.len() < 1024 * 1024);
        assert!(lines.contains("output lines omitted"));
        assert!(lines.ends_with("final error\n"));
    }
}
