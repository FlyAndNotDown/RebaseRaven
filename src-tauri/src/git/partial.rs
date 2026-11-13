use super::*;

/// One changed line picked in the diff: an added line by its new number, a
/// removed line by its old number.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRef {
    pub old: Option<u32>,
    pub new: Option<u32>,
}

fn quote_patch_path(path: &str) -> Vec<u8> {
    let mut out = vec![b'"'];
    for byte in path.bytes() {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            _ => out.push(byte),
        }
    }
    out.push(b'"');
    out
}

/// Builds a patch holding only the selected lines of `diff`.
///
/// Applied forwards, an unselected removal stays as context and an unselected
/// addition is left out. A `reverse` patch is meant for `git apply --reverse`,
/// so the roles swap: unselected additions stay as context and unselected
/// removals are left out. Either way the preimage matches the file exactly.
pub(super) fn selected_patch(
    diff: &ParsedDiff,
    rel: &str,
    lines: &[LineRef],
    reverse: bool,
    new_mode: Option<&[u8]>,
) -> AppResult<Vec<u8>> {
    if diff.binary {
        return Err(AppError::msg("Binary files cannot be applied line by line"));
    }
    if diff.hunks.is_empty() {
        return Err(AppError::msg("This file has no changes to apply"));
    }
    let olds: HashSet<u32> = lines.iter().filter_map(|line| line.old).collect();
    let news: HashSet<u32> = lines.iter().filter_map(|line| line.new).collect();

    let a = quote_patch_path(&format!("a/{rel}"));
    let b = quote_patch_path(&format!("b/{rel}"));
    let mut out = Vec::new();
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(&a);
    out.push(b' ');
    out.extend_from_slice(&b);
    if let Some(mode) = new_mode {
        out.extend_from_slice(b"\nnew file mode ");
        out.extend_from_slice(mode);
        out.extend_from_slice(b"\n--- /dev/null");
    } else {
        out.extend_from_slice(b"\n--- ");
        out.extend_from_slice(&a);
    }
    out.extend_from_slice(b"\n+++ ");
    out.extend_from_slice(&b);
    out.push(b'\n');

    let mut offset: i64 = 0;
    let mut emitted = 0;
    for hunk in &diff.hunks {
        let mut body = Vec::new();
        let (mut old_count, mut new_count, mut changes) = (0i64, 0i64, 0);
        for line in &hunk.lines {
            let origin = line.origin as char;
            let selected = match origin {
                '+' => line.new_lineno.is_some_and(|number| news.contains(&number)),
                '-' => line.old_lineno.is_some_and(|number| olds.contains(&number)),
                _ => false,
            };
            let mark = match (origin, selected, reverse) {
                (' ', _, _) => b' ',
                ('+', true, _) => b'+',
                ('-', true, _) => b'-',
                ('-', false, false) | ('+', false, true) => b' ',
                // Unselected lines that are not in the preimage, and the
                // end-of-file markers, which are added back below.
                _ => continue,
            };
            if mark != b' ' {
                changes += 1;
            }
            if mark != b'+' {
                old_count += 1;
            }
            if mark != b'-' {
                new_count += 1;
            }
            body.push(mark);
            let content = line.content.as_slice();
            body.extend_from_slice(content);
            if !content.ends_with(b"\n") {
                body.extend_from_slice(b"\n\\ No newline at end of file\n");
            }
        }
        if changes == 0 {
            continue;
        }
        let (old_start, new_start) = if reverse {
            let new_start = i64::from(hunk.new_start);
            let mut old_start = new_start - offset;
            if new_count == 0 {
                old_start += 1;
            }
            if old_count == 0 {
                old_start -= 1;
            }
            (old_start.max(0), new_start)
        } else {
            let old_start = i64::from(hunk.old_start);
            let mut new_start = old_start + offset;
            if old_count == 0 {
                new_start += 1;
            }
            if new_count == 0 {
                new_start -= 1;
            }
            (old_start, new_start.max(0))
        };
        out.extend_from_slice(
            format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
        );
        out.extend_from_slice(&body);
        offset += new_count - old_count;
        emitted += 1;
    }
    if emitted == 0 {
        return Err(AppError::msg(
            "The selected lines are no longer changes in this file. Refresh and try again.",
        ));
    }
    Ok(out)
}

