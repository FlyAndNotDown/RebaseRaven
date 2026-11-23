use super::*;
use std::io::Read;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum P4OpenedDiff {
    File(FileDiff),
    Unavailable { unavailable: ReadIssue },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadIssue {
    Missing,
    PermissionDenied,
    Unreadable,
}

pub fn opened_diff(connection: &P4Connection, path: &str) -> AppResult<P4OpenedDiff> {
    let env = env_for(connection);
    let spec = workspace_file_spec(&connection.root, path);
    let meta = run_ok(
        &env,
        &[
            "-ztag",
            "fstat",
            "-Op",
            "-T",
            "action,path,depotFile,type",
            &spec,
        ],
        None,
    )?;
    let record = parse_ztag(&meta).into_iter().next().unwrap_or_default();
    let action = field(&record, "action");
    if action == "add" || action == "move/add" {
        return added_file_preview(Path::new(&connection.root), path, &record);
    }
    if action == "delete" || action == "move/delete" {
        let have = format!("{}#have", field(&record, "depotFile"));
        return printed_file_diff(
            &env,
            path,
            &have,
            file_type_is_binary(&field(&record, "type")),
            true,
        )
        .map(P4OpenedDiff::File);
    }
    let text = cli::run_p4_diff(&env, &["diff", "-du", &spec])?;
    let mut diff = parse_single_diff(&text, path);
    diff.binary |= file_type_is_binary(&field(&record, "type"));
    Ok(P4OpenedDiff::File(diff))
}

fn added_file_preview(root: &Path, path: &str, record: &ZtagRecord) -> AppResult<P4OpenedDiff> {
    let local = PathBuf::from(field(record, "path"));
    if !local.is_absolute() {
        return Err(AppError::msg("Choose a local workspace file."));
    }
    match added_file_diff(root, &local, path, &field(record, "type")) {
        Ok(diff) => Ok(P4OpenedDiff::File(diff)),
        Err(AppError::Io(error)) => Ok(P4OpenedDiff::Unavailable {
            unavailable: match error.kind() {
                std::io::ErrorKind::NotFound => ReadIssue::Missing,
                std::io::ErrorKind::PermissionDenied => ReadIssue::PermissionDenied,
                _ => ReadIssue::Unreadable,
            },
        }),
        Err(error) => Err(error),
    }
}

fn added_file_diff(root: &Path, local: &Path, path: &str, file_type: &str) -> AppResult<FileDiff> {
    let root = fs::canonicalize(root)?;
    let parent = local
        .parent()
        .ok_or_else(|| AppError::msg("Choose a file."))?;
    if !path_is_within(&root, &fs::canonicalize(parent)?) {
        return Err(AppError::msg("Path is outside the workspace."));
    }
    if file_type.split('+').next() == Some("symlink") && fs::symlink_metadata(local)?.is_symlink() {
        let target = fs::read_link(local)?;
        return Ok(content_file_diff(
            path,
            target.to_string_lossy().as_bytes(),
            false,
            false,
            false,
        ));
    }
    let local = fs::canonicalize(local)?;
    if !path_is_within(&root, &local) {
        return Err(AppError::msg("Path is outside the workspace."));
    }
    if !fs::metadata(&local)?.is_file() {
        return Err(AppError::msg("Choose a regular workspace file."));
    }
    let mut bytes = Vec::new();
    fs::File::open(local)?
        .take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    bytes.truncate(MAX_PREVIEW_BYTES);
    Ok(content_file_diff(
        path,
        &bytes,
        truncated,
        file_type_is_binary(file_type),
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn added_file_uses_the_host_path_and_recovers_when_the_file_returns() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("mapped directory");
        let local = parent.join("caf\u{e9} #%23.txt");
        let depot = "//depot/main/new-file.txt";
        let record = ZtagRecord::from([
            (
                "clientFile".into(),
                "//sample-client/mapped directory/caf\u{e9} %23%2523.txt".into(),
            ),
            ("path".into(), local.to_str().unwrap().into()),
            ("type".into(), "text".into()),
        ]);
        let preview = || added_file_preview(root.path(), depot, &record).unwrap();
        for _ in 0..2 {
            assert_eq!(
                serde_json::to_value(preview()).unwrap(),
                serde_json::json!({"unavailable": "missing"})
            );
            fs::create_dir_all(&parent).unwrap();
            fs::write(&local, "first line\nsecond line\n").unwrap();
            let P4OpenedDiff::File(diff) = preview() else {
                panic!("expected added content")
            };
            assert_eq!(diff.path, depot);
            assert_eq!(diff.lines[1].kind, "add");
            assert_eq!(diff.lines[2].content, "second line");
            fs::remove_file(&local).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_add_shows_the_link_text_without_reading_outside_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let target = other.path().join("target");
        fs::write(&target, "outside").unwrap();
        let local = root.path().join("link");
        std::os::unix::fs::symlink(&target, &local).unwrap();
        let depot = "//depot/main/link";
        assert!(added_file_diff(root.path(), &local, depot, "text").is_err());
        let diff = added_file_diff(root.path(), &local, depot, "symlink").unwrap();
        assert_eq!(diff.lines[1].content, target.to_str().unwrap());
    }
}