fn reviewed_patch(
    bytes: &[u8],
    rel: &str,
    staged: bool,
    lines: &[LineRef],
    reverse: bool,
    expected: &str,
    new_file: bool,
) -> AppResult<Vec<u8>> {
    if diff_fingerprint(rel, staged, bytes) != expected {
        return Err(AppError::msg(
            "The file changed since this diff was displayed. Refresh and select the lines again.",
        ));
    }
    let mode = if new_file {
        let mode = bytes
            .split(|byte| *byte == b'\n')
            .take_while(|line| !line.starts_with(b"@@"))
            .find_map(|line| line.strip_prefix(b"new file mode "));
        match mode {
            Some(mode @ (b"100644" | b"100755" | b"120000")) => Some(mode),
            _ => return Err(AppError::msg("This file cannot be staged line by line")),
        }
    } else {
        None
    };
    selected_patch(&parse_unified_diff(bytes, rel), rel, lines, reverse, mode)
}

/// Stages, unstages, or discards only the selected lines of one file.
/// `staged` says which diff the lines came from: HEAD to index, or index to
/// working tree.
pub fn apply_lines(
    repo: &mut Repository,
    path: &str,
    staged: bool,
    action: &str,
    lines: &[LineRef],
    fingerprint: &str,
) -> AppResult<WorkspaceSnapshot> {
    let rel = safe_repo_path(path)?;
    if rel.is_empty() {
        return Err(AppError::msg("A file is required"));
    }
    if lines.is_empty() {
        return Err(AppError::msg("Select at least one changed line"));
    }
    let (reverse, cached) = match (action, staged) {
        ("stage", false) => (false, true),
        ("unstage", true) => (true, true),
        ("discard", false) => (true, false),
        _ => return Err(AppError::msg("That action does not apply to this diff")),
    };
    let root = workdir_owned(repo)?;
    let new_file = action == "stage" && is_untracked(repo, &rel);
    let bytes = if new_file {
        untracked_diff_bytes(repo, &rel, false)?.0
    } else {
        git_diff_bytes(repo, &[], staged, false, &rel)?
    };
    let patch = reviewed_patch(&bytes, &rel, staged, lines, reverse, fingerprint, new_file)?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    run_git_input(&root, &args, &patch)?;
    snapshot(repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_new_executable_from_only_the_reviewed_lines() {
        let bytes = b"new file mode 100755\n@@ -0,0 +1,3 @@\n+unselected\n+chosen\n+later\n";
        let version = diff_fingerprint("script", false, bytes);
        let line = [LineRef {
            old: None,
            new: Some(2),
        }];
        let patch = reviewed_patch(bytes, "script", false, &line, false, &version, true).unwrap();
        assert_eq!(patch, b"diff --git \"a/script\" \"b/script\"\nnew file mode 100755\n--- /dev/null\n+++ \"b/script\"\n@@ -0,0 +1,1 @@\n+chosen\n");
    }

    #[test]
    fn rejects_replaced_content_even_at_the_same_line_number() {
        let original = b"@@ -1 +1 @@\n-before\n+reviewed\n";
        let replaced = b"@@ -1 +1 @@\n-before\n+later edit\n";
        let line = [LineRef {
            old: None,
            new: Some(1),
        }];
        for (staged, reverse) in [(false, false), (true, true), (false, true)] {
            let version = diff_fingerprint("file", staged, original);
            assert!(
                reviewed_patch(original, "file", staged, &line, reverse, &version, false).is_ok()
            );
            assert!(
                reviewed_patch(replaced, "file", staged, &line, reverse, &version, false).is_err()
            );
        }
    }
}
